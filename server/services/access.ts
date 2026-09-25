import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  canManageRoleWith,
  canModerateMember as canModerateMemberWith,
  effectivePermissions,
  hasPermission as permissionsInclude,
  type Permission,
} from '@shared/permissions';
import type { Actor } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';

/**
 * Team access control (SPEC §1.3). Every team-scoped service starts with `requireMember`
 * (non-members get 404, never 403), then checks permissions with the helpers below.
 */

export interface Membership {
  teamId: string;
  userId: string;
  isOwner: boolean;
  /** Explicit roles (not including `@everyone`, which every member implicitly has). */
  roleIds: string[];
  /** Effective permissions: the full list for the owner and administrators. */
  permissions: Permission[];
}

/** The member's permissions as the shared anti-escalation helpers expect them. */
function subject(membership: Membership) {
  return { isOwner: membership.isOwner, permissions: membership.permissions };
}

/**
 * Memberships of `userId` in non-deleted teams, optionally limited to `teamIds`.
 * One query for memberships and one for roles, whatever the number of teams.
 */
export function listMemberships(
  db: DbExecutor,
  userId: string,
  teamIds?: readonly string[],
): Membership[] {
  if (teamIds && teamIds.length === 0) return [];
  const rows = db
    .select({ teamId: s.teamMember.teamId, ownerId: s.team.ownerId })
    .from(s.teamMember)
    .innerJoin(s.team, eq(s.team.id, s.teamMember.teamId))
    .where(
      and(
        eq(s.teamMember.userId, userId),
        isNull(s.team.deletedAt),
        teamIds ? inArray(s.teamMember.teamId, [...teamIds]) : undefined,
      ),
    )
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.teamId);

  const roles = db
    .select({
      teamId: s.role.teamId,
      roleId: s.role.id,
      permissions: s.role.permissions,
      isEveryone: s.role.isEveryone,
      assigned: s.memberRole.roleId,
    })
    .from(s.role)
    .leftJoin(
      s.memberRole,
      and(eq(s.memberRole.roleId, s.role.id), eq(s.memberRole.userId, userId)),
    )
    .where(inArray(s.role.teamId, ids))
    .all();

  return rows.map((row) => {
    const teamRoles = roles.filter(
      (role) => role.teamId === row.teamId && (role.isEveryone || role.assigned !== null),
    );
    const isOwner = row.ownerId === userId;
    return {
      teamId: row.teamId,
      userId,
      isOwner,
      roleIds: teamRoles.filter((role) => !role.isEveryone).map((role) => role.roleId),
      permissions: effectivePermissions({
        isOwner,
        rolePermissions: teamRoles.map((role) => role.permissions),
      }),
    };
  });
}

/** The user's membership in a non-deleted team, or null. */
export function getMembership(db: DbExecutor, teamId: string, userId: string): Membership | null {
  return listMemberships(db, userId, [teamId])[0] ?? null;
}

/**
 * The actor's membership, or `not_found` (named after `what`, e.g. "Task") when the team does not
 * exist, is deleted, or the actor is not a member — existence never leaks to outsiders.
 */
export function requireMember(
  db: DbExecutor,
  actor: Actor,
  teamId: string,
  what = 'Team',
): Membership {
  const membership = getMembership(db, teamId, actor.userId);
  if (!membership) throw errors.notFound(what);
  return membership;
}

/** Ids of the non-deleted teams the user belongs to. */
export function memberTeamIds(db: DbExecutor, userId: string): string[] {
  return db
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .innerJoin(s.team, eq(s.team.id, s.teamMember.teamId))
    .where(and(eq(s.teamMember.userId, userId), isNull(s.team.deletedAt)))
    .all()
    .map((row) => row.teamId);
}

export function hasPermission(membership: Membership, permission: Permission): boolean {
  return permissionsInclude(membership.permissions, permission);
}

/** Throws 403 unless the member has `permission` (owners and administrators always do). */
export function requirePermission(
  membership: Membership,
  permission: Permission,
  message?: string,
): void {
  if (!hasPermission(membership, permission)) throw errors.forbidden(message);
}

/** Owner-only actions (delete the team, transfer ownership). */
export function requireOwner(
  membership: Membership,
  message = 'Only the team owner can do that',
): void {
  if (!membership.isOwner) throw errors.forbidden(message);
}

/**
 * May the member create, edit or delete a role? Needs `MANAGE_ROLES`, and (anti-escalation) every
 * permission set involved — the role's current permissions and, for edits, the new ones — must be
 * one the member could grant: owners and administrators can grant anything; everyone else only
 * subsets of their own permissions and never `ADMINISTRATOR`.
 */
export function canManageRole(
  membership: Membership,
  ...permissionSets: ReadonlyArray<readonly Permission[]>
): boolean {
  if (!hasPermission(membership, 'MANAGE_ROLES')) return false;
  return permissionSets.every((permissions) => canManageRoleWith(subject(membership), permissions));
}

/**
 * May the member moderate `target` (change their roles, remove them)? Needs `MANAGE_MEMBERS`.
 * Nobody can moderate the owner, and only owners and administrators can moderate members who
 * have `ADMINISTRATOR`.
 */
export function canModerateMember(membership: Membership, target: Membership): boolean {
  if (!hasPermission(membership, 'MANAGE_MEMBERS')) return false;
  return canModerateMemberWith(subject(membership), subject(target));
}

/**
 * May the member grant or revoke `role` on `target`? `@everyone` is implicit and can't be
 * assigned. Otherwise the member must be able to moderate the target and to grant the role's
 * permissions.
 */
export function canAssignRole(
  membership: Membership,
  role: { permissions: readonly Permission[]; isEveryone: boolean },
  target: Membership,
): boolean {
  if (role.isEveryone) return false;
  if (!canModerateMember(membership, target)) return false;
  return canManageRoleWith(subject(membership), role.permissions);
}

/** Authors can always edit their own content; others need `EDIT_ANY_CONTENT`. */
export function canEditContent(membership: Membership, authorId: string | null): boolean {
  return authorId === membership.userId || hasPermission(membership, 'EDIT_ANY_CONTENT');
}

/** Authors can always delete their own content; others need `DELETE_ANY_CONTENT`. */
export function canDeleteContent(membership: Membership, authorId: string | null): boolean {
  return authorId === membership.userId || hasPermission(membership, 'DELETE_ANY_CONTENT');
}

export function requireCanEditContent(membership: Membership, authorId: string | null): void {
  if (!canEditContent(membership, authorId)) {
    throw errors.forbidden('You can only edit your own content');
  }
}

export function requireCanDeleteContent(membership: Membership, authorId: string | null): void {
  if (!canDeleteContent(membership, authorId)) {
    throw errors.forbidden('You can only delete your own content');
  }
}

/** Authors can always restore their own items; others need `MANAGE_TRASH`. */
export function canRestoreContent(membership: Membership, authorId: string | null): boolean {
  return authorId === membership.userId || hasPermission(membership, 'MANAGE_TRASH');
}

/** User ids of every member of a team. */
export function teamMemberIds(db: DbExecutor, teamId: string): string[] {
  return db
    .select({ userId: s.teamMember.userId })
    .from(s.teamMember)
    .where(eq(s.teamMember.teamId, teamId))
    .all()
    .map((row) => row.userId);
}

/** User ids of members who have any of `roleIds` (explicitly assigned). */
export function roleMemberIds(db: DbExecutor, roleIds: readonly string[]): string[] {
  if (roleIds.length === 0) return [];
  const rows = db
    .selectDistinct({ userId: s.memberRole.userId })
    .from(s.memberRole)
    .where(inArray(s.memberRole.roleId, [...roleIds]))
    .all();
  return rows.map((row) => row.userId);
}
