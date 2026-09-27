import { describe, expect, it } from 'vitest';
import { EVERYONE_DEFAULTS, type Permission } from '@shared/permissions';
import type { Member, Role } from '@shared/schemas/teams';
import {
  memberPermissions,
  moderationRefusal,
  reorderWithPinned,
  roleAssignRefusal,
  roleManageRefusal,
  type Viewer,
} from './access';

function role(id: string, permissions: Permission[], extra: Partial<Role> = {}): Role {
  return {
    id,
    teamId: 't',
    name: id,
    slug: id,
    color: null,
    position: 1,
    permissions,
    mentionable: false,
    hoist: false,
    isEveryone: false,
    memberCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const everyone = role('everyone', [...EVERYONE_DEFAULTS], { isEveryone: true, position: 0 });
const admin = role('admin', ['ADMINISTRATOR']);
const mods = role('mods', ['MANAGE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_LABELS']);
const lead = role('lead', ['MANAGE_PROJECTS']);
const roles = [admin, mods, lead, everyone];

function member(id: string, roleIds: string[], isOwner = false): Member {
  return {
    user: { id, username: id, name: id, image: null },
    joinedAt: '2026-01-01T00:00:00.000Z',
    isOwner,
    roles: roleIds.map((roleId) => ({
      id: roleId,
      slug: roleId,
      name: roleId,
      color: null,
      position: 1,
    })),
    color: null,
  };
}

const moderator: Viewer = {
  userId: 'mo',
  ...memberPermissions(member('mo', ['mods']), roles),
};

describe('web anti-escalation helpers', () => {
  it('computes effective permissions from roles plus @everyone', () => {
    expect(memberPermissions(member('x', ['lead']), roles).permissions).toEqual(
      expect.arrayContaining(['MANAGE_PROJECTS', 'REPLY']),
    );
    expect(memberPermissions(member('o', [], true), roles).permissions).toContain('ADMINISTRATOR');
  });

  it('explains why a role or member is out of reach', () => {
    expect(roleManageRefusal(moderator, mods.permissions)).toBeNull();
    expect(roleManageRefusal(moderator, lead.permissions)).toMatch(/don’t have/);
    expect(roleManageRefusal(moderator, admin.permissions)).toMatch(/administrators/);
    const owner = memberPermissions(member('o', [], true), roles);
    expect(moderationRefusal(moderator, owner)).toMatch(/owner/);
    const adminMember = memberPermissions(member('a', ['admin']), roles);
    expect(moderationRefusal(moderator, adminMember)).toMatch(/Administrator/);
    const plain = { userId: 'p', ...memberPermissions(member('p', []), roles) };
    expect(roleAssignRefusal(moderator, mods, plain)).toBeNull();
    expect(roleAssignRefusal(moderator, lead, plain)).toMatch(/don’t have/);
    expect(roleAssignRefusal(moderator, everyone, plain)).toMatch(/@everyone/);
    const ownerViewer: Viewer = { userId: 'o', ...owner };
    expect(roleAssignRefusal(ownerViewer, lead, { userId: 'o', ...owner })).toBeNull();
  });
});

describe('reorderWithPinned', () => {
  const ids = ['a', 'P', 'b', 'c'];
  const movable = (id: string) => id !== 'P';

  it('moves roles among the free slots, keeping pinned ones in place', () => {
    expect(reorderWithPinned(ids, movable, 'c', 'a')).toEqual(['c', 'P', 'a', 'b']);
    expect(reorderWithPinned(ids, movable, 'a', 'c')).toEqual(['b', 'P', 'c', 'a']);
  });

  it('passes a pinned role it is dropped on', () => {
    expect(reorderWithPinned(ids, movable, 'a', 'P')).toEqual(['b', 'P', 'a', 'c']);
    expect(reorderWithPinned(ids, movable, 'c', 'P')).toEqual(['c', 'P', 'a', 'b']);
  });

  it('never moves pinned roles and ignores no-ops', () => {
    expect(reorderWithPinned(ids, movable, 'P', 'a')).toBeNull();
    expect(reorderWithPinned(ids, movable, 'b', 'b')).toBeNull();
  });
});
