import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  INVITE_EXPIRY_MS,
  type AcceptInviteResponse,
  type CreateInviteInput,
  type Invite,
  type InviteErrorReason,
  type InviteListResponse,
  type InvitePreview,
  type InviteStatus,
} from '@shared/schemas/teams';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { AppError, errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { generateInviteCode, inviteCodeHint } from '../lib/security';
import { getMembership, hasPermission, isOwnContent, requirePermission } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { memberCounts, requireTeam } from './teams';
import { addAgentMembership, selfIdsOf } from './agents';
import { getUserSummaries } from './users';

/**
 * Invite links (SPEC §1.3): `/join/<code>` with an optional expiry and use limit. Creating needs
 * `CREATE_INVITES` (revoke your own); `MANAGE_INVITES` sees and revokes everyone's. Any signed-in
 * user holding a valid code can preview the team and join it.
 */

export type InviteRow = typeof s.invite.$inferSelect;

/**
 * Can the invite's creator still invite people into its team? An invite acts with its creator's
 * authority: it stops working when they are no longer a member (removed, left, account deleted)
 * or no longer have `CREATE_INVITES`.
 */
export function inviterCanInvite(db: DbExecutor, row: Pick<InviteRow, 'teamId' | 'createdById'>) {
  if (!row.createdById) return false;
  const inviter = getMembership(db, row.teamId, row.createdById);
  return inviter !== null && hasPermission(inviter, 'CREATE_INVITES');
}

/** `inactive` when the creator can no longer invite (`inviterCanInvite`, passed in). */
export function inviteStatus(
  row: InviteRow,
  now: Date = new Date(),
  inviterActive = true,
): InviteStatus {
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.maxUses !== null && row.uses >= row.maxUses) return 'used_up';
  if (!inviterActive) return 'inactive';
  return 'active';
}

/** Relative join URL of an invite code. */
export function invitePath(code: string): string {
  return `/join/${code}`;
}

function toInvites(db: DbExecutor, rows: readonly InviteRow[], now: Date): Invite[] {
  const creators = getUserSummaries(
    db,
    rows.map((row) => row.createdById),
  );
  const inviters = new Map<string, boolean>();
  const inviterActive = (row: InviteRow) => {
    const key = row.createdById ?? '';
    let active = inviters.get(key);
    if (active === undefined) {
      active = inviterCanInvite(db, row);
      inviters.set(key, active);
    }
    return active;
  };
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    code: row.code,
    url: invitePath(row.code),
    createdBy: row.createdById ? (creators.get(row.createdById) ?? null) : null,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    status: inviteStatus(row, now, inviterActive(row)),
  }));
}

const INVITE_ERRORS: Readonly<Record<InviteErrorReason, string>> = {
  invalid: 'This invite link is invalid, or its team no longer exists',
  expired: 'This invite link has expired',
  revoked: 'This invite link was revoked',
  used_up: 'This invite link has reached its maximum number of uses',
};

/** 404 with `details.reason`, so the join page can explain what is wrong with the link. */
function inviteError(reason: InviteErrorReason): AppError {
  return new AppError('not_found', 404, INVITE_ERRORS[reason], { reason });
}

/**
 * Why the invite can't be used right now, or null when it can. An invite whose creator can no
 * longer invite (`inviterCanInvite`) counts as revoked.
 */
function unusableReason(db: DbExecutor, row: InviteRow, now: Date): InviteErrorReason | null {
  if (row.revokedAt) return 'revoked';
  const status = inviteStatus(row, now, inviterCanInvite(db, row));
  if (status === 'inactive') return 'revoked';
  return status === 'active' ? null : status;
}

/** The invite with this code and its live team, or `invalid`. */
function findByCode(db: DbExecutor, code: string) {
  const row = db
    .select({ invite: s.invite, team: s.team })
    .from(s.invite)
    .innerJoin(s.team, eq(s.team.id, s.invite.teamId))
    .where(and(eq(s.invite.code, code), isNull(s.team.deletedAt)))
    .get();
  if (!row) throw inviteError('invalid');
  return row;
}

// ---------------------------------------------------------------------------------------------
// Team-side management
// ---------------------------------------------------------------------------------------------

/** Invites of the team that aren't revoked, newest first: your own, or all with `MANAGE_INVITES`. */
export function listInvites(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  now: Date = new Date(),
): InviteListResponse {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const seeAll = hasPermission(membership, 'MANAGE_INVITES');
  const rows = orm
    .select()
    .from(s.invite)
    .where(
      and(
        eq(s.invite.teamId, teamId),
        isNull(s.invite.revokedAt),
        // Your own: yours and your agent member's (or, for an agent, its owner's).
        seeAll ? undefined : inArray(s.invite.createdById, selfIdsOf(orm, actor)),
      ),
    )
    .orderBy(desc(s.invite.createdAt), desc(s.invite.id))
    .all();
  return { items: toInvites(orm, rows, now) };
}

/** Creates an invite link (`CREATE_INVITES`). */
export function createInvite(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: CreateInviteInput,
): Invite {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  requirePermission(membership, 'CREATE_INVITES', "You don't have permission to create invites");
  const now = new Date();
  const expiresAt =
    input.expiresIn === 'never'
      ? null
      : new Date(now.getTime() + INVITE_EXPIRY_MS[input.expiresIn]);

  const row = deps.db.write((tx) => {
    // 62^10 codes: a collision is astronomically unlikely, but never reuse one.
    let code = generateInviteCode();
    while (tx.select({ id: s.invite.id }).from(s.invite).where(eq(s.invite.code, code)).get()) {
      code = generateInviteCode();
    }
    const invite = tx
      .insert(s.invite)
      .values({
        id: newId(),
        teamId,
        code,
        createdById: actor.userId,
        maxUses: input.maxUses,
        uses: 0,
        expiresAt,
        createdAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'invite',
      entityId: invite.id,
      action: 'invite.created',
      meta: {
        code: inviteCodeHint(invite.code),
        maxUses: invite.maxUses,
        expiresAt: invite.expiresAt?.toISOString() ?? null,
      },
    });
    emitAfterCommit(tx, {
      type: 'invite.changed',
      teamId,
      entityType: 'invite',
      entityId: invite.id,
      actorId: actor.userId,
    });
    return invite;
  });
  const [invite] = toInvites(orm, [row], now);
  if (!invite) throw errors.internal();
  return invite;
}

/** An invite of the team by id or code (revoked ones excluded). */
export function findTeamInvite(db: DbExecutor, teamId: string, ref: string): InviteRow {
  const value = ref.trim();
  const row = db
    .select()
    .from(s.invite)
    .where(
      and(
        eq(s.invite.teamId, teamId),
        isNull(s.invite.revokedAt),
        or(eq(s.invite.id, value), eq(s.invite.code, value)),
      ),
    )
    .get();
  if (!row) throw errors.notFound('Invite');
  return row;
}

/** Revokes an invite: your own with `CREATE_INVITES`, anyone's with `MANAGE_INVITES`. */
export function revokeInvite(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  inviteRef: string,
): { ok: true } {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const invite = findTeamInvite(orm, teamId, inviteRef);
  const own = isOwnContent(membership, invite.createdById);
  if (!hasPermission(membership, 'MANAGE_INVITES')) {
    // Others' invites are invisible without MANAGE_INVITES.
    if (!own) throw errors.notFound('Invite');
    requirePermission(membership, 'CREATE_INVITES', "You don't have permission to manage invites");
  }
  deps.db.write((tx) => {
    tx.update(s.invite).set({ revokedAt: new Date() }).where(eq(s.invite.id, invite.id)).run();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'invite',
      entityId: invite.id,
      action: 'invite.revoked',
      meta: {
        code: inviteCodeHint(invite.code),
        uses: invite.uses,
        createdById: invite.createdById,
      },
    });
    emitAfterCommit(tx, {
      type: 'invite.changed',
      teamId,
      entityType: 'invite',
      entityId: invite.id,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/**
 * Revokes the invites `userId` created in the team that aren't revoked yet, inside the caller's
 * write, when they stop being a member (removed, left, account deleted), so their links can't be
 * used to walk back in. The caller audits the count in its own row. Returns how many were revoked.
 */
export function revokeInvitesOf(
  tx: Tx,
  actor: Actor,
  teamId: string,
  userId: string,
  now: Date = new Date(),
): number {
  const revoked = tx
    .update(s.invite)
    .set({ revokedAt: now })
    .where(
      and(
        eq(s.invite.teamId, teamId),
        eq(s.invite.createdById, userId),
        isNull(s.invite.revokedAt),
      ),
    )
    .returning({ id: s.invite.id })
    .all();
  const [first] = revoked;
  if (first) {
    emitAfterCommit(tx, {
      type: 'invite.changed',
      teamId,
      entityType: 'invite',
      entityId: first.id,
      actorId: actor.userId,
    });
  }
  return revoked.length;
}

// ---------------------------------------------------------------------------------------------
// Joining (/join/:code)
// ---------------------------------------------------------------------------------------------

/**
 * What the join page shows: the team and who invited you. Members see the preview even when the
 * link no longer works (they can just open the team); everyone else gets a 404 whose
 * `details.reason` says why (`invalid`, `expired`, `revoked`, `used_up`).
 */
export function previewInvite(
  deps: AppDeps,
  actor: Actor,
  code: string,
  now: Date = new Date(),
): InvitePreview {
  const { orm } = deps.db;
  const { invite, team } = findByCode(orm, code);
  const alreadyMember = getMembership(orm, team.id, actor.ownerId ?? actor.userId) !== null;
  if (!alreadyMember) {
    const reason = unusableReason(orm, invite, now);
    if (reason) throw inviteError(reason);
  }
  const inviter = invite.createdById
    ? (getUserSummaries(orm, [invite.createdById]).get(invite.createdById) ?? null)
    : null;
  return {
    code: invite.code,
    team: {
      id: team.id,
      slug: team.slug,
      name: team.name,
      description: team.description,
      icon: team.icon,
      color: team.color,
      memberCount: memberCounts(orm, [team.id]).get(team.id) ?? 0,
    },
    inviter,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    alreadyMember,
  };
}

/**
 * Joins the team with an invite code. The use is counted atomically (a link with one use left
 * admits exactly one person); accepting as an existing member changes nothing. Membership is the
 * person's (agents A): through an API key the key's owner joins; their agent member always joins
 * with them.
 */
export function acceptInvite(deps: AppDeps, actor: Actor, code: string): AcceptInviteResponse {
  const { orm } = deps.db;
  const { team } = findByCode(orm, code);
  const summary = { id: team.id, slug: team.slug, name: team.name };
  const personId = actor.ownerId ?? actor.userId;

  const joined = deps.db.write((tx) => {
    if (getMembership(tx, team.id, personId)) return false;
    const now = new Date();
    const used = tx
      .update(s.invite)
      .set({ uses: sql`${s.invite.uses} + 1` })
      .where(
        and(
          eq(s.invite.code, code),
          isNull(s.invite.revokedAt),
          or(isNull(s.invite.expiresAt), gt(s.invite.expiresAt, now)),
          or(isNull(s.invite.maxUses), lt(s.invite.uses, s.invite.maxUses)),
        ),
      )
      .returning()
      .get();
    if (!used) {
      const current = tx.select().from(s.invite).where(eq(s.invite.code, code)).get();
      throw inviteError((current && unusableReason(tx, current, now)) ?? 'invalid');
    }
    // Checked under the write lock, before the use is committed (the update rolls back).
    if (!inviterCanInvite(tx, used)) throw inviteError('revoked');
    tx.insert(s.teamMember).values({ teamId: team.id, userId: personId, joinedAt: now }).run();
    const agentId = addAgentMembership(tx, team.id, personId, now);
    const users = getUserSummaries(tx, [personId, used.createdById, agentId]);
    recordActivity(tx, actor, {
      teamId: team.id,
      entityType: 'member',
      entityId: personId,
      action: 'member.joined',
      meta: {
        username: users.get(personId)?.username ?? null,
        name: users.get(personId)?.name ?? null,
        ...(agentId ? { agent: users.get(agentId)?.username ?? null } : {}),
        inviteId: used.id,
        inviteCode: inviteCodeHint(used.code),
        invitedBy: used.createdById ? (users.get(used.createdById)?.username ?? null) : null,
      },
    });
    emitAfterCommit(tx, {
      type: 'member.joined',
      teamId: team.id,
      entityType: 'member',
      entityId: personId,
      actorId: actor.userId,
    });
    emitAfterCommit(tx, {
      type: 'invite.changed',
      teamId: team.id,
      entityType: 'invite',
      entityId: used.id,
      actorId: actor.userId,
    });
    return true;
  });
  return { team: summary, alreadyMember: !joined };
}
