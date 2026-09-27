import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import { LIMITS } from '@shared/constants';
import {
  canManageRoleWith,
  normalizePermissions,
  PERMISSION_INFO,
  type Permission,
} from '@shared/permissions';
import {
  slugify,
  type CreateRoleInput,
  type ReorderRolesInput,
  type Role,
  type RoleListResponse,
  type UpdateRoleInput,
} from '@shared/schemas/teams';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { change, diffFields, hasChanges, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { canManageRole, hasPermission, requirePermission, type Membership } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { deleteOverridesOf } from './projectAccess';
import { unassignFromTasks } from './taskAssignees';
import { memberCounts, requireTeam } from './teams';

/**
 * Roles (SPEC §1.3): list, create, edit (name, color, mentionable, permissions), delete and
 * reorder. `MANAGE_ROLES` plus anti-escalation: without `ADMINISTRATOR` a member may only touch
 * roles whose permissions (before and after) are a subset of their own, never one with
 * `ADMINISTRATOR`. `@everyone` can have its permissions edited but can't be renamed, recolored,
 * made mentionable, deleted or moved.
 */

export type RoleRow = typeof s.role.$inferSelect;

/** Most roles a team can have (besides `@everyone`). */
export const MAX_ROLES = 250;

const EVERYONE_SLUG = 'everyone';

/** Human-readable permission names for audit rows ("Manage team"). */
export function permissionLabels(permissions: readonly Permission[]): string[] {
  return normalizePermissions(permissions).map((permission) => PERMISSION_INFO[permission].label);
}

/** Every role of the team, highest position first (`@everyone` last). */
export function teamRoles(db: DbExecutor, teamId: string): RoleRow[] {
  return db
    .select()
    .from(s.role)
    .where(eq(s.role.teamId, teamId))
    .orderBy(desc(s.role.position), desc(s.role.createdAt))
    .all()
    .sort((a, b) => Number(a.isEveryone) - Number(b.isEveryone));
}

/** A role of the team, or 404. */
export function requireRole(db: DbExecutor, teamId: string, roleId: string): RoleRow {
  const role = db
    .select()
    .from(s.role)
    .where(and(eq(s.role.id, roleId), eq(s.role.teamId, teamId)))
    .get();
  if (!role) throw errors.notFound('Role');
  return role;
}

function roleMemberCounts(db: DbExecutor, teamId: string): Map<string, number> {
  const rows = db
    .select({ roleId: s.memberRole.roleId, value: count() })
    .from(s.memberRole)
    .where(eq(s.memberRole.teamId, teamId))
    .groupBy(s.memberRole.roleId)
    .all();
  return new Map(rows.map((row) => [row.roleId, row.value]));
}

function toRoles(db: DbExecutor, teamId: string, rows: readonly RoleRow[]): Role[] {
  const counts = roleMemberCounts(db, teamId);
  const everyone = memberCounts(db, [teamId]).get(teamId) ?? 0;
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    slug: row.slug,
    color: row.color,
    position: row.position,
    permissions: normalizePermissions(row.permissions),
    mentionable: row.mentionable,
    isEveryone: row.isEveryone,
    memberCount: row.isEveryone ? everyone : (counts.get(row.id) ?? 0),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

function toRole(db: DbExecutor, row: RoleRow): Role {
  const [role] = toRoles(db, row.teamId, [row]);
  if (!role) throw errors.internal();
  return role;
}

/**
 * A slug for `name` that no other role of the team uses: `frontend`, else `frontend-2`, …
 * (`everyone` is reserved for `@everyone`; names without letters or digits become `role`).
 */
function uniqueRoleSlug(db: DbExecutor, teamId: string, name: string, exceptRoleId?: string) {
  const base = slugify(name, LIMITS.roleName.max) || 'role';
  const taken = new Set(
    db
      .select({ id: s.role.id, slug: s.role.slug })
      .from(s.role)
      .where(eq(s.role.teamId, teamId))
      .all()
      .filter((role) => role.id !== exceptRoleId)
      .map((role) => role.slug),
  );
  taken.add(EVERYONE_SLUG);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, LIMITS.roleName.max - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function roleEvent(teamId: string, roleId: string, actorId: string) {
  return {
    type: 'role.changed' as const,
    teamId,
    entityType: 'role' as const,
    entityId: roleId,
    actorId,
  };
}

function requireManageRole(
  membership: Membership,
  ...permissionSets: ReadonlyArray<readonly Permission[]>
): void {
  requirePermission(membership, 'MANAGE_ROLES', "You don't have permission to manage roles");
  if (!canManageRole(membership, ...permissionSets)) {
    throw errors.forbidden(
      permissionSets.some((permissions) => permissions.includes('ADMINISTRATOR'))
        ? 'Only administrators can manage roles with the Administrator permission'
        : 'You can only manage roles whose permissions you have yourself',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export function listRoles(deps: AppDeps, actor: Actor, teamId: string): RoleListResponse {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  return { items: toRoles(orm, teamId, teamRoles(orm, teamId)) };
}

export function getRole(deps: AppDeps, actor: Actor, teamId: string, roleId: string): Role {
  const { orm } = deps.db;
  requireTeam(orm, actor, teamId);
  return toRole(orm, requireRole(orm, teamId, roleId));
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

/** Creates a role just above `@everyone` (the bottom of the list, like Discord). */
export function createRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: CreateRoleInput,
): Role {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const permissions = normalizePermissions(input.permissions ?? []);
  requireManageRole(membership, permissions);

  const row = deps.db.write((tx) => {
    const existing = tx
      .select({ value: count() })
      .from(s.role)
      .where(and(eq(s.role.teamId, teamId), eq(s.role.isEveryone, false)))
      .get();
    if ((existing?.value ?? 0) >= MAX_ROLES) {
      throw errors.conflict(`A team can have at most ${MAX_ROLES} roles`);
    }
    tx.update(s.role)
      .set({ position: sql`${s.role.position} + 1` })
      .where(and(eq(s.role.teamId, teamId), gt(s.role.position, 0)))
      .run();
    const now = new Date();
    const role = tx
      .insert(s.role)
      .values({
        id: newId(),
        teamId,
        name: input.name,
        slug: uniqueRoleSlug(tx, teamId, input.name),
        color: input.color ?? null,
        position: 1,
        permissions,
        mentionable: input.mentionable ?? false,
        isEveryone: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'role',
      entityId: role.id,
      action: 'role.created',
      meta: {
        name: role.name,
        slug: role.slug,
        color: role.color,
        mentionable: role.mentionable,
        permissions: permissionLabels(permissions),
      },
    });
    emitAfterCommit(tx, roleEvent(teamId, role.id, actor.userId));
    return role;
  });
  return toRole(orm, row);
}

/**
 * Edits a role. Field changes are audited as `role.updated`, permission changes as
 * `role.permissions_changed` (with the added and removed permissions).
 */
export function updateRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  roleId: string,
  input: UpdateRoleInput,
): Role {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const role = requireRole(orm, teamId, roleId);
  if (
    role.isEveryone &&
    (input.name !== undefined || input.color !== undefined || input.mentionable !== undefined)
  ) {
    throw errors.validation(
      '@everyone can only have its permissions changed: it can’t be renamed, recolored or made mentionable',
    );
  }
  const before = normalizePermissions(role.permissions);
  const after = input.permissions ? normalizePermissions(input.permissions) : before;
  requireManageRole(membership, before, after);

  const fieldChanges: Changes = diffFields(role, {
    name: input.name,
    color: input.color,
    mentionable: input.mentionable,
  });
  const added = after.filter((permission) => !before.includes(permission));
  const removed = before.filter((permission) => !after.includes(permission));
  if (!hasChanges(fieldChanges) && added.length === 0 && removed.length === 0) {
    return toRole(orm, role);
  }

  const row = deps.db.write((tx) => {
    const slug =
      input.name !== undefined && input.name !== role.name
        ? uniqueRoleSlug(tx, teamId, input.name, roleId)
        : role.slug;
    if (slug !== role.slug) fieldChanges.slug = change(role.slug, slug);
    const next = tx
      .update(s.role)
      .set({
        ...(input.name !== undefined ? { name: input.name, slug } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.mentionable !== undefined ? { mentionable: input.mentionable } : {}),
        permissions: after,
        updatedAt: new Date(),
      })
      .where(eq(s.role.id, roleId))
      .returning()
      .get();
    if (hasChanges(fieldChanges)) {
      recordActivity(tx, actor, {
        teamId,
        entityType: 'role',
        entityId: roleId,
        action: 'role.updated',
        changes: fieldChanges,
        meta: { name: next.name, slug: next.slug },
      });
    }
    if (added.length > 0 || removed.length > 0) {
      recordActivity(tx, actor, {
        teamId,
        entityType: 'role',
        entityId: roleId,
        action: 'role.permissions_changed',
        changes: { permissions: change(permissionLabels(before), permissionLabels(after)) },
        meta: { name: next.name, slug: next.slug, added, removed },
      });
    }
    emitAfterCommit(tx, roleEvent(teamId, roleId, actor.userId));
    return next;
  });
  return toRole(orm, row);
}

/**
 * Deletes a role; members lose it and tasks assigned to it lose that assignee (recorded in each
 * task's history).
 */
export function deleteRole(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  roleId: string,
): { ok: true } {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  const role = requireRole(orm, teamId, roleId);
  if (role.isEveryone) throw errors.validation('@everyone can’t be deleted');
  requireManageRole(membership, normalizePermissions(role.permissions));
  const holders = roleMemberCounts(orm, teamId).get(roleId) ?? 0;

  deps.db.write((tx) => {
    const unassignedTasks = unassignFromTasks(tx, actor, teamId, { roleId }, 'role_deleted');
    // member_role rows go with the role (ON DELETE CASCADE); its project overrides go too.
    tx.delete(s.role).where(eq(s.role.id, roleId)).run();
    deleteOverridesOf(tx, 'team_role', roleId);
    tx.update(s.role)
      .set({ position: sql`${s.role.position} - 1` })
      .where(and(eq(s.role.teamId, teamId), gt(s.role.position, role.position)))
      .run();
    recordActivity(tx, actor, {
      teamId,
      entityType: 'role',
      entityId: roleId,
      action: 'role.deleted',
      meta: {
        name: role.name,
        slug: role.slug,
        memberCount: holders,
        unassignedTasks,
        permissions: permissionLabels(normalizePermissions(role.permissions)),
      },
    });
    emitAfterCommit(tx, roleEvent(teamId, roleId, actor.userId));
  });
  return { ok: true };
}

/**
 * Reorders the roles (`roleIds`: every role except `@everyone`, highest first). Without
 * `ADMINISTRATOR`, roles the member can't manage keep their place; the others can be arranged
 * freely around them.
 */
export function reorderRoles(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: ReorderRolesInput,
): RoleListResponse {
  const { orm } = deps.db;
  const { membership } = requireTeam(orm, actor, teamId);
  requirePermission(membership, 'MANAGE_ROLES', "You don't have permission to manage roles");
  const current = teamRoles(orm, teamId).filter((role) => !role.isEveryone);
  const ids = input.roleIds;
  const known = new Set(current.map((role) => role.id));
  if (
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id))
  ) {
    throw errors.validation('List every role except @everyone exactly once, highest first');
  }
  const admin = hasPermission(membership, 'ADMINISTRATOR');
  const subject = { isOwner: membership.isOwner, permissions: membership.permissions };
  current.forEach((role, index) => {
    const manageable = admin || canManageRoleWith(subject, normalizePermissions(role.permissions));
    if (!manageable && ids[index] !== role.id) {
      throw errors.forbidden(`You can't move “${role.name}”: it has permissions you don't have`);
    }
  });
  if (current.every((role, index) => ids[index] === role.id)) {
    return { items: toRoles(orm, teamId, teamRoles(orm, teamId)) };
  }

  const byId = new Map(current.map((role) => [role.id, role]));
  deps.db.write((tx) => {
    const now = new Date();
    ids.forEach((id, index) => {
      tx.update(s.role)
        .set({ position: ids.length - index, updatedAt: now })
        .where(eq(s.role.id, id))
        .run();
    });
    recordActivity(tx, actor, {
      teamId,
      entityType: 'team',
      entityId: teamId,
      action: 'role.reordered',
      changes: {
        order: change(
          current.map((role) => role.name),
          ids.map((id) => byId.get(id)?.name ?? id),
        ),
      },
    });
    emitAfterCommit(tx, roleEvent(teamId, teamId, actor.userId));
  });
  return { items: toRoles(orm, teamId, teamRoles(orm, teamId)) };
}
