import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVERYONE_DEFAULTS, PERMISSIONS, type Permission } from '@shared/permissions';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { AppError } from '../lib/errors';
import {
  addMember,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  canAssignRole,
  canDeleteContent,
  canEditContent,
  canManageRole,
  canModerateMember,
  canRestoreContent,
  getMembership,
  listMemberships,
  memberTeamIds,
  requireMember,
  requireOwner,
  requirePermission,
  roleMemberIds,
  teamMemberIds,
  type Membership,
} from './access';

let ctx: TestContext;
let owner: UserRow;
let team: CreatedTeam;

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db);
  team = createTeam(ctx.db, { ownerId: owner.id });
});

afterEach(() => {
  ctx.close();
});

/** A member with a role carrying exactly `permissions` (plus @everyone). */
function memberWith(permissions: Permission[]): Membership {
  const user = createUser(ctx.db);
  const role = createRole(ctx.db, { teamId: team.team.id, permissions });
  addMember(ctx.db, { teamId: team.team.id, userId: user.id, roleIds: [role.id] });
  const membership = getMembership(ctx.db.orm, team.team.id, user.id);
  if (!membership) throw new Error('membership missing');
  return membership;
}

function ownerMembership(): Membership {
  const membership = getMembership(ctx.db.orm, team.team.id, owner.id);
  if (!membership) throw new Error('owner membership missing');
  return membership;
}

function expectAppError(fn: () => unknown, code: string, status: number) {
  try {
    fn();
    expect.unreachable('expected an AppError');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).status).toBe(status);
  }
}

describe('memberships', () => {
  it('gives the owner every permission', () => {
    const m = ownerMembership();
    expect(m.isOwner).toBe(true);
    expect(m.permissions).toEqual([...PERMISSIONS]);
  });

  it('unions @everyone with every assigned role', () => {
    const user = createUser(ctx.db);
    const a = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_TEAM'] });
    const b = createRole(ctx.db, { teamId: team.team.id, permissions: ['VIEW_AUDIT_LOG'] });
    addMember(ctx.db, { teamId: team.team.id, userId: user.id, roleIds: [a.id, b.id] });
    const m = getMembership(ctx.db.orm, team.team.id, user.id);
    expect(m?.isOwner).toBe(false);
    expect(new Set(m?.permissions)).toEqual(
      new Set([...EVERYONE_DEFAULTS, 'MANAGE_TEAM', 'VIEW_AUDIT_LOG']),
    );
    expect(m?.roleIds.sort()).toEqual([a.id, b.id].sort());
  });

  it('follows edits to @everyone', () => {
    const user = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: user.id });
    ctx.db.orm
      .update(s.role)
      .set({ permissions: [] })
      .where(eq(s.role.id, team.everyoneRole.id))
      .run();
    expect(getMembership(ctx.db.orm, team.team.id, user.id)?.permissions).toEqual([]);
  });

  it('gives ADMINISTRATOR holders every permission', () => {
    const m = memberWith(['ADMINISTRATOR']);
    expect(m.permissions).toEqual([...PERMISSIONS]);
    expect(m.isOwner).toBe(false);
  });

  it('treats non-members and deleted teams as not found', () => {
    const outsider = createUser(ctx.db);
    expectAppError(
      () => requireMember(ctx.db.orm, actorOf(outsider), team.team.id),
      'not_found',
      404,
    );
    expectAppError(
      () => requireMember(ctx.db.orm, actorOf(outsider), team.team.id, 'Task'),
      'not_found',
      404,
    );
    expect(requireMember(ctx.db.orm, actorOf(owner), team.team.id).isOwner).toBe(true);
    ctx.db.orm
      .update(s.team)
      .set({ deletedAt: new Date() })
      .where(eq(s.team.id, team.team.id))
      .run();
    expect(getMembership(ctx.db.orm, team.team.id, owner.id)).toBeNull();
    expect(memberTeamIds(ctx.db.orm, owner.id)).toEqual([]);
  });

  it('lists memberships across teams in one call', () => {
    const second = createTeam(ctx.db, { ownerId: createUser(ctx.db).id });
    addMember(ctx.db, { teamId: second.team.id, userId: owner.id, roleIds: [second.adminRole.id] });
    const memberships = listMemberships(ctx.db.orm, owner.id);
    expect(memberships).toHaveLength(2);
    expect(memberships.find((m) => m.teamId === second.team.id)?.permissions).toEqual([
      ...PERMISSIONS,
    ]);
  });

  it('lists team and role members', () => {
    const m = memberWith([]);
    expect(teamMemberIds(ctx.db.orm, team.team.id).sort()).toEqual([owner.id, m.userId].sort());
    expect(roleMemberIds(ctx.db.orm, m.roleIds)).toEqual([m.userId]);
    expect(roleMemberIds(ctx.db.orm, [])).toEqual([]);
  });
});

describe('permission checks', () => {
  it('requirePermission throws forbidden without the permission', () => {
    const m = memberWith([]);
    expect(() => requirePermission(m, 'REPLY')).not.toThrow(); // @everyone default
    expectAppError(() => requirePermission(m, 'VIEW_AUDIT_LOG'), 'forbidden', 403);
    expect(() => requirePermission(memberWith(['ADMINISTRATOR']), 'VIEW_AUDIT_LOG')).not.toThrow();
  });

  it('keeps owner-only actions for the owner, even for administrators', () => {
    expect(() => requireOwner(ownerMembership())).not.toThrow();
    expectAppError(() => requireOwner(memberWith(['ADMINISTRATOR'])), 'forbidden', 403);
  });
});

describe('anti-escalation: roles', () => {
  it('needs MANAGE_ROLES', () => {
    expect(canManageRole(memberWith([]), [])).toBe(false);
    expect(canManageRole(memberWith(['MANAGE_ROLES']), [])).toBe(true);
  });

  it('allows only subsets of the manager’s own permissions', () => {
    const manager = memberWith(['MANAGE_ROLES', 'VIEW_AUDIT_LOG']);
    // @everyone defaults count as the manager's own permissions too.
    expect(canManageRole(manager, ['VIEW_AUDIT_LOG', 'REPLY'])).toBe(true);
    expect(canManageRole(manager, ['VIEW_AUDIT_LOG', 'MANAGE_MEMBERS'])).toBe(false);
    expect(canManageRole(manager, ['MANAGE_ROLES'])).toBe(true);
  });

  it('checks both the current and the new permissions of an edited role', () => {
    const manager = memberWith(['MANAGE_ROLES']);
    // Removing a permission the manager lacks from someone else's role is still touching it.
    expect(canManageRole(manager, ['DELETE_ANY_CONTENT'], [])).toBe(false);
    // Adding one the manager lacks is escalation.
    expect(canManageRole(manager, [], ['DELETE_ANY_CONTENT'])).toBe(false);
    expect(canManageRole(manager, ['REPLY'], ['REPLY', 'CREATE_TASKS'])).toBe(true);
  });

  it('never lets non-administrators touch ADMINISTRATOR roles', () => {
    const everythingButAdmin = PERMISSIONS.filter((p) => p !== 'ADMINISTRATOR');
    const manager = memberWith([...everythingButAdmin]);
    expect(canManageRole(manager, ['ADMINISTRATOR'])).toBe(false);
    expect(canManageRole(manager, [], ['ADMINISTRATOR'])).toBe(false);
    expect(canManageRole(manager, [...everythingButAdmin])).toBe(true);
  });

  it('lets owners and administrators manage any role', () => {
    expect(canManageRole(ownerMembership(), ['ADMINISTRATOR'])).toBe(true);
    expect(canManageRole(memberWith(['ADMINISTRATOR']), ['ADMINISTRATOR'], [...PERMISSIONS])).toBe(
      true,
    );
  });
});

describe('anti-escalation: members', () => {
  const role = (permissions: Permission[], isEveryone = false) => ({ permissions, isEveryone });

  it('never lets anyone moderate the owner', () => {
    const owners = ownerMembership();
    expect(canModerateMember(memberWith(['ADMINISTRATOR']), owners)).toBe(false);
    expect(canModerateMember(owners, owners)).toBe(false);
    expect(canAssignRole(memberWith(['ADMINISTRATOR']), role([]), owners)).toBe(false);
  });

  it('protects administrators from non-administrators', () => {
    const admin = memberWith(['ADMINISTRATOR']);
    const moderator = memberWith(['MANAGE_MEMBERS']);
    expect(canModerateMember(moderator, admin)).toBe(false);
    expect(canModerateMember(memberWith(['ADMINISTRATOR']), admin)).toBe(true);
    expect(canModerateMember(ownerMembership(), admin)).toBe(true);
  });

  it('needs MANAGE_MEMBERS to moderate', () => {
    const plain = memberWith([]);
    expect(canModerateMember(memberWith([]), plain)).toBe(false);
    expect(canModerateMember(memberWith(['MANAGE_MEMBERS']), plain)).toBe(true);
  });

  it('assigns only roles within the assigner’s permissions', () => {
    const moderator = memberWith(['MANAGE_MEMBERS']);
    const target = memberWith([]);
    expect(canAssignRole(moderator, role(['REPLY']), target)).toBe(true);
    expect(canAssignRole(moderator, role(['MANAGE_MEMBERS']), target)).toBe(true);
    expect(canAssignRole(moderator, role(['MANAGE_ROLES']), target)).toBe(false);
    expect(canAssignRole(moderator, role(['ADMINISTRATOR']), target)).toBe(false);
    // Assigning yourself a role you could grant anyway is no escalation.
    expect(canAssignRole(moderator, role(['REPLY']), moderator)).toBe(true);
    expect(canAssignRole(moderator, role(['VIEW_AUDIT_LOG']), moderator)).toBe(false);
  });

  it('never assigns @everyone explicitly', () => {
    expect(canAssignRole(ownerMembership(), role([], true), memberWith([]))).toBe(false);
  });

  it('lets administrators assign ADMINISTRATOR roles', () => {
    expect(
      canAssignRole(memberWith(['ADMINISTRATOR']), role(['ADMINISTRATOR']), memberWith([])),
    ).toBe(true);
  });
});

describe('content ownership', () => {
  it('lets authors edit, delete and restore their own content', () => {
    const author = memberWith([]);
    for (const check of [canEditContent, canDeleteContent, canRestoreContent]) {
      expect(check(author, author.userId)).toBe(true);
      expect(check(author, 'someone-else')).toBe(false);
      expect(check(author, null)).toBe(false);
    }
  });

  it('lets moderators act on anyone’s content with the matching permission', () => {
    expect(canEditContent(memberWith(['EDIT_ANY_CONTENT']), 'x')).toBe(true);
    expect(canDeleteContent(memberWith(['EDIT_ANY_CONTENT']), 'x')).toBe(false);
    expect(canDeleteContent(memberWith(['DELETE_ANY_CONTENT']), 'x')).toBe(true);
    expect(canRestoreContent(memberWith(['MANAGE_TRASH']), 'x')).toBe(true);
    expect(canRestoreContent(memberWith(['DELETE_ANY_CONTENT']), 'x')).toBe(false);
    expect(canEditContent(ownerMembership(), 'x')).toBe(true);
  });
});
