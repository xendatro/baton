import { and, eq, inArray } from 'drizzle-orm';
import { canManageRoleWith, displayRoleColor, normalizePermissions } from '@shared/permissions';
import type { Member, MemberListResponse, MemberRole } from '@shared/schemas/teams';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change } from '../lib/diff';
import { errors } from '../lib/errors';
import { canModerateMember, getMembership, hasPermission, type Membership } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { revokeInvitesOf } from './invites';
import { requireRole, teamRoles, type RoleRow } from './roles';
import { unassignFromTasks } from './taskAssignees';
import { requireTeam } from './teams';
import { findAgentId } from './agents';
import { toUserSummaries, userSummaryColumns } from './users';

/**
 * Team members (SPEC §1.3): list with roles, remove (`MANAGE_MEMBERS`, never the owner), leave
 * (anyone but the owner), and grant or revoke roles. Anti-escalation: without `ADMINISTRATOR` a
 * member can only grant roles whose permissions they have, and can't touch members who have
 * `ADMINISTRATOR`; nobody but the owner themself can change the owner's roles.
 */

function toMemberRole(role: RoleRow): MemberRole {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    color: role.color,
    position: role.position,
  };
}

/** Members of a team (all, or only `userIds`), owner first, then by display name. */
function loadMembers(db: DbExecutor, teamId: string, userIds?: readonly string[]): Member[] {
  const team = db
    .select({ ownerId: s.team.ownerId })
    .from(s.team)
    .where(eq(s.team.id, teamId))
    .get();
  if (!team) return [];
  const rows = db
    .select({ joinedAt: s.teamMember.joinedAt, ...userSummaryColumns })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(
      and(
        eq(s.teamMember.teamId, teamId),
        userIds ? inArray(s.teamMember.userId, [...userIds]) : undefined,
      ),
    )
    .all();
  const roles = new Map(
    teamRoles(db, teamId)
      .filter((role) => !role.isEveryone)
      .map((role) => [role.id, role]),
  );
  const assignments = db
    .select({ userId: s.memberRole.userId, roleId: s.memberRole.roleId })
    .from(s.memberRole)
    .where(
      and(
        eq(s.memberRole.teamId, teamId),
        userIds ? inArray(s.memberRole.userId, [...userIds]) : undefined,
      ),
    )
    .all();
  const rolesOf = new Map<string, RoleRow[]>();
  for (const assignment of assignments) {
    const role = roles.get(assignment.roleId);
    if (!role) continue;
    const list = rolesOf.get(assignment.userId) ?? [];
    list.push(role);
    rolesOf.set(assignment.userId, list);
  }

  const summaries = new Map(toUserSummaries(db, rows).map((user) => [user.id, user]));
  return rows
    .flatMap((row): Member[] => {
      const user = summaries.get(row.id);
      if (!user) return [];
      const memberRoles = (rolesOf.get(row.id) ?? []).sort((a, b) => b.position - a.position);
      return [
        {
          user,
          joinedAt: row.joinedAt.toISOString(),
          isOwner: row.id === team.ownerId,
          roles: memberRoles.map(toMemberRole),
          color: displayRoleColor(memberRoles),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(b.isOwner) - Number(a.isOwner) ||
        a.user.name.localeCompare(b.user.name, undefined, { sensitivity: 'base' }) ||
        a.user.username.localeCompare(b.user.username),
    );
}

function loadMember(db: DbExecutor, teamId: string, userId: string): Member {
  const [member] = loadMembers(db, teamId, [userId]);
  if (!member) throw errors.notFound('Member');
  return member;
}

export function listMembers(deps: AppDeps, actor: Actor, teamId: string): MemberListResponse {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  return { items: loadMembers(orm, teamId) };
}

export function getMember(deps: AppDeps, actor: Actor, teamId: string, userId: string): Member {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  return loadMember(orm, teamId, userId);
}

function requireTarget(db: DbExecutor, teamId: string, userId: string): Membership {
  const target = getMembership(db, teamId, userId);
  if (!target) throw errors.notFound('Member');
  return target;
}

/** Why `membership` may not moderate `target` (remove them, change their roles), or null. */
function moderationRefusal(membership: Membership, target: Membership): string | null {
  if (!hasPermission(membership, 'MANAGE_MEMBERS')) {
    return "You don't have permission to manage members";
  }
  if (target.isOwner) return 'Nobody can change or remove the team owner';
  if (!canModerateMember(membership, target)) {
    return 'Only administrators can manage members who have the Administrator permission';
  }
  return null;
}

/**
 * Removes what hangs off a membership in the team that should not outlive it: direct task
 * assignments (each task records the change in its history; claims expire on their own) and the
 * invite links they created (revoked, so a removed member can't rejoin with their own link). Roles
 * go with the membership (ON DELETE CASCADE). Returns how many task assignments were removed and
 * invites revoked.
 */
export function clearMembership(
  tx: Tx,
  actor: Actor,
  teamId: string,
  userId: string,
  reason: 'member_removed' | 'member_left',
): { unassignedTasks: number; revokedInvites: number } {
  const unassignedTasks = unassignFromTasks(tx, actor, teamId, { userId }, reason);
  tx.delete(s.teamMember)
    .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, userId)))
    .run();
  const revokedInvites = revokeInvitesOf(tx, actor, teamId, userId);
  return { unassignedTasks, revokedInvites };
}

/**
 * A person leaving or being removed takes their agent member with them (agents A): the agent's
 * membership is cleared the same way. Returns the agent's username when it was a member.
 */
export function clearAgentMembership(
  tx: Tx,
  actor: Actor,
  teamId: string,
  ownerId: string,
  reason: 'member_removed' | 'member_left' | 'account_deleted',
): string | null {
  const agentId = findAgentId(tx, ownerId);
  if (!agentId) return null;
  const member = tx
    .select({ username: s.user.username })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, agentId)))
    .get();
  if (!member) return null;
  unassignFromTasks(tx, actor, teamId, { userId: agentId }, reason);
  tx.delete(s.teamMember)
    .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, agentId)))
    .run();
  revokeInvitesOf(tx, actor, teamId, agentId);
  emitAfterCommit(tx, {
    type: 'member.left',
    teamId,
    entityType: 'member',
    entityId: agentId,
    actorId: actor.userId,
  });
  return member.username ?? '';
}

/** Removes a member from the team (`MANAGE_MEMBERS`; never the owner or yourself). */
export function removeMember(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  userId: string,
): { ok: true } {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  if (userId === actor.userId) {
    throw errors.validation('To remove yourself, leave the team instead');
  }
  if (userId === actor.ownerId) {
    throw errors.forbidden('An agent can’t remove the person it works for');
  }
  const target = requireTarget(orm, teamId, userId);
  const refusal = moderationRefusal(membership, target);
  if (refusal) throw errors.forbidden(refusal);
  const member = loadMember(orm, teamId, userId);

  deps.db.write((tx) => {
    const cleared = clearMembership(tx, actor, teamId, userId, 'member_removed');
    // Their agent goes with them; an agent removed alone comes back when its owner re-joins.
    const agent = clearAgentMembership(tx, actor, teamId, userId, 'member_removed');
    recordActivity(tx, actor, {
      teamId,
      entityType: 'member',
      entityId: userId,
      action: 'member.removed',
      meta: {
        username: member.user.username,
        name: member.user.name,
        roles: member.roles.map((role) => role.name),
        ...cleared,
        ...(agent === null ? {} : { agent }),
      },
    });
    emitAfterCommit(tx, {
      type: 'member.left',
      teamId,
      entityType: 'member',
      entityId: userId,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/**
 * Leaves the team. The owner must transfer ownership or delete the team first. Membership is the
 * person's (agents A): through an API key, the key's owner leaves, and their agent always goes
 * with them.
 */
export function leaveTeam(deps: AppDeps, actor: Actor, teamId: string): { ok: true } {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  const personId = actor.ownerId ?? actor.userId;
  const membership = getMembership(orm, teamId, personId);
  if (!membership) throw errors.notFound('Team');
  if (membership.isOwner) {
    throw errors.forbidden('The owner can’t leave the team: transfer ownership or delete it first');
  }
  const member = loadMember(orm, teamId, personId);
  deps.db.write((tx) => {
    const cleared = clearMembership(tx, actor, teamId, personId, 'member_left');
    const agent = clearAgentMembership(tx, actor, teamId, personId, 'member_left');
    recordActivity(tx, actor, {
      teamId,
      entityType: 'member',
      entityId: personId,
      action: 'member.left',
      meta: {
        username: member.user.username,
        name: member.user.name,
        roles: member.roles.map((role) => role.name),
        ...cleared,
        ...(agent === null ? {} : { agent }),
      },
    });
    emitAfterCommit(tx, {
      type: 'member.left',
      teamId,
      entityType: 'member',
      entityId: personId,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/**
 * Why `membership` may not grant or revoke `role` on `target`, or null. The owner may change
 * their own roles; everyone else goes through member moderation and role anti-escalation.
 */
function roleChangeRefusal(
  membership: Membership,
  role: RoleRow,
  target: Membership,
): string | null {
  if (membership.isOwner && target.userId === membership.userId) return null;
  const refusal = moderationRefusal(membership, target);
  if (refusal) return refusal;
  const permissions = normalizePermissions(role.permissions);
  if (!canManageRoleWith(membership, permissions)) {
    return permissions.includes('ADMINISTRATOR')
      ? 'Only administrators can grant or revoke roles with the Administrator permission'
      : 'You can only grant or revoke roles whose permissions you have yourself';
  }
  return null;
}

function setRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  userId: string,
  roleId: string,
  assigned: boolean,
): Member {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const target = requireTarget(orm, teamId, userId);
  const role = requireRole(orm, teamId, roleId);
  if (role.isEveryone) {
    throw errors.validation('Every member has @everyone; it can’t be granted or revoked');
  }
  const refusal = roleChangeRefusal(membership, role, target);
  if (refusal) throw errors.forbidden(refusal);
  const member = loadMember(orm, teamId, userId);
  const has = member.roles.some((candidate) => candidate.id === roleId);
  if (has === assigned) return member;

  deps.db.write((tx) => {
    if (assigned) {
      tx.insert(s.memberRole).values({ teamId, userId, roleId }).run();
    } else {
      tx.delete(s.memberRole)
        .where(and(eq(s.memberRole.userId, userId), eq(s.memberRole.roleId, roleId)))
        .run();
    }
    const before = member.roles.map((candidate) => candidate.name);
    const after = assigned
      ? [...member.roles, toMemberRole(role)]
          .sort((a, b) => b.position - a.position)
          .map((candidate) => candidate.name)
      : member.roles
          .filter((candidate) => candidate.id !== roleId)
          .map((candidate) => candidate.name);
    recordActivity(tx, actor, {
      teamId,
      entityType: 'member',
      entityId: userId,
      action: 'member.roles_changed',
      changes: { roles: change(before, after) },
      meta: {
        username: member.user.username,
        name: member.user.name,
        added: assigned ? [role.name] : [],
        removed: assigned ? [] : [role.name],
        roleId,
      },
    });
    emitAfterCommit(tx, {
      type: 'member.updated',
      teamId,
      entityType: 'member',
      entityId: userId,
      actorId: actor.userId,
    });
    // Role member counts change too.
    emitAfterCommit(tx, {
      type: 'role.changed',
      teamId,
      entityType: 'role',
      entityId: roleId,
      actorId: actor.userId,
    });
  });
  return loadMember(orm, teamId, userId);
}

/** Grants `roleId` to a member (no-op if they have it). */
export function assignRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  userId: string,
  roleId: string,
): Member {
  return setRole(deps, actor, teamId, userId, roleId, true);
}

/** Revokes `roleId` from a member (no-op if they don't have it). */
export function unassignRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  userId: string,
  roleId: string,
): Member {
  return setRole(deps, actor, teamId, userId, roleId, false);
}
