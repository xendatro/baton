import {
  canManageRoleWith,
  canModerateMember,
  effectivePermissions,
  normalizePermissions,
  type ActorPermissions,
  type Permission,
} from '@shared/permissions';
import type { Member, Role } from '@shared/schemas/teams';

/**
 * What the viewer may do to members and roles, mirroring the server's checks (SPEC §1.3
 * anti-escalation) so the UI can disable controls and explain why. The server stays the
 * authority: these only shape the interface.
 */

export interface Viewer extends ActorPermissions {
  userId: string;
}

const has = (viewer: ActorPermissions, permission: Permission) =>
  viewer.permissions.includes('ADMINISTRATOR') || viewer.permissions.includes(permission);

/** A member's effective permissions, from their roles plus `@everyone`. */
export function memberPermissions(member: Member, roles: readonly Role[]): ActorPermissions {
  const byId = new Map(roles.map((role) => [role.id, role]));
  const everyone = roles.find((role) => role.isEveryone)?.permissions ?? [];
  return {
    isOwner: member.isOwner,
    permissions: effectivePermissions({
      isOwner: member.isOwner,
      rolePermissions: [
        everyone,
        ...member.roles.map((role) => byId.get(role.id)?.permissions ?? []),
      ],
    }),
  };
}

/** Why the viewer can't create, edit or delete a role with these permissions, or null. */
export function roleManageRefusal(
  viewer: ActorPermissions,
  ...permissionSets: ReadonlyArray<readonly Permission[]>
): string | null {
  if (!has(viewer, 'MANAGE_ROLES')) return 'You need the Manage roles permission';
  for (const permissions of permissionSets) {
    if (!canManageRoleWith(viewer, normalizePermissions(permissions))) {
      return permissions.includes('ADMINISTRATOR')
        ? 'Only administrators can manage roles with the Administrator permission'
        : 'This role has permissions you don’t have';
    }
  }
  return null;
}

/** Why the viewer can't remove `target` or change their roles, or null. */
export function moderationRefusal(viewer: Viewer, target: ActorPermissions): string | null {
  if (!has(viewer, 'MANAGE_MEMBERS')) return 'You need the Manage members permission';
  if (target.isOwner) return 'Nobody can change or remove the team owner';
  if (!canModerateMember(viewer, target)) {
    return 'Only administrators can manage members who have the Administrator permission';
  }
  return null;
}

/** Why the viewer can't grant or revoke `role` on `target`, or null. */
export function roleAssignRefusal(
  viewer: Viewer,
  role: Pick<Role, 'permissions' | 'isEveryone'>,
  target: ActorPermissions & { userId: string },
): string | null {
  if (role.isEveryone) return 'Every member has @everyone';
  if (viewer.isOwner && target.userId === viewer.userId) return null;
  const refusal = moderationRefusal(viewer, target);
  if (refusal) return refusal;
  if (!canManageRoleWith(viewer, role.permissions)) {
    return role.permissions.includes('ADMINISTRATOR')
      ? 'Only administrators can grant roles with the Administrator permission'
      : 'This role has permissions you don’t have';
  }
  return null;
}

/**
 * Moves `activeId` to the slot of `overId` among the roles the viewer may move; roles they can't
 * manage keep their slots (the server enforces the same rule). Returns the new id order, or null
 * when nothing changes.
 */
export function reorderWithPinned(
  ids: readonly string[],
  movable: (id: string) => boolean,
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId || !movable(activeId)) return null;
  const free = ids.filter(movable);
  const from = free.indexOf(activeId);
  const overIndex = ids.indexOf(overId);
  if (from < 0 || overIndex < 0) return null;
  let to = free.indexOf(overId);
  if (to < 0) {
    // Dropped onto a pinned role: pass it, taking the nearest free slot beyond it.
    const down = overIndex > ids.indexOf(activeId);
    const beyond = down
      ? ids.slice(overIndex + 1).find(movable)
      : ids.slice(0, overIndex).reverse().find(movable);
    to = beyond === undefined ? from : free.indexOf(beyond);
  }
  if (to < 0 || from === to) return null;
  const moved = [...free];
  const [item] = moved.splice(from, 1);
  if (item === undefined) return null;
  moved.splice(Math.min(to, moved.length), 0, item);
  let next = 0;
  return ids.map((id) => (movable(id) ? (moved[next++] ?? id) : id));
}
