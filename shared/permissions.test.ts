import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE_SEED,
  EVERYONE_DEFAULTS,
  EVERYONE_ROLE_SEED,
  PERMISSION_GROUPS,
  PERMISSION_INFO,
  PERMISSIONS,
  canManageRoleWith,
  canModerateMember,
  changedOverridePermissions,
  combineProjectPermissions,
  effectiveProjectPermissions,
  PROJECT_PERMISSIONS,
  TEAM_PERMISSIONS,
  displayRoleColor,
  effectivePermissions,
  hasPermission,
  isPermission,
  normalizePermissions,
  type Permission,
} from './permissions';

describe('permission metadata', () => {
  it('describes every permission in a known group', () => {
    const groups = new Set<string>(PERMISSION_GROUPS.map((g) => g.id));
    for (const permission of PERMISSIONS) {
      const info = PERMISSION_INFO[permission];
      expect(info.label).not.toBe('');
      expect(info.description).not.toBe('');
      expect(groups.has(info.group)).toBe(true);
    }
  });

  it('matches the SPEC @everyone defaults and seeds', () => {
    expect([...EVERYONE_DEFAULTS].sort()).toEqual(
      [
        'VIEW_PROJECT',
        'MANAGE_LABELS',
        'CREATE_ISSUES',
        'CREATE_TASKS',
        'REPLY',
        'UPDATE_TASKS',
        'RESOLVE_ISSUES',
      ].sort(),
    );
    expect(EVERYONE_ROLE_SEED).toMatchObject({ isEveryone: true, position: 0, slug: 'everyone' });
    expect(ADMIN_ROLE_SEED).toMatchObject({ permissions: ['ADMINISTRATOR'], isEveryone: false });
  });
});

describe('normalizePermissions / isPermission', () => {
  it('drops unknown values, dedupes and orders canonically', () => {
    expect(normalizePermissions(['REPLY', 'NOPE', 42, 'ADMINISTRATOR', 'REPLY'])).toEqual([
      'ADMINISTRATOR',
      'REPLY',
    ]);
    expect(isPermission('MANAGE_TEAM')).toBe(true);
    expect(isPermission('manage_team')).toBe(false);
  });
});

describe('effectivePermissions', () => {
  it('unions role permissions', () => {
    expect(
      effectivePermissions({
        isOwner: false,
        rolePermissions: [['REPLY'], ['CREATE_TASKS', 'REPLY'], []],
      }),
    ).toEqual(['CREATE_TASKS', 'REPLY']);
  });

  it('grants everything to owners and administrators', () => {
    expect(effectivePermissions({ isOwner: true, rolePermissions: [] })).toEqual([...PERMISSIONS]);
    expect(effectivePermissions({ isOwner: false, rolePermissions: [['ADMINISTRATOR']] })).toEqual([
      ...PERMISSIONS,
    ]);
  });

  it('hasPermission honours ADMINISTRATOR', () => {
    expect(hasPermission(['REPLY'], 'REPLY')).toBe(true);
    expect(hasPermission(['REPLY'], 'MANAGE_TEAM')).toBe(false);
    expect(hasPermission(['ADMINISTRATOR'], 'MANAGE_TEAM')).toBe(true);
  });
});

describe('anti-escalation', () => {
  const manager = {
    isOwner: false,
    permissions: ['MANAGE_ROLES', 'REPLY', 'CREATE_TASKS'] as const,
  };

  it('allows managing roles whose permissions are a subset of your own', () => {
    expect(canManageRoleWith(manager, ['REPLY'])).toBe(true);
    expect(canManageRoleWith(manager, [])).toBe(true);
    expect(canManageRoleWith(manager, ['REPLY', 'MANAGE_TEAM'])).toBe(false);
  });

  it('never lets non-administrators touch ADMINISTRATOR roles', () => {
    expect(canManageRoleWith(manager, ['ADMINISTRATOR'])).toBe(false);
    expect(
      canManageRoleWith({ isOwner: false, permissions: ['ADMINISTRATOR'] }, ['ADMINISTRATOR']),
    ).toBe(true);
    expect(canManageRoleWith({ isOwner: true, permissions: [] }, ['ADMINISTRATOR'])).toBe(true);
  });

  it('protects the owner and administrators from moderation', () => {
    const owner = { isOwner: true, permissions: [...PERMISSIONS] };
    const admin = { isOwner: false, permissions: ['ADMINISTRATOR'] as const };
    const member = { isOwner: false, permissions: ['REPLY'] as const };
    const moderator = { isOwner: false, permissions: ['MANAGE_MEMBERS'] as const };

    expect(canModerateMember(owner, owner)).toBe(false);
    expect(canModerateMember(admin, owner)).toBe(false);
    expect(canModerateMember(owner, admin)).toBe(true);
    expect(canModerateMember(admin, admin)).toBe(true);
    expect(canModerateMember(moderator, admin)).toBe(false);
    expect(canModerateMember(moderator, member)).toBe(true);
  });
});

describe('displayRoleColor', () => {
  it('uses the highest-positioned role that has a color', () => {
    expect(
      displayRoleColor([
        { position: 0, color: null },
        { position: 2, color: '#ef4444' },
        { position: 5, color: null },
        { position: 3, color: '#22c55e' },
      ]),
    ).toBe('#22c55e');
    expect(displayRoleColor([{ position: 0, color: null }])).toBeNull();
  });
});

describe('project-level permissions', () => {
  it('splits every permission into team-level or project-level (design §3)', () => {
    expect([...TEAM_PERMISSIONS].sort()).toEqual(
      [
        'ADMINISTRATOR',
        'MANAGE_TEAM',
        'MANAGE_ROLES',
        'MANAGE_MEMBERS',
        'CREATE_INVITES',
        'MANAGE_INVITES',
        'MANAGE_PROJECTS',
        'VIEW_AUDIT_LOG',
        'MANAGE_TRASH',
      ].sort(),
    );
    expect([...PROJECT_PERMISSIONS].sort()).toEqual(
      [
        'VIEW_PROJECT',
        'MANAGE_STATUSES',
        'MANAGE_LABELS',
        'CREATE_ISSUES',
        'CREATE_TASKS',
        'REPLY',
        'UPDATE_TASKS',
        'RESOLVE_ISSUES',
        'EDIT_ANY_CONTENT',
        'DELETE_ANY_CONTENT',
        'MENTION_EVERYONE',
        'MANAGE_PROJECT_ACCESS',
      ].sort(),
    );
    expect(TEAM_PERMISSIONS.length + PROJECT_PERMISSIONS.length).toBe(PERMISSIONS.length);
  });

  it('starts from the project-level subset of the team permissions', () => {
    expect(
      effectiveProjectPermissions({
        isOwner: false,
        teamPermissions: ['MANAGE_TEAM', 'VIEW_PROJECT', 'REPLY'],
      }),
    ).toEqual(['VIEW_PROJECT', 'REPLY']);
  });

  it('applies @everyone, then roles (denies before allows), then the user', () => {
    const base = { isOwner: false, teamPermissions: ['VIEW_PROJECT', 'REPLY'] as Permission[] };
    // A role allow beats an @everyone deny.
    expect(
      effectiveProjectPermissions({
        ...base,
        everyone: { allow: [], deny: ['VIEW_PROJECT'] },
        roles: [{ allow: ['VIEW_PROJECT'], deny: [] }],
      }),
    ).toContain('VIEW_PROJECT');
    // A role deny beats an @everyone allow.
    expect(
      effectiveProjectPermissions({
        ...base,
        everyone: { allow: ['CREATE_TASKS'], deny: [] },
        roles: [{ allow: [], deny: ['CREATE_TASKS'] }],
      }),
    ).not.toContain('CREATE_TASKS');
    // Between roles, allows win over denies.
    expect(
      effectiveProjectPermissions({
        ...base,
        roles: [
          { allow: [], deny: ['REPLY'] },
          { allow: ['REPLY'], deny: [] },
        ],
      }),
    ).toContain('REPLY');
    // The user's own override is last: deny beats role allows, allow beats role denies.
    expect(
      effectiveProjectPermissions({
        ...base,
        roles: [{ allow: ['CREATE_ISSUES'], deny: [] }],
        user: { allow: [], deny: ['CREATE_ISSUES', 'REPLY'] },
      }),
    ).toEqual(['VIEW_PROJECT']);
    expect(
      effectiveProjectPermissions({
        ...base,
        roles: [{ allow: [], deny: ['VIEW_PROJECT'] }],
        user: { allow: ['VIEW_PROJECT'], deny: [] },
      }),
    ).toContain('VIEW_PROJECT');
  });

  it('lets owners and administrators bypass overrides', () => {
    const deny = { allow: [], deny: [...PROJECT_PERMISSIONS] };
    expect(effectiveProjectPermissions({ isOwner: true, teamPermissions: [], user: deny })).toEqual(
      [...PROJECT_PERMISSIONS],
    );
    expect(
      effectiveProjectPermissions({
        isOwner: false,
        teamPermissions: ['ADMINISTRATOR'],
        user: deny,
      }),
    ).toEqual([...PROJECT_PERMISSIONS]);
  });

  it('never hides a project from MANAGE_PROJECTS holders', () => {
    expect(
      effectiveProjectPermissions({
        isOwner: false,
        teamPermissions: ['MANAGE_PROJECTS'],
        user: { allow: [], deny: ['VIEW_PROJECT'] },
      }),
    ).toEqual(['VIEW_PROJECT']);
  });

  it('combines team-level and project-level permissions', () => {
    expect(combineProjectPermissions(['MANAGE_TEAM', 'REPLY'], ['VIEW_PROJECT'])).toEqual([
      'MANAGE_TEAM',
      'VIEW_PROJECT',
    ]);
    expect(combineProjectPermissions(['ADMINISTRATOR'], [])).toEqual([...PERMISSIONS]);
  });

  it('lists the permissions whose override state changes', () => {
    expect(
      changedOverridePermissions(
        { allow: ['REPLY'], deny: ['CREATE_TASKS'] },
        { allow: ['REPLY', 'CREATE_ISSUES'], deny: [] },
      ),
    ).toEqual(['CREATE_ISSUES', 'CREATE_TASKS']);
  });
});
