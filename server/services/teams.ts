import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { DEFAULT_TEAM_COLOR, LIMITS, TRASH_RETENTION_DAYS } from '@shared/constants';
import { ADMIN_ROLE_SEED, TEAM_ROLE_SEEDS } from '@shared/permissions';
import {
  teamSlugFromName,
  type CreateTeamInput,
  type DeletedTeamsResponse,
  type Team,
  type TeamDetail,
  type TeamListResponse,
  type TeamOverview,
  type TeamProjectCard,
  type TransferOwnershipInput,
  type UpdateTeamInput,
} from '@shared/schemas/teams';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, diffFields, hasChanges } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { likePrefix } from '../lib/sql';
import { appPaths } from '../lib/urls';
import {
  getMembership,
  listMemberships,
  requireMember,
  requireOwner,
  requirePermission,
  visibleProjectIds,
} from './access';
import { recordActivity } from './activity';
import { addAgentMembership, agentOwnerOf } from './agents';
import { emitAfterCommit } from './events';
import { requireSignoff } from './signoff';
import { getUserSummaries } from './users';

/**
 * Teams (SPEC §1.3): create (seeding `@everyone` and Admin), read, update, soft delete and
 * restore (owner only), and ownership transfer. Members, roles and invites live in their own
 * services (members.ts, roles.ts, invites.ts).
 */

export type TeamRow = typeof s.team.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

export function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    ownerId: row.ownerId,
    agentsPausedAt: row.agentsPausedAt?.toISOString() ?? null,
    agentSignoff: row.agentSignoff,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Number of members of each team, keyed by team id. */
export function memberCounts(db: DbExecutor, teamIds: readonly string[]): Map<string, number> {
  if (teamIds.length === 0) return new Map();
  const rows = db
    .select({ teamId: s.teamMember.teamId, value: count() })
    .from(s.teamMember)
    .where(inArray(s.teamMember.teamId, [...teamIds]))
    .groupBy(s.teamMember.teamId)
    .all();
  return new Map(rows.map((row) => [row.teamId, row.value]));
}

export function toTeamDetails(db: DbExecutor, rows: readonly TeamRow[]): TeamDetail[] {
  const owners = getUserSummaries(
    db,
    rows.map((row) => row.ownerId),
  );
  const counts = memberCounts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...toTeam(row),
    owner: owners.get(row.ownerId) ?? null,
    memberCount: counts.get(row.id) ?? 0,
  }));
}

function toTeamDetail(db: DbExecutor, row: TeamRow): TeamDetail {
  const [detail] = toTeamDetails(db, [row]);
  if (!detail) throw errors.internal();
  return detail;
}

/** A live (not deleted) team by id. */
export function findLiveTeam(db: DbExecutor, teamId: string): TeamRow | undefined {
  return db
    .select()
    .from(s.team)
    .where(and(eq(s.team.id, teamId), isNull(s.team.deletedAt)))
    .get();
}

/** The live team the actor belongs to, with their membership; 404 otherwise. */
export function requireTeam(db: DbExecutor, actor: Actor, teamId: string) {
  const membership = requireMember(db, actor, teamId);
  const team = findLiveTeam(db, teamId);
  if (!team) throw errors.notFound('Team');
  return { team, membership };
}

/** Is `slug` used by a live team (other than `exceptTeamId`)? */
function isSlugTaken(db: DbExecutor, slug: string, exceptTeamId?: string): boolean {
  return (
    db
      .select({ id: s.team.id })
      .from(s.team)
      .where(
        and(
          eq(s.team.slug, slug),
          isNull(s.team.deletedAt),
          exceptTeamId ? ne(s.team.id, exceptTeamId) : undefined,
        ),
      )
      .get() !== undefined
  );
}

/**
 * `base` if no live team uses it, else the first free `base-2`, `base-3`, … (the base is
 * shortened so the result stays within the slug length limit).
 */
export function uniqueTeamSlug(db: DbExecutor, base: string, exceptTeamId?: string): string {
  if (!isSlugTaken(db, base, exceptTeamId)) return base;
  const taken = new Set(
    db
      .select({ slug: s.team.slug })
      .from(s.team)
      .where(
        and(
          likePrefix(s.team.slug, base.slice(0, 30)),
          isNull(s.team.deletedAt),
          exceptTeamId ? ne(s.team.id, exceptTeamId) : undefined,
        ),
      )
      .all()
      .map((row) => row.slug),
  );
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const stem = base.slice(0, LIMITS.teamSlug.max - suffix.length).replace(/-+$/, '');
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function slugConflict(slug: string) {
  return errors.conflict(`The URL /t/${slug} is already taken`, { field: 'slug' });
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** The caller's live teams, by name. */
export function listTeams(deps: AppDeps, actor: Actor): TeamListResponse {
  const { orm } = deps.db;
  const teamIds = listMemberships(orm, actor.userId).map((membership) => membership.teamId);
  if (teamIds.length === 0) return { items: [] };
  const rows = orm
    .select()
    .from(s.team)
    .where(and(inArray(s.team.id, teamIds), isNull(s.team.deletedAt)))
    .orderBy(asc(s.team.name))
    .all();
  return { items: toTeamDetails(orm, rows) };
}

export function getTeam(deps: AppDeps, actor: Actor, teamId: string): TeamDetail {
  const { team } = requireTeam(deps.db.orm, actor, teamId);
  return toTeamDetail(deps.db.orm, team);
}

/** Live projects of a team as cards, by name, with open task and unresolved issue counts. */
/** Cards of the team's live projects, only those in `visible` when given (projects one can see). */
export function listProjectCards(
  db: DbExecutor,
  teamId: string,
  visible?: ReadonlySet<string>,
): TeamProjectCard[] {
  const projects = db
    .select({
      id: s.project.id,
      key: s.project.key,
      name: s.project.name,
      description: s.project.description,
      icon: s.project.icon,
      color: s.project.color,
    })
    .from(s.project)
    .where(and(eq(s.project.teamId, teamId), isNull(s.project.deletedAt)))
    .orderBy(asc(s.project.name))
    .all()
    .filter((project) => !visible || visible.has(project.id));
  if (projects.length === 0) return [];
  const ids = projects.map((project) => project.id);
  const openTasks = new Map(
    db
      .select({ projectId: s.task.projectId, value: count() })
      .from(s.task)
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .where(
        and(
          inArray(s.task.projectId, ids),
          isNull(s.task.deletedAt),
          eq(s.status.category, 'open'),
        ),
      )
      .groupBy(s.task.projectId)
      .all()
      .map((row) => [row.projectId, row.value]),
  );
  const openIssues = new Map(
    db
      .select({ projectId: s.issue.projectId, value: count() })
      .from(s.issue)
      .where(
        and(
          inArray(s.issue.projectId, ids),
          isNull(s.issue.deletedAt),
          eq(s.issue.resolved, false),
        ),
      )
      .groupBy(s.issue.projectId)
      .all()
      .map((row) => [row.projectId, row.value]),
  );
  return projects.map((project) => ({
    ...project,
    openTasks: openTasks.get(project.id) ?? 0,
    openIssues: openIssues.get(project.id) ?? 0,
  }));
}

/** Team home: the team and its project cards. */
export function getTeamOverview(deps: AppDeps, actor: Actor, teamId: string): TeamOverview {
  const { orm } = deps.db;
  const { team } = requireTeam(orm, actor, teamId);
  return {
    team: toTeamDetail(orm, team),
    projects: listProjectCards(
      orm,
      teamId,
      new Set(visibleProjectIds(orm, actor.userId, [teamId])),
    ),
  };
}

/** Teams the caller owns that are in Trash and not yet purged, most recently deleted first. */
export function listDeletedTeams(
  deps: AppDeps,
  actor: Actor,
  now: Date = new Date(),
): DeletedTeamsResponse {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const rows = deps.db.orm
    .select()
    .from(s.team)
    .where(
      and(
        // An agent sees its owner's (it may ask the owner to restore one, design §6).
        eq(s.team.ownerId, actor.ownerId ?? actor.userId),
        isNotNull(s.team.deletedAt),
        gt(s.team.deletedAt, cutoff),
      ),
    )
    .orderBy(desc(s.team.deletedAt))
    .all();
  return {
    items: rows.flatMap((row) =>
      row.deletedAt
        ? [
            {
              id: row.id,
              name: row.name,
              slug: row.slug,
              icon: row.icon,
              color: row.color,
              deletedAt: row.deletedAt.toISOString(),
              purgeAt: new Date(
                row.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS,
              ).toISOString(),
            },
          ]
        : [],
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

/** Seeds `@everyone` and Admin for a new team. */
/** Seeds `@everyone` and Admin; returns the Admin role's id. */
function seedRoles(tx: Tx, teamId: string, now: Date): string {
  let adminId = '';
  for (const seed of TEAM_ROLE_SEEDS) {
    const id = newId();
    if (seed.slug === ADMIN_ROLE_SEED.slug) adminId = id;
    tx.insert(s.role)
      .values({
        id,
        teamId,
        name: seed.name,
        slug: seed.slug,
        color: seed.color,
        position: seed.position,
        permissions: [...seed.permissions],
        mentionable: seed.mentionable,
        isEveryone: seed.isEveryone,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return adminId;
}

/**
 * Creates a team owned by the caller (any verified user). The slug is derived from the name when
 * not given (made unique with a numeric suffix); an explicit slug that is taken is a conflict.
 * Agents never own teams (agents A): created through an API key, the team belongs to the key's
 * owner. The owner's agent member joins too, with only `@everyone`, except when the agent created
 * the team: then it gets Admin, so it can set up what it was asked to create (still capped by its
 * owner's permissions, and never the owner).
 */
export function createTeam(deps: AppDeps, actor: Actor, input: CreateTeamInput): TeamDetail {
  const { orm } = deps.db;
  const ownerId = actor.ownerId ?? actor.userId;
  const row = deps.db.write((tx) => {
    let slug: string;
    if (input.slug) {
      if (isSlugTaken(tx, input.slug)) throw slugConflict(input.slug);
      slug = input.slug;
    } else {
      slug = uniqueTeamSlug(tx, teamSlugFromName(input.name));
    }
    const now = new Date();
    const team = tx
      .insert(s.team)
      .values({
        id: newId(),
        name: input.name,
        slug,
        description: input.description ?? '',
        icon: input.icon ?? null,
        color: input.color ?? DEFAULT_TEAM_COLOR,
        ownerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    tx.insert(s.teamMember).values({ teamId: team.id, userId: ownerId, joinedAt: now }).run();
    const agentId = addAgentMembership(tx, team.id, ownerId, now);
    const adminRoleId = seedRoles(tx, team.id, now);
    if (actor.ownerId && agentId === actor.userId) {
      tx.insert(s.memberRole)
        .values({ teamId: team.id, userId: agentId, roleId: adminRoleId })
        .run();
    }
    recordActivity(tx, actor, {
      teamId: team.id,
      entityType: 'team',
      entityId: team.id,
      action: 'team.created',
      meta: { name: team.name, slug: team.slug },
    });
    // The creator's open event streams pick up the new team on a membership event.
    emitAfterCommit(tx, {
      type: 'member.joined',
      teamId: team.id,
      entityType: 'member',
      entityId: ownerId,
      actorId: actor.userId,
    });
    return team;
  });
  return toTeamDetail(orm, row);
}

/** Edits the team's name, slug, description, icon or color (`MANAGE_TEAM`). */
export function updateTeam(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: UpdateTeamInput,
): TeamDetail {
  const { orm } = deps.db;
  const { team, membership } = requireTeam(orm, actor, teamId);
  requirePermission(membership, 'MANAGE_TEAM', "You don't have permission to edit this team");
  const { agentsPaused, agentSignoff, ...fields } = input;
  const changes = diffFields(team, fields);
  // "Pause all agents" (agents A).
  const pauseChanged =
    agentsPaused !== undefined && agentsPaused !== (team.agentsPausedAt !== null);
  if (pauseChanged) changes.agentsPaused = change(!agentsPaused, agentsPaused);
  // "Agents need human sign-off for destructive actions" (design §6).
  const signoffChanged = agentSignoff !== undefined && agentSignoff !== team.agentSignoff;
  if (signoffChanged) {
    // An agent must not be able to switch off the check on itself.
    if (actor.ownerId) {
      throw errors.forbidden('Only people can change whether agents need sign-off, in the web app');
    }
    changes.agentSignoff = change(team.agentSignoff, agentSignoff);
  }
  if (!hasChanges(changes)) return toTeamDetail(orm, team);

  const row = deps.db.write((tx) => {
    if (
      input.slug !== undefined &&
      input.slug !== team.slug &&
      isSlugTaken(tx, input.slug, teamId)
    ) {
      throw slugConflict(input.slug);
    }
    const next = tx
      .update(s.team)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(pauseChanged ? { agentsPausedAt: agentsPaused ? new Date() : null } : {}),
        ...(signoffChanged ? { agentSignoff } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.team.id, teamId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.updated',
      changes,
      meta: { name: next.name, slug: next.slug },
    });
    emitAfterCommit(tx, {
      type: 'team.updated',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
    return next;
  });
  return toTeamDetail(orm, row);
}

/**
 * Moves the team to Trash (owner only). Its projects, issues and tasks disappear with it and come
 * back on restore; the daily purge removes it for good after 30 days.
 */
export function deleteTeam(deps: AppDeps, actor: Actor, teamId: string): { ok: true } {
  const { team, membership } = requireTeam(deps.db.orm, actor, teamId);
  // Agents never own teams: the owner's agent asks the owner, who runs it on approval (§6).
  if (actor.ownerId && team.ownerId === actor.ownerId) {
    requireSignoff(deps, actor, {
      action: 'delete_team',
      teamId,
      input: { teamId },
      summary: `delete the team ${team.name} with all its projects, issues and tasks`,
      url: appPaths.team(team.slug),
    });
  }
  requireOwner(membership, 'Only the team owner can delete the team');
  deps.db.write((tx) => {
    tx.update(s.team)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.team.id, teamId))
      .run();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.deleted',
      meta: { name: team.name, slug: team.slug },
    });
    emitAfterCommit(tx, {
      type: 'team.deleted',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/**
 * Restores a team from Trash (owner only). When another team took its slug in the meantime, it
 * comes back under the next free `slug-2`, `slug-3`, … (recorded in the audit row).
 */
export function restoreTeam(deps: AppDeps, actor: Actor, teamId: string): TeamDetail {
  const { orm } = deps.db;
  const existing = orm.select().from(s.team).where(eq(s.team.id, teamId)).get();
  // An agent finds its owner's deleted teams, and asks the owner to restore one (§6).
  if (!existing?.deletedAt || existing.ownerId !== (actor.ownerId ?? actor.userId)) {
    throw errors.notFound('Deleted team');
  }
  requireSignoff(deps, actor, {
    action: 'restore_team',
    teamId,
    input: { teamId },
    summary: `restore the team ${existing.name} from Trash`,
    url: null,
  });
  const row = deps.db.write((tx) => {
    const slug = uniqueTeamSlug(tx, existing.slug, teamId);
    const next = tx
      .update(s.team)
      .set({
        deletedAt: null,
        deletedById: null,
        deletedViaKeyId: null,
        slug,
        updatedAt: new Date(),
      })
      .where(eq(s.team.id, teamId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.restored',
      changes: slug === existing.slug ? {} : { slug: change(existing.slug, slug) },
      meta: { name: next.name, slug: next.slug },
    });
    // Membership-type event: open streams reload the teams they may see, so every member's
    // sidebar gets the team back; `me.updated` refreshes the owner's deleted-teams list.
    emitAfterCommit(tx, {
      type: 'member.updated',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
    emitAfterCommit(tx, {
      type: 'me.updated',
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      actorId: actor.userId,
      userId: actor.userId,
    });
    return next;
  });
  return toTeamDetail(orm, row);
}

/** Hands the team to another member (owner only). The previous owner stays a member. */
export function transferOwnership(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: TransferOwnershipInput,
): TeamDetail {
  const { orm } = deps.db;
  const { team, membership } = requireTeam(orm, actor, teamId);
  // Agents never own teams: the owner's agent asks the owner, who runs it on approval (§6).
  const ownersAgent = actor.ownerId !== undefined && team.ownerId === actor.ownerId;
  if (!ownersAgent) requireOwner(membership, 'Only the team owner can transfer ownership');
  if (input.userId === team.ownerId) throw errors.validation('You already own this team');
  if (!getMembership(orm, teamId, input.userId)) throw errors.notFound('Member');
  if (agentOwnerOf(orm, input.userId) !== null) {
    throw errors.validation('Agents can’t own teams: pick a person');
  }
  const names = getUserSummaries(orm, [actor.userId, input.userId]);
  if (ownersAgent) {
    const target = names.get(input.userId);
    requireSignoff(deps, actor, {
      action: 'transfer_team_ownership',
      teamId,
      input: { teamId, userId: input.userId },
      summary: `make ${target?.name ?? 'another member'}${target?.username ? ` (@${target.username})` : ''} the owner of ${team.name}`,
      url: appPaths.teamSettings(team.slug, 'general'),
    });
  }

  const row = deps.db.write((tx) => {
    const next = tx
      .update(s.team)
      .set({ ownerId: input.userId, updatedAt: new Date() })
      .where(eq(s.team.id, teamId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'team.ownership_transferred',
      changes: {
        owner: change(
          names.get(actor.userId)?.username ?? null,
          names.get(input.userId)?.username ?? null,
        ),
      },
      meta: { name: next.name, fromUserId: actor.userId, toUserId: input.userId },
    });
    emitAfterCommit(tx, {
      type: 'team.updated',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: actor.userId,
    });
    emitAfterCommit(tx, {
      type: 'member.updated',
      teamId,
      entityType: 'member',
      entityId: input.userId,
      actorId: actor.userId,
    });
    return next;
  });
  return toTeamDetail(orm, row);
}
