/**
 * Team permissions (SPEC §1.3). Roles store a JSON array of these strings; a member's effective
 * permissions are the union of all their roles plus `@everyone`. The team owner and anyone with
 * `ADMINISTRATOR` have every permission (owner-only actions are checked separately by services).
 *
 * Permissions are team-level or project-level (docs/design/agents-and-pipelines.md §3): team-level
 * ones come from team roles only; project-level ones start from team roles ("defaults for
 * projects") and can be overridden per project (`effectiveProjectPermissions`).
 */

export const PERMISSIONS = [
  'ADMINISTRATOR',
  'MANAGE_TEAM',
  'MANAGE_ROLES',
  'MANAGE_MEMBERS',
  'CREATE_INVITES',
  'MANAGE_INVITES',
  'MANAGE_PROJECTS',
  'VIEW_PROJECT',
  'MANAGE_PROJECT_ACCESS',
  'MANAGE_STATUSES',
  'MANAGE_LABELS',
  'CREATE_ISSUES',
  'CREATE_TASKS',
  'REPLY',
  'UPDATE_TASKS',
  'RESOLVE_ISSUES',
  'EDIT_ANY_CONTENT',
  'DELETE_ANY_CONTENT',
  'MANAGE_TRASH',
  'VIEW_AUDIT_LOG',
  'MENTION_EVERYONE',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_GROUPS = [
  { id: 'general', label: 'General' },
  { id: 'membership', label: 'Membership' },
  { id: 'projects', label: 'Projects' },
  { id: 'content', label: 'Issues & tasks' },
  { id: 'moderation', label: 'Moderation' },
] as const;

export type PermissionGroupId = (typeof PERMISSION_GROUPS)[number]['id'];

/** Where a permission applies: the team as a whole, or each project (overridable there). */
export type PermissionScope = 'team' | 'project';

export interface PermissionInfo {
  label: string;
  description: string;
  group: PermissionGroupId;
  scope: PermissionScope;
}

export const PERMISSION_INFO: Readonly<Record<Permission, PermissionInfo>> = {
  ADMINISTRATOR: {
    label: 'Administrator',
    description:
      'Grants every permission below. Owner-only actions (deleting the team, transferring ownership) still require the owner.',
    group: 'general',
    scope: 'team',
  },
  MANAGE_TEAM: {
    label: 'Manage team',
    description: "Edit the team's name, URL slug, description, icon and color.",
    group: 'general',
    scope: 'team',
  },
  VIEW_AUDIT_LOG: {
    label: 'View audit log',
    description: 'See the team-wide audit log. Per-item history is visible to every member.',
    group: 'general',
    scope: 'team',
  },
  MANAGE_ROLES: {
    label: 'Manage roles',
    description:
      'Create, edit, delete and reorder roles whose permissions are all ones you have yourself.',
    group: 'membership',
    scope: 'team',
  },
  MANAGE_MEMBERS: {
    label: 'Manage members',
    description:
      'Assign and remove roles on members (within your own permissions) and remove members.',
    group: 'membership',
    scope: 'team',
  },
  CREATE_INVITES: {
    label: 'Create invites',
    description: 'Create invite links and revoke your own.',
    group: 'membership',
    scope: 'team',
  },
  MANAGE_INVITES: {
    label: 'Manage invites',
    description: "See and revoke everyone's invite links.",
    group: 'membership',
    scope: 'team',
  },
  MANAGE_PROJECTS: {
    label: 'Manage projects',
    description:
      'Create projects, edit their name, key, description, README, icon and color, delete and restore them.',
    group: 'projects',
    scope: 'team',
  },
  VIEW_PROJECT: {
    label: 'View project',
    description:
      'See the project and everything in it. Without it the project is hidden: it is left out of lists, search and dashboards, and links to it are not found.',
    group: 'projects',
    scope: 'project',
  },
  MANAGE_PROJECT_ACCESS: {
    label: 'Manage project access',
    description:
      "Manage a project's roles and permission overrides, within the permissions you have yourself.",
    group: 'projects',
    scope: 'project',
  },
  MANAGE_STATUSES: {
    label: 'Manage statuses',
    description: 'Create, edit, reorder and delete task statuses in projects.',
    group: 'projects',
    scope: 'project',
  },
  MANAGE_LABELS: {
    label: 'Manage labels',
    description: 'Create, edit and delete labels in projects.',
    group: 'projects',
    scope: 'project',
  },
  CREATE_ISSUES: {
    label: 'Create issues',
    description: 'Open new issues.',
    group: 'content',
    scope: 'project',
  },
  CREATE_TASKS: {
    label: 'Create tasks',
    description: 'Create new tasks.',
    group: 'content',
    scope: 'project',
  },
  REPLY: {
    label: 'Reply',
    description: 'Reply to issues and tasks.',
    group: 'content',
    scope: 'project',
  },
  UPDATE_TASKS: {
    label: 'Update tasks',
    description:
      "Change any task's status, priority, assignees, labels, due date, links and dependencies, and claim or release tasks.",
    group: 'content',
    scope: 'project',
  },
  RESOLVE_ISSUES: {
    label: 'Resolve issues',
    description: "Resolve, reopen and label anyone's issues. Authors can always resolve their own.",
    group: 'content',
    scope: 'project',
  },
  EDIT_ANY_CONTENT: {
    label: 'Edit any content',
    description: "Edit other people's issue and task titles and bodies, and their replies.",
    group: 'moderation',
    scope: 'project',
  },
  DELETE_ANY_CONTENT: {
    label: 'Delete any content',
    description: "Delete other people's issues, tasks, replies and attachments.",
    group: 'moderation',
    scope: 'project',
  },
  MANAGE_TRASH: {
    label: 'Manage trash',
    description: "See and restore anyone's deleted items. Authors can always restore their own.",
    group: 'moderation',
    scope: 'team',
  },
  MENTION_EVERYONE: {
    label: 'Mention everyone',
    description: 'Mention @everyone and roles that are not mentionable.',
    group: 'moderation',
    scope: 'project',
  },
};

/** Permissions of the built-in `@everyone` role in a new team. */
export const EVERYONE_DEFAULTS: readonly Permission[] = [
  'VIEW_PROJECT',
  'MANAGE_LABELS',
  'CREATE_ISSUES',
  'CREATE_TASKS',
  'REPLY',
  'UPDATE_TASKS',
  'RESOLVE_ISSUES',
];

export interface RoleSeed {
  name: string;
  slug: string;
  color: string | null;
  /** Higher positions rank higher. `@everyone` is always 0. */
  position: number;
  permissions: readonly Permission[];
  mentionable: boolean;
  isEveryone: boolean;
}

export const EVERYONE_ROLE_SEED: RoleSeed = {
  name: '@everyone',
  slug: 'everyone',
  color: null,
  position: 0,
  permissions: EVERYONE_DEFAULTS,
  mentionable: false,
  isEveryone: true,
};

export const ADMIN_ROLE_SEED: RoleSeed = {
  name: 'Admin',
  slug: 'admin',
  color: '#ef4444',
  position: 1,
  permissions: ['ADMINISTRATOR'],
  mentionable: false,
  isEveryone: false,
};

/** Roles every new team is created with, lowest position first. */
export const TEAM_ROLE_SEEDS: readonly RoleSeed[] = [EVERYONE_ROLE_SEED, ADMIN_ROLE_SEED];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** Canonical order (as in `PERMISSIONS`), deduplicated. Unknown strings are dropped. */
export function normalizePermissions(values: Iterable<unknown>): Permission[] {
  const present = new Set<Permission>();
  for (const value of values) if (isPermission(value)) present.add(value);
  return PERMISSIONS.filter((p) => present.has(p));
}

/** Parses the JSON text stored in `role.permissions`. Malformed input yields no permissions. */
export function parsePermissions(json: string): Permission[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? normalizePermissions(parsed) : [];
  } catch {
    return [];
  }
}

export function serializePermissions(permissions: Iterable<Permission>): string {
  return JSON.stringify(normalizePermissions(permissions));
}

export interface PermissionSubject {
  isOwner: boolean;
  /** Permissions of every role the member has, including `@everyone`. */
  rolePermissions: ReadonlyArray<readonly Permission[]>;
}

/**
 * Effective permissions of a member: the union of their roles. The owner and holders of
 * `ADMINISTRATOR` get the full list (including `ADMINISTRATOR` itself).
 */
export function effectivePermissions(subject: PermissionSubject): Permission[] {
  if (subject.isOwner) return [...PERMISSIONS];
  const union = new Set<Permission>();
  for (const perms of subject.rolePermissions) for (const p of perms) union.add(p);
  if (union.has('ADMINISTRATOR')) return [...PERMISSIONS];
  return PERMISSIONS.filter((p) => union.has(p));
}

/** True when `effective` (an output of `effectivePermissions`) includes `permission`. */
export function hasPermission(effective: readonly Permission[], permission: Permission): boolean {
  return effective.includes('ADMINISTRATOR') || effective.includes(permission);
}

// ---------------------------------------------------------------------------------------------
// Project-level permissions (docs/design/agents-and-pipelines.md §3)
// ---------------------------------------------------------------------------------------------

/** Permissions that come from team roles only. */
export const TEAM_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => PERMISSION_INFO[permission].scope === 'team',
);

/** Permissions that start from team roles and can be overridden per project. */
export const PROJECT_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => PERMISSION_INFO[permission].scope === 'project',
);

const PROJECT_PERMISSION_SET: ReadonlySet<Permission> = new Set(PROJECT_PERMISSIONS);

export function isProjectPermission(value: unknown): value is Permission {
  return isPermission(value) && PROJECT_PERMISSION_SET.has(value);
}

/** An allow/deny pair of a project permission override (project-level permissions only). */
export interface PermissionOverrideSets {
  allow: readonly Permission[];
  deny: readonly Permission[];
}

export interface ProjectPermissionSubject {
  /** The member's effective team permissions (`effectivePermissions`). */
  teamPermissions: readonly Permission[];
  isOwner: boolean;
  /** Override of the team's `@everyone` role in the project, if any. */
  everyone?: PermissionOverrideSets | null;
  /** Overrides of the member's other team roles and of their project roles. */
  roles?: readonly PermissionOverrideSets[];
  /** The member's own override. */
  user?: PermissionOverrideSets | null;
}

/**
 * Effective project-level permissions of a member, Discord-style: the project-level subset of
 * their team permissions, then the `@everyone` override (deny, then allow), then the overrides of
 * their team and project roles (all denies, then all allows), then their own override (deny, then
 * allow). The owner and administrators bypass overrides (every project permission). Holders of
 * `MANAGE_PROJECTS` can always see the project (it can't be hidden from those who manage it).
 */
export function effectiveProjectPermissions(subject: ProjectPermissionSubject): Permission[] {
  if (subject.isOwner || subject.teamPermissions.includes('ADMINISTRATOR')) {
    return [...PROJECT_PERMISSIONS];
  }
  const current = new Set<Permission>(
    subject.teamPermissions.filter((permission) => PROJECT_PERMISSION_SET.has(permission)),
  );
  const apply = (layers: readonly PermissionOverrideSets[]) => {
    for (const layer of layers) for (const p of layer.deny) current.delete(p);
    for (const layer of layers) for (const p of layer.allow) current.add(p);
  };
  if (subject.everyone) apply([subject.everyone]);
  apply(subject.roles ?? []);
  if (subject.user) apply([subject.user]);
  if (subject.teamPermissions.includes('MANAGE_PROJECTS')) current.add('VIEW_PROJECT');
  return PROJECT_PERMISSIONS.filter((p) => current.has(p));
}

/**
 * Combined permissions in a project: the team-level part of `teamPermissions` plus the effective
 * project-level ones. Owners and administrators keep the full list.
 */
export function combineProjectPermissions(
  teamPermissions: readonly Permission[],
  projectPermissions: readonly Permission[],
): Permission[] {
  if (teamPermissions.includes('ADMINISTRATOR')) return [...PERMISSIONS];
  const set = new Set<Permission>([
    ...teamPermissions.filter((p) => !PROJECT_PERMISSION_SET.has(p)),
    ...projectPermissions.filter((p) => PROJECT_PERMISSION_SET.has(p)),
  ]);
  return PERMISSIONS.filter((p) => set.has(p));
}

export type OverrideState = 'allow' | 'inherit' | 'deny';

export function overrideState(sets: PermissionOverrideSets, permission: Permission): OverrideState {
  if (sets.deny.includes(permission)) return 'deny';
  if (sets.allow.includes(permission)) return 'allow';
  return 'inherit';
}

/** Project permissions whose state (allow / inherit / deny) differs between two overrides. */
export function changedOverridePermissions(
  before: PermissionOverrideSets,
  after: PermissionOverrideSets,
): Permission[] {
  return PROJECT_PERMISSIONS.filter(
    (permission) => overrideState(before, permission) !== overrideState(after, permission),
  );
}

export interface ActorPermissions {
  isOwner: boolean;
  permissions: readonly Permission[];
}

/**
 * Anti-escalation: may `actor` create/edit this role, or grant/revoke it on a member?
 * Owners and administrators may touch any role. Everyone else may only touch roles without
 * `ADMINISTRATOR` whose permissions are a subset of their own.
 */
export function canManageRoleWith(
  actor: ActorPermissions,
  rolePermissions: readonly Permission[],
): boolean {
  if (actor.isOwner || actor.permissions.includes('ADMINISTRATOR')) return true;
  if (rolePermissions.includes('ADMINISTRATOR')) return false;
  return rolePermissions.every((p) => actor.permissions.includes(p));
}

/**
 * Anti-escalation for member moderation: nobody may modify or remove the owner, and only
 * owners/administrators may modify or remove a member who has `ADMINISTRATOR`.
 * The caller still has to check the permission for the action itself (e.g. `MANAGE_MEMBERS`).
 */
export function canModerateMember(actor: ActorPermissions, target: ActorPermissions): boolean {
  if (target.isOwner) return false;
  if (actor.isOwner || actor.permissions.includes('ADMINISTRATOR')) return true;
  return !target.permissions.includes('ADMINISTRATOR');
}

/** Color of the member's highest-positioned role that has a color, or null. */
export function displayRoleColor(
  roles: ReadonlyArray<{ position: number; color: string | null }>,
): string | null {
  let best: { position: number; color: string } | null = null;
  for (const role of roles) {
    if (role.color && (!best || role.position > best.position)) {
      best = { position: role.position, color: role.color };
    }
  }
  return best?.color ?? null;
}
