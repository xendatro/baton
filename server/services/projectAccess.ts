import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { LIMITS } from '@shared/constants';
import {
  changedOverridePermissions,
  normalizePermissions,
  PERMISSION_INFO,
  type Permission,
} from '@shared/permissions';
import {
  MAX_PROJECT_ROLES,
  type CreateProjectRoleInput,
  type MemberProjectPermissions,
  type OverrideSubjectType,
  type PermissionOverride,
  type ProjectPermissionsResponse,
  type ProjectRole,
  type ProjectRoleListResponse,
  type ReorderProjectRolesInput,
  type SetPermissionOverrideInput,
  type UpdateProjectRoleInput,
} from '@shared/schemas/projectAccess';
import { slugify } from '@shared/schemas/teams';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, diffFields, hasChanges, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  canManageProjectAccess,
  canViewProject,
  getProjectAccess,
  hasPermission,
  type ProjectMembership,
} from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { requireProject, type ProjectRow } from './projects';
import { toUserSummary } from './users';

/**
 * Project access (docs/design/agents-and-pipelines.md §3): project roles and their members, and
 * per-project permission overrides of team roles, project roles and members. Every member who can
 * see the project can read them; changing them needs `MANAGE_PROJECT_ACCESS` in the project (or
 * the team's `MANAGE_PROJECTS`). Anti-escalation like team roles: without `ADMINISTRATOR` you can
 * only allow, deny or reset permissions you have in the project yourself, and only give, take or
 * delete project roles whose overrides are within your own permissions.
 */

export type ProjectRoleRow = typeof s.projectRole.$inferSelect;
type OverrideRow = typeof s.projectPermissionOverride.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isBypass(access: ProjectMembership): boolean {
  return access.isOwner || access.permissions.includes('ADMINISTRATOR');
}

function requireManage(access: ProjectMembership): void {
  if (!canManageProjectAccess(access)) {
    throw errors.forbidden("You don't have permission to manage this project's access");
  }
}

/** Anti-escalation: the actor must have every permission in `permissions` in the project. */
function requireWithinOwn(
  access: ProjectMembership,
  permissions: readonly Permission[],
  message: string,
): void {
  if (isBypass(access)) return;
  const missing = permissions.filter((permission) => !hasPermission(access, permission));
  if (missing.length > 0) {
    const names = missing.map((permission) => PERMISSION_INFO[permission].label).join(', ');
    throw errors.forbidden(`${message} (you don't have: ${names})`);
  }
}

function labels(permissions: readonly Permission[]): string[] {
  return normalizePermissions(permissions).map((permission) => PERMISSION_INFO[permission].label);
}

function accessEvent(project: ProjectRow, actor: Actor) {
  return {
    type: 'project_access.changed' as const,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'project' as const,
    entityId: project.id,
    actorId: actor.userId,
  };
}

function overrideOf(
  db: DbExecutor,
  projectId: string,
  subjectType: OverrideSubjectType,
  subjectId: string,
): OverrideRow | undefined {
  return db
    .select()
    .from(s.projectPermissionOverride)
    .where(
      and(
        eq(s.projectPermissionOverride.projectId, projectId),
        eq(s.projectPermissionOverride.subjectType, subjectType),
        eq(s.projectPermissionOverride.subjectId, subjectId),
      ),
    )
    .get();
}

/** Permissions a role's override mentions (allowed or denied). */
function overridePermissions(row: OverrideRow | undefined): Permission[] {
  return row ? normalizePermissions([...row.allow, ...row.deny]) : [];
}

// ---------------------------------------------------------------------------------------------
// Project roles
// ---------------------------------------------------------------------------------------------

/** The project's roles, highest first. */
export function projectRolesOf(db: DbExecutor, projectId: string): ProjectRoleRow[] {
  return db
    .select()
    .from(s.projectRole)
    .where(eq(s.projectRole.projectId, projectId))
    .orderBy(desc(s.projectRole.position), asc(s.projectRole.createdAt))
    .all();
}

function toProjectRoles(
  db: DbExecutor,
  teamId: string,
  rows: readonly ProjectRoleRow[],
): ProjectRole[] {
  const ids = rows.map((row) => row.id);
  const holders =
    ids.length === 0
      ? []
      : db
          .select({ roleId: s.projectRoleMember.projectRoleId, user: s.user })
          .from(s.projectRoleMember)
          .innerJoin(s.user, eq(s.user.id, s.projectRoleMember.userId))
          .innerJoin(
            s.teamMember,
            and(eq(s.teamMember.userId, s.user.id), eq(s.teamMember.teamId, teamId)),
          )
          .where(inArray(s.projectRoleMember.projectRoleId, ids))
          .orderBy(asc(s.user.username))
          .all();
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    color: row.color,
    position: row.position,
    members: holders
      .filter((holder) => holder.roleId === row.id)
      .map((holder) => ({ ...toUserSummary(holder.user), isAgent: holder.user.kind === 'agent' })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function toProjectRole(db: DbExecutor, teamId: string, row: ProjectRoleRow): ProjectRole {
  const [role] = toProjectRoles(db, teamId, [row]);
  if (!role) throw errors.internal();
  return role;
}

/** A role of the project, or 404. */
export function requireProjectRole(
  db: DbExecutor,
  projectId: string,
  roleId: string,
): ProjectRoleRow {
  const row = db
    .select()
    .from(s.projectRole)
    .where(and(eq(s.projectRole.id, roleId), eq(s.projectRole.projectId, projectId)))
    .get();
  if (!row) throw errors.notFound('Project role');
  return row;
}

function uniqueSlug(db: DbExecutor, projectId: string, name: string, exceptId?: string): string {
  const base = slugify(name, LIMITS.roleName.max) || 'role';
  const taken = new Set(
    projectRolesOf(db, projectId)
      .filter((role) => role.id !== exceptId)
      .map((role) => role.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, LIMITS.roleName.max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function listProjectRoles(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): ProjectRoleListResponse {
  const { orm } = deps.db;
  const { project } = requireProject(orm, actor, projectId);
  return { items: toProjectRoles(orm, project.teamId, projectRolesOf(orm, projectId)) };
}

/** Creates a project role at the bottom of the list. */
export function createProjectRole(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateProjectRoleInput,
): ProjectRole {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const row = deps.db.write((tx) => {
    const existing = tx
      .select({ value: count() })
      .from(s.projectRole)
      .where(eq(s.projectRole.projectId, projectId))
      .get();
    if ((existing?.value ?? 0) >= MAX_PROJECT_ROLES) {
      throw errors.conflict(`A project can have at most ${MAX_PROJECT_ROLES} roles`);
    }
    tx.update(s.projectRole)
      .set({ position: sql`${s.projectRole.position} + 1` })
      .where(eq(s.projectRole.projectId, projectId))
      .run();
    const now = new Date();
    const role = tx
      .insert(s.projectRole)
      .values({
        id: newId(),
        projectId,
        name: input.name,
        slug: uniqueSlug(tx, projectId, input.name),
        color: input.color ?? null,
        position: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'role',
      entityId: role.id,
      action: 'project_role.created',
      meta: { name: role.name, slug: role.slug, color: role.color, project: project.key },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
    return role;
  });
  return toProjectRole(orm, project.teamId, row);
}

export function updateProjectRole(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  roleId: string,
  input: UpdateProjectRoleInput,
): ProjectRole {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const role = requireProjectRole(orm, projectId, roleId);
  const changes: Changes = diffFields(role, { name: input.name, color: input.color });
  if (!hasChanges(changes)) return toProjectRole(orm, project.teamId, role);
  const row = deps.db.write((tx) => {
    const slug =
      input.name !== undefined && input.name !== role.name
        ? uniqueSlug(tx, projectId, input.name, roleId)
        : role.slug;
    if (slug !== role.slug) changes.slug = change(role.slug, slug);
    const next = tx
      .update(s.projectRole)
      .set({
        ...(input.name !== undefined ? { name: input.name, slug } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.projectRole.id, roleId))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'role',
      entityId: roleId,
      action: 'project_role.updated',
      changes,
      meta: { name: next.name, slug: next.slug, project: project.key },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
    return next;
  });
  return toProjectRole(orm, project.teamId, row);
}

/** Deletes a project role, its members' holding of it and its override. */
export function deleteProjectRole(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  roleId: string,
): { ok: true } {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const role = requireProjectRole(orm, projectId, roleId);
  requireWithinOwn(
    membership,
    overridePermissions(overrideOf(orm, projectId, 'project_role', roleId)),
    'You can only delete project roles whose permissions you have yourself',
  );
  const [summary] = toProjectRoles(orm, project.teamId, [role]);
  deps.db.write((tx) => {
    deleteOverridesOf(tx, 'project_role', roleId);
    // project_role_member rows go with the role (ON DELETE CASCADE).
    tx.delete(s.projectRole).where(eq(s.projectRole.id, roleId)).run();
    tx.update(s.projectRole)
      .set({ position: sql`${s.projectRole.position} - 1` })
      .where(and(eq(s.projectRole.projectId, projectId), gt(s.projectRole.position, role.position)))
      .run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'role',
      entityId: roleId,
      action: 'project_role.deleted',
      meta: {
        name: role.name,
        slug: role.slug,
        project: project.key,
        memberCount: summary?.members.length ?? 0,
      },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
  });
  return { ok: true };
}

/** Sets the order of the project's roles (every role, highest first). */
export function reorderProjectRoles(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ReorderProjectRolesInput,
): ProjectRoleListResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const current = projectRolesOf(orm, projectId);
  const ids = input.roleIds;
  const known = new Set(current.map((role) => role.id));
  if (
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id))
  ) {
    throw errors.validation('List every role of the project exactly once, highest first');
  }
  if (current.every((role, index) => ids[index] === role.id)) {
    return { items: toProjectRoles(orm, project.teamId, current) };
  }
  const byId = new Map(current.map((role) => [role.id, role]));
  deps.db.write((tx) => {
    const now = new Date();
    ids.forEach((id, index) => {
      tx.update(s.projectRole)
        .set({ position: ids.length - index, updatedAt: now })
        .where(eq(s.projectRole.id, id))
        .run();
    });
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'project_role.reordered',
      changes: {
        order: change(
          current.map((role) => role.name),
          ids.map((id) => byId.get(id)?.name ?? id),
        ),
      },
      meta: { name: project.name, key: project.key },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
  });
  return { items: toProjectRoles(orm, project.teamId, projectRolesOf(orm, projectId)) };
}

function requireTeamMember(db: DbExecutor, teamId: string, userId: string) {
  const row = db
    .select({ user: s.user })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, userId)))
    .get();
  if (!row) throw errors.notFound('Member');
  return row.user;
}

/** Gives (`assign`) or takes (`unassign`) a project role to or from a member of the team. */
function changeProjectRoleMember(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  roleId: string,
  userId: string,
  assign: boolean,
): ProjectRole {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const role = requireProjectRole(orm, projectId, roleId);
  const user = requireTeamMember(orm, project.teamId, userId);
  requireWithinOwn(
    membership,
    overridePermissions(overrideOf(orm, projectId, 'project_role', roleId)),
    `You can only ${assign ? 'give' : 'take away'} project roles whose permissions you have yourself`,
  );
  const holds =
    orm
      .select({ userId: s.projectRoleMember.userId })
      .from(s.projectRoleMember)
      .where(
        and(eq(s.projectRoleMember.projectRoleId, roleId), eq(s.projectRoleMember.userId, userId)),
      )
      .get() !== undefined;
  if (holds === assign) return toProjectRole(orm, project.teamId, role);
  deps.db.write((tx) => {
    if (assign) {
      tx.insert(s.projectRoleMember).values({ projectRoleId: roleId, userId }).run();
    } else {
      tx.delete(s.projectRoleMember)
        .where(
          and(
            eq(s.projectRoleMember.projectRoleId, roleId),
            eq(s.projectRoleMember.userId, userId),
          ),
        )
        .run();
    }
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'role',
      entityId: roleId,
      action: assign ? 'project_role.assigned' : 'project_role.unassigned',
      changes: {
        members: assign
          ? change([], [user.username ?? user.name])
          : change([user.username ?? user.name], []),
      },
      meta: { name: role.name, slug: role.slug, project: project.key, username: user.username },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
  });
  return toProjectRole(orm, project.teamId, requireProjectRole(orm, projectId, roleId));
}

export function assignProjectRole(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  roleId: string,
  userId: string,
): ProjectRole {
  return changeProjectRoleMember(deps, actor, projectId, roleId, userId, true);
}

export function unassignProjectRole(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  roleId: string,
  userId: string,
): ProjectRole {
  return changeProjectRoleMember(deps, actor, projectId, roleId, userId, false);
}

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

interface SubjectInfo {
  name: string;
  color: string | null;
  /** `@everyone` sorts first among team roles. */
  isEveryone: boolean;
  position: number;
}

/** The subject of an override in the project's team, or null when it no longer exists. */
function subjectInfo(
  db: DbExecutor,
  project: ProjectRow,
  subjectType: OverrideSubjectType,
  subjectId: string,
): SubjectInfo | null {
  switch (subjectType) {
    case 'team_role': {
      const role = db
        .select()
        .from(s.role)
        .where(and(eq(s.role.id, subjectId), eq(s.role.teamId, project.teamId)))
        .get();
      return role
        ? {
            name: role.name,
            color: role.color,
            isEveryone: role.isEveryone,
            position: role.position,
          }
        : null;
    }
    case 'project_role': {
      const role = db
        .select()
        .from(s.projectRole)
        .where(and(eq(s.projectRole.id, subjectId), eq(s.projectRole.projectId, project.id)))
        .get();
      return role
        ? { name: role.name, color: role.color, isEveryone: false, position: role.position }
        : null;
    }
    case 'user': {
      const user = db
        .select({ username: s.user.username, name: s.user.name })
        .from(s.teamMember)
        .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
        .where(and(eq(s.teamMember.teamId, project.teamId), eq(s.teamMember.userId, subjectId)))
        .get();
      return user
        ? { name: `@${user.username ?? user.name}`, color: null, isEveryone: false, position: 0 }
        : null;
    }
  }
}

const SUBJECT_ORDER: Record<OverrideSubjectType, number> = {
  team_role: 0,
  project_role: 1,
  user: 2,
};

function toOverrides(db: DbExecutor, project: ProjectRow): PermissionOverride[] {
  const rows = db
    .select()
    .from(s.projectPermissionOverride)
    .where(eq(s.projectPermissionOverride.projectId, project.id))
    .all();
  return rows
    .flatMap((row) => {
      const info = subjectInfo(db, project, row.subjectType, row.subjectId);
      return info ? [{ row, info }] : [];
    })
    .sort(
      (a, b) =>
        SUBJECT_ORDER[a.row.subjectType] - SUBJECT_ORDER[b.row.subjectType] ||
        Number(b.info.isEveryone) - Number(a.info.isEveryone) ||
        b.info.position - a.info.position ||
        a.info.name.localeCompare(b.info.name),
    )
    .map(({ row, info }) => ({
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectName: info.name,
      subjectColor: info.color,
      allow: normalizePermissions(row.allow),
      deny: normalizePermissions(row.deny),
      updatedAt: row.updatedAt.toISOString(),
    }));
}

/** The project's overrides and the viewer's permissions there. */
export function getProjectPermissions(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): ProjectPermissionsResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  return {
    projectId,
    canManage: canManageProjectAccess(membership),
    permissions: membership.permissions,
    overrides: toOverrides(orm, project),
  };
}

/** A member's effective permissions in the project (any member who can see it may ask). */
export function getMemberProjectPermissions(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  userId: string,
): MemberProjectPermissions {
  const { orm } = deps.db;
  const { project } = requireProject(orm, actor, projectId);
  requireTeamMember(orm, project.teamId, userId);
  const access = getProjectAccess(orm, userId, projectId);
  return {
    userId,
    canView: access !== null && canViewProject(access),
    permissions: access?.permissions ?? [],
  };
}

/**
 * Sets the override of a team role, project role or member in the project (an empty allow and
 * deny removes it). Without `ADMINISTRATOR`, every permission whose state changes must be one the
 * actor has in the project.
 */
export function setPermissionOverride(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: SetPermissionOverrideInput,
): ProjectPermissionsResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requireManage(membership);
  const info = subjectInfo(orm, project, input.subjectType, input.subjectId);
  if (!info) {
    throw errors.notFound(input.subjectType === 'user' ? 'Member' : 'Role');
  }
  const allow = normalizePermissions(input.allow);
  const deny = normalizePermissions(input.deny);
  const existing = overrideOf(orm, projectId, input.subjectType, input.subjectId);
  const before = {
    allow: normalizePermissions(existing?.allow ?? []),
    deny: normalizePermissions(existing?.deny ?? []),
  };
  const changed = changedOverridePermissions(before, { allow, deny });
  if (changed.length === 0) return getProjectPermissions(deps, actor, projectId);
  requireWithinOwn(
    membership,
    changed,
    'You can only change permissions you have in this project yourself',
  );

  deps.db.write((tx) => {
    const now = new Date();
    if (allow.length === 0 && deny.length === 0) {
      tx.delete(s.projectPermissionOverride)
        .where(eq(s.projectPermissionOverride.id, existing?.id ?? ''))
        .run();
    } else if (existing) {
      tx.update(s.projectPermissionOverride)
        .set({ allow, deny, updatedAt: now })
        .where(eq(s.projectPermissionOverride.id, existing.id))
        .run();
    } else {
      tx.insert(s.projectPermissionOverride)
        .values({
          id: newId(),
          projectId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          allow,
          deny,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    const changes: Changes = {};
    if (changedOverridePermissions({ allow: before.allow, deny: [] }, { allow, deny: [] }).length) {
      changes.allowed = change(labels(before.allow), labels(allow));
    }
    if (changedOverridePermissions({ allow: [], deny: before.deny }, { allow: [], deny }).length) {
      changes.denied = change(labels(before.deny), labels(deny));
    }
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'project.permissions_changed',
      changes,
      meta: {
        name: project.name,
        key: project.key,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subject: info.name,
      },
    });
    emitAfterCommit(tx, accessEvent(project, actor));
  });
  return getProjectPermissions(deps, actor, projectId);
}

export function removePermissionOverride(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  subjectType: OverrideSubjectType,
  subjectId: string,
): ProjectPermissionsResponse {
  return setPermissionOverride(deps, actor, projectId, {
    subjectType,
    subjectId,
    allow: [],
    deny: [],
  });
}

// ---------------------------------------------------------------------------------------------
// Cleanup (called by other modules inside their writes)
// ---------------------------------------------------------------------------------------------

/** Deletes every override of a deleted team role or project role (in any project). */
export function deleteOverridesOf(
  tx: Tx,
  subjectType: Exclude<OverrideSubjectType, 'user'>,
  subjectId: string,
): void {
  tx.delete(s.projectPermissionOverride)
    .where(
      and(
        eq(s.projectPermissionOverride.subjectType, subjectType),
        eq(s.projectPermissionOverride.subjectId, subjectId),
      ),
    )
    .run();
}

/**
 * A member left or was removed from the team: they lose their project roles and their own
 * overrides in the team's projects, so rejoining starts from the team's defaults.
 */
export function clearProjectAccess(tx: Tx, teamId: string, userId: string): void {
  const projectIds = tx
    .select({ id: s.project.id })
    .from(s.project)
    .where(eq(s.project.teamId, teamId))
    .all()
    .map((row) => row.id);
  if (projectIds.length === 0) return;
  const roleIds = tx
    .select({ id: s.projectRole.id })
    .from(s.projectRole)
    .where(inArray(s.projectRole.projectId, projectIds))
    .all()
    .map((row) => row.id);
  if (roleIds.length > 0) {
    tx.delete(s.projectRoleMember)
      .where(
        and(
          eq(s.projectRoleMember.userId, userId),
          inArray(s.projectRoleMember.projectRoleId, roleIds),
        ),
      )
      .run();
  }
  tx.delete(s.projectPermissionOverride)
    .where(
      and(
        inArray(s.projectPermissionOverride.projectId, projectIds),
        eq(s.projectPermissionOverride.subjectType, 'user'),
        eq(s.projectPermissionOverride.subjectId, userId),
      ),
    )
    .run();
}
