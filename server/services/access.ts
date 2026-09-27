import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  canManageRoleWith,
  capAgentPermissions,
  canModerateMember as canModerateMemberWith,
  combineProjectPermissions,
  effectivePermissions,
  effectiveProjectPermissions,
  normalizePermissions,
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
  /**
   * Agents A: the member and their counterpart — a person's agent member, or an agent's owner.
   * Content either of them wrote counts as the member's own (`isOwnContent`). Unset: just `userId`.
   */
  selfIds?: readonly string[];
}

/** The member's permissions as the shared anti-escalation helpers expect them. */
function subject(membership: Membership) {
  return { isOwner: membership.isOwner, permissions: membership.permissions };
}

/**
 * Memberships of `userId` in non-deleted teams, optionally limited to `teamIds`.
 * One query for memberships and one for roles, whatever the number of teams. An agent member's
 * permissions are capped by its owner's (`applyAgentRules`).
 */
export function listMemberships(
  db: DbExecutor,
  userId: string,
  teamIds?: readonly string[],
): Membership[] {
  return applyAgentRules(db, userId, listRoleMemberships(db, userId, teamIds));
}

/**
 * Agents A (docs/design/agents-and-pipelines.md §1): an agent member's effective permissions in
 * a team are its own intersected with its owner's there (`capAgentPermissions`), and it is never
 * the owner. An agent has no access to a team its owner isn't in. A person and their agent count
 * as one author (`selfIds`).
 */
function applyAgentRules(db: DbExecutor, userId: string, memberships: Membership[]): Membership[] {
  if (memberships.length === 0) return memberships;
  const user = db
    .select({ kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .get();
  if (user?.kind !== 'agent') {
    const agent = db
      .select({ id: s.user.id })
      .from(s.user)
      .where(eq(s.user.agentOwnerId, userId))
      .get();
    if (!agent) return memberships;
    const selfIds = [userId, agent.id];
    return memberships.map((membership) => ({ ...membership, selfIds }));
  }
  const selfIds = user.ownerId ? [userId, user.ownerId] : [userId];
  const owners = new Map(
    user.ownerId
      ? listRoleMemberships(
          db,
          user.ownerId,
          memberships.map((membership) => membership.teamId),
        ).map((membership) => [membership.teamId, membership])
      : [],
  );
  return memberships.flatMap((membership) => {
    const owner = owners.get(membership.teamId);
    if (!owner) return [];
    return [
      {
        ...membership,
        isOwner: false,
        permissions: capAgentPermissions(owner.permissions, membership.permissions),
        selfIds,
      },
    ];
  });
}

/**
 * Did the member write it? Content by a person's agent member counts as theirs and the other
 * way round (agents A), so people can fix or remove what their agent wrote and vice versa.
 */
export function isOwnContent(membership: Membership, authorId: string | null): boolean {
  if (authorId === null) return false;
  return authorId === membership.userId || (membership.selfIds?.includes(authorId) ?? false);
}

/** Memberships from team roles alone (no agent cap). */
function listRoleMemberships(
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
  return isOwnContent(membership, authorId) || hasPermission(membership, 'EDIT_ANY_CONTENT');
}

/** Authors can always delete their own content; others need `DELETE_ANY_CONTENT`. */
export function canDeleteContent(membership: Membership, authorId: string | null): boolean {
  return isOwnContent(membership, authorId) || hasPermission(membership, 'DELETE_ANY_CONTENT');
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
  return isOwnContent(membership, authorId) || hasPermission(membership, 'MANAGE_TRASH');
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

// =============================================================================================
// Project access (docs/design/agents-and-pipelines.md §3)
// =============================================================================================

/**
 * A member's access to one project. It is a `Membership` whose `permissions` are the combined
 * permissions in the project (team-level ones from team roles, project-level ones after the
 * project's overrides), so every `Membership` helper above (`hasPermission`, `canEditContent`, …)
 * works on it unchanged.
 */
export interface ProjectMembership extends Membership {
  projectId: string;
  /** The team membership: team-level permissions from team roles only. */
  membership: Membership;
  /** Effective project-level permissions (every project permission for owners and admins). */
  projectPermissions: Permission[];
}

type OverrideRow = typeof s.projectPermissionOverride.$inferSelect;

function overrideSets(row: OverrideRow | undefined) {
  if (!row) return null;
  return { allow: normalizePermissions(row.allow), deny: normalizePermissions(row.deny) };
}

/**
 * Project access of `userId` in projects of their live teams (all of them, or `projectIds`).
 * Deleted projects are included only with `includeDeleted`. A handful of queries whatever the
 * number of projects. Agents (`user.kind = 'agent'`) are capped by their owner: their project
 * permissions are intersected with the owner's in the same project (design §1, §3).
 */
export function listProjectMemberships(
  db: DbExecutor,
  userId: string,
  options: {
    projectIds?: readonly string[];
    teamIds?: readonly string[];
    includeDeleted?: boolean;
  } = {},
): ProjectMembership[] {
  if (options.projectIds?.length === 0) return [];
  const memberships = listMemberships(db, userId, options.teamIds);
  if (memberships.length === 0) return [];
  const byTeam = new Map(memberships.map((membership) => [membership.teamId, membership]));
  const projects = db
    .select({ id: s.project.id, teamId: s.project.teamId })
    .from(s.project)
    .where(
      and(
        inArray(s.project.teamId, [...byTeam.keys()]),
        options.projectIds ? inArray(s.project.id, [...options.projectIds]) : undefined,
        options.includeDeleted ? undefined : isNull(s.project.deletedAt),
      ),
    )
    .all();
  if (projects.length === 0) return [];
  const projectIds = projects.map((project) => project.id);

  const overrides = db
    .select()
    .from(s.projectPermissionOverride)
    .where(inArray(s.projectPermissionOverride.projectId, projectIds))
    .all();
  const myProjectRoles = db
    .select({ roleId: s.projectRole.id, projectId: s.projectRole.projectId })
    .from(s.projectRoleMember)
    .innerJoin(s.projectRole, eq(s.projectRole.id, s.projectRoleMember.projectRoleId))
    .where(
      and(eq(s.projectRoleMember.userId, userId), inArray(s.projectRole.projectId, projectIds)),
    )
    .all();
  const everyoneRoles = new Map(
    db
      .select({ id: s.role.id, teamId: s.role.teamId })
      .from(s.role)
      .where(and(inArray(s.role.teamId, [...byTeam.keys()]), eq(s.role.isEveryone, true)))
      .all()
      .map((role) => [role.teamId, role.id]),
  );

  const own = projects.flatMap((project): ProjectMembership[] => {
    const membership = byTeam.get(project.teamId);
    if (!membership) return [];
    const mine = overrides.filter((row) => row.projectId === project.id);
    const find = (type: OverrideRow['subjectType'], id: string | undefined) =>
      id === undefined
        ? undefined
        : mine.find((row) => row.subjectType === type && row.subjectId === id);
    const teamRoleIds = new Set(membership.roleIds);
    const projectRoleIds = new Set(
      myProjectRoles.filter((row) => row.projectId === project.id).map((row) => row.roleId),
    );
    const roles = mine
      .filter(
        (row) =>
          (row.subjectType === 'team_role' && teamRoleIds.has(row.subjectId)) ||
          (row.subjectType === 'project_role' && projectRoleIds.has(row.subjectId)),
      )
      .map((row) => overrideSets(row) ?? { allow: [], deny: [] });
    const projectPermissions = effectiveProjectPermissions({
      isOwner: membership.isOwner,
      teamPermissions: membership.permissions,
      everyone: overrideSets(find('team_role', everyoneRoles.get(project.teamId))),
      roles,
      user: overrideSets(find('user', userId)),
    });
    return [projectMembership(membership, project.id, projectPermissions)];
  });

  const ownerId = agentOwnerOf(db, userId);
  if (!ownerId) return own;
  const owner = new Map(
    listProjectMemberships(db, ownerId, {
      projectIds,
      includeDeleted: options.includeDeleted,
    }).map((access) => [access.projectId, access]),
  );
  return own.map((access) => {
    const cap = owner.get(access.projectId);
    const within = (permissions: readonly Permission[]) =>
      permissions.filter((permission) => cap?.permissions.includes(permission) ?? false);
    return {
      ...access,
      projectPermissions: within(access.projectPermissions),
      // An agent's combined permissions never exceed its owner's (ADMINISTRATOR included).
      permissions: within(access.permissions),
    };
  });
}

function projectMembership(
  membership: Membership,
  projectId: string,
  projectPermissions: Permission[],
): ProjectMembership {
  return {
    ...membership,
    projectId,
    membership,
    projectPermissions,
    permissions: combineProjectPermissions(membership.permissions, projectPermissions),
  };
}

/** The owner of an agent member (`user.agent_owner_id`), or null for people. */
function agentOwnerOf(db: DbExecutor, userId: string): string | null {
  const row = db
    .select({ kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .get();
  return row?.kind === 'agent' ? (row.ownerId ?? null) : null;
}

/**
 * The user's access to a project of one of their live teams (deleted projects included), or null
 * when they are not a member of its team. Visibility is not checked: see `canViewProject`.
 */
export function getProjectAccess(
  db: DbExecutor,
  userId: string,
  projectId: string,
): ProjectMembership | null {
  return (
    listProjectMemberships(db, userId, { projectIds: [projectId], includeDeleted: true })[0] ?? null
  );
}

export function canViewProject(access: Membership): boolean {
  return hasPermission(access, 'VIEW_PROJECT');
}

/**
 * The actor's access to a project, or `not_found` (named after `what`) when the actor is not a
 * member of its team or can't see it (`VIEW_PROJECT`): a hidden project doesn't exist for them.
 * Liveness of the project is left to the caller.
 */
export function requireProjectAccess(
  db: DbExecutor,
  actor: Actor,
  projectId: string,
  what = 'Project',
): ProjectMembership {
  const access = getProjectAccess(db, actor.userId, projectId);
  if (!access || !canViewProject(access)) throw errors.notFound(what);
  return access;
}

/** Project access for project content, team membership for team-level things (no project). */
export function requireScopedAccess(
  db: DbExecutor,
  actor: Actor,
  teamId: string,
  projectId: string | null,
  what = 'Team',
): Membership {
  return projectId
    ? requireProjectAccess(db, actor, projectId, what)
    : requireMember(db, actor, teamId, what);
}

export function hasProjectPermission(access: ProjectMembership, permission: Permission): boolean {
  return hasPermission(access, permission);
}

/** Throws 403 unless the member has `permission` in the project. */
export function requireProjectPermission(
  access: ProjectMembership,
  permission: Permission,
  message?: string,
): void {
  requirePermission(access, permission, message);
}

/**
 * May the member manage the project's roles and overrides? `MANAGE_PROJECT_ACCESS` in the
 * project, or the team's `MANAGE_PROJECTS` (owners and administrators always).
 */
export function canManageProjectAccess(access: ProjectMembership): boolean {
  return (
    hasPermission(access, 'MANAGE_PROJECT_ACCESS') ||
    hasPermission(access.membership, 'MANAGE_PROJECTS')
  );
}

/** Ids of the live projects (of live teams) the user can see, optionally within `teamIds`. */
export function visibleProjectIds(
  db: DbExecutor,
  userId: string,
  teamIds?: readonly string[],
): string[] {
  return listProjectMemberships(db, userId, { teamIds })
    .filter(canViewProject)
    .map((access) => access.projectId);
}

/** Those of `userIds` who can see the project (members of its team with `VIEW_PROJECT`). */
export function projectViewerIds(
  db: DbExecutor,
  projectId: string,
  userIds: Iterable<string>,
): string[] {
  return [...new Set(userIds)].filter((userId) => {
    const access = getProjectAccess(db, userId, projectId);
    return access !== null && canViewProject(access);
  });
}
