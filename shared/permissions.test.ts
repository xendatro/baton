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
  capAgentPermissions,
  displayRoleColor,
  effectivePermissions,
  hasPermission,
  isPermission,
  normalizePermissions,
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
        'CREATE_INVITES',
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

describe('capAgentPermissions (agents A)', () => {
  const admin = effectivePermissions({ isOwner: false, rolePermissions: [['ADMINISTRATOR']] });
  const everyone = effectivePermissions({ isOwner: false, rolePermissions: [EVERYONE_DEFAULTS] });

  it('keeps only what both the agent and its owner have', () => {
    expect(capAgentPermissions(admin, everyone)).toEqual(everyone);
    expect(capAgentPermissions(everyone, admin)).toEqual(everyone);
    expect(capAgentPermissions(['REPLY', 'CREATE_TASKS'], ['REPLY', 'MANAGE_LABELS'])).toEqual([
      'REPLY',
    ]);
    expect(hasPermission(capAgentPermissions(everyone, admin), 'MANAGE_TEAM')).toBe(false);
  });

  it('lets ADMINISTRATOR through only when both have it', () => {
    const owner = effectivePermissions({ isOwner: true, rolePermissions: [] });
    expect(capAgentPermissions(owner, admin)).toContain('ADMINISTRATOR');
    expect(capAgentPermissions(owner, everyone)).not.toContain('ADMINISTRATOR');
  });
});
