import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roleListResponseSchema, roleSchema } from '@shared/schemas/teams';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole as createRoleFixture,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  json,
  type CreatedTeam,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createRole, deleteRole, listRoles, reorderRoles, updateRole } from './roles';

let ctx: TestContext;
let owner: UserRow;
let manager: UserRow;
let member: UserRow;
let team: CreatedTeam;
let managerRole: RoleRow;

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  manager = createUser(ctx.db, { username: 'manager' });
  member = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  managerRole = createRoleFixture(ctx.db, {
    teamId: team.team.id,
    name: 'Role manager',
    slug: 'role-manager',
    position: 2,
    permissions: ['MANAGE_ROLES', 'MANAGE_LABELS', 'VIEW_AUDIT_LOG'],
  });
  addMember(ctx.db, { teamId: team.team.id, userId: manager.id, roleIds: [managerRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
});

afterEach(() => {
  ctx.close();
});

function activity(action: string) {
  return ctx.db.orm.select().from(s.activity).where(eq(s.activity.action, action)).all();
}

function names(teamId = team.team.id) {
  return listRoles(ctx.deps, actorOf(owner), teamId).items.map((role) => role.name);
}

describe('listRoles', () => {
  it('lists roles highest first with @everyone last and member counts', async () => {
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const res = await ctx.app.request(`/api/teams/${team.team.id}/roles`, {
      headers: bearer(key),
    });
    const { items } = roleListResponseSchema.parse(await res.json());
    expect(items.map((role) => [role.name, role.memberCount])).toEqual([
      ['Role manager', 1],
      ['Admin', 0],
      // Mia's key made her agent member, which joined with her (agents A).
      ['@everyone', 4],
    ]);
  });
});

describe('createRole', () => {
  it('creates a role at the bottom with a unique slug', async () => {
    const { key } = createApiKey(ctx.db, { userId: manager.id });
    giveAgentOwnerRoles(ctx.db, manager.id);
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/roles`,
      json(
        'POST',
        { name: 'Front End', color: '#3B82F6', permissions: ['MANAGE_LABELS'] },
        bearer(key),
      ),
    );
    expect(res.status).toBe(201);
    const role = roleSchema.parse(await res.json());
    expect(role).toMatchObject({
      slug: 'front-end',
      color: '#3b82f6',
      position: 1,
      mentionable: false,
      permissions: ['MANAGE_LABELS'],
    });
    expect(names()).toEqual(['Role manager', 'Admin', 'Front End', '@everyone']);
    expect(createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'front-end' }).slug).toBe(
      'front-end-2',
    );
    expect(createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'Everyone' }).slug).toBe(
      'everyone-2',
    );
    expect(createRole(ctx.deps, actorOf(owner), team.team.id, { name: '🎨' }).slug).toBe('role');
    expect(activity('role.created')[0]?.meta).toMatchObject({
      name: 'Front End',
      permissions: ['Manage labels'],
    });
  });

  it('needs Manage roles and only grants permissions the creator has', () => {
    expect(() => createRole(ctx.deps, actorOf(member), team.team.id, { name: 'X' })).toThrow(
      /permission to manage roles/,
    );
    expect(() =>
      createRole(ctx.deps, actorOf(manager), team.team.id, {
        name: 'X',
        permissions: ['MANAGE_PROJECTS'],
      }),
    ).toThrow(/permissions you have/);
    expect(() =>
      createRole(ctx.deps, actorOf(manager), team.team.id, {
        name: 'X',
        permissions: ['ADMINISTRATOR'],
      }),
    ).toThrow(/Administrator/);
  });

  it('rejects names starting with @ over REST', async () => {
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    giveAgentOwnerRoles(ctx.db, owner.id);
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/roles`,
      json('POST', { name: '@here' }, bearer(key)),
    );
    expect(res.status).toBe(400);
  });
});

describe('updateRole', () => {
  it('audits field and permission changes separately; the slug follows the name', async () => {
    const role = createRole(ctx.deps, actorOf(owner), team.team.id, {
      name: 'Design',
      permissions: ['MANAGE_LABELS'],
    });
    const { key } = createApiKey(ctx.db, { userId: manager.id });
    giveAgentOwnerRoles(ctx.db, manager.id);
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/roles/${role.id}`,
      json(
        'PATCH',
        {
          name: 'Product design',
          mentionable: true,
          permissions: ['VIEW_AUDIT_LOG', 'MANAGE_ROLES'],
        },
        bearer(key),
      ),
    );
    expect(res.status).toBe(200);
    expect(roleSchema.parse(await res.json())).toMatchObject({
      name: 'Product design',
      slug: 'product-design',
      mentionable: true,
      permissions: ['MANAGE_ROLES', 'VIEW_AUDIT_LOG'],
    });
    expect(activity('role.updated')[0]?.changes).toEqual({
      name: { from: 'Design', to: 'Product design' },
      mentionable: { from: false, to: true },
      slug: { from: 'design', to: 'product-design' },
    });
    expect(activity('role.permissions_changed')[0]).toMatchObject({
      changes: {
        permissions: { from: ['Manage labels'], to: ['Manage roles', 'View audit log'] },
      },
      meta: { added: ['MANAGE_ROLES', 'VIEW_AUDIT_LOG'], removed: ['MANAGE_LABELS'] },
    });
  });

  it('keeps @everyone’s name, color and mentionability, but allows its permissions', () => {
    const everyone = team.everyoneRole.id;
    expect(() =>
      updateRole(ctx.deps, actorOf(owner), team.team.id, everyone, { name: 'All' }),
    ).toThrow(/only have its permissions changed/);
    expect(() =>
      updateRole(ctx.deps, actorOf(owner), team.team.id, everyone, { mentionable: true }),
    ).toThrow(/only have its permissions changed/);
    const updated = updateRole(ctx.deps, actorOf(owner), team.team.id, everyone, {
      permissions: ['REPLY'],
    });
    expect(updated.permissions).toEqual(['REPLY']);
  });

  it('applies anti-escalation to the role before and after the change', () => {
    const lead = createRoleFixture(ctx.db, {
      teamId: team.team.id,
      name: 'Lead',
      permissions: ['MANAGE_PROJECTS'],
    });
    expect(() =>
      updateRole(ctx.deps, actorOf(manager), team.team.id, lead.id, { permissions: [] }),
    ).toThrow(/permissions you have/);
    expect(() =>
      updateRole(ctx.deps, actorOf(manager), team.team.id, team.adminRole.id, { color: '#000000' }),
    ).toThrow(/Administrator/);
    expect(() =>
      updateRole(ctx.deps, actorOf(manager), team.team.id, managerRole.id, {
        permissions: ['MANAGE_ROLES', 'MANAGE_TEAM'],
      }),
    ).toThrow(/permissions you have/);
    // Within their own permissions, fine.
    updateRole(ctx.deps, actorOf(manager), team.team.id, managerRole.id, {
      permissions: ['MANAGE_ROLES'],
    });
  });
});

describe('deleteRole', () => {
  it('removes the role from members and tasks, and compacts positions', () => {
    const role = createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'Temp' });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: member.id, roleId: role.id })
      .run();
    const project = createProject(ctx.db, { teamId: team.team.id });
    const task = createTask(ctx.db, { project: project.project });
    ctx.db.orm.insert(s.taskAssigneeRole).values({ taskId: task.id, roleId: role.id }).run();

    deleteRole(ctx.deps, actorOf(manager), team.team.id, role.id);
    expect(
      ctx.db.orm.select().from(s.memberRole).where(eq(s.memberRole.roleId, role.id)).all(),
    ).toEqual([]);
    expect(ctx.db.orm.select().from(s.taskAssigneeRole).all()).toEqual([]);
    expect(activity('role.deleted')[0]?.meta).toMatchObject({ name: 'Temp', memberCount: 1 });
    const positions = listRoles(ctx.deps, actorOf(owner), team.team.id).items.map(
      (item) => item.position,
    );
    expect(positions).toEqual([2, 1, 0]);
  });

  it('never deletes @everyone, and respects anti-escalation', async () => {
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    giveAgentOwnerRoles(ctx.db, owner.id);
    const res = await ctx.app.request(`/api/teams/${team.team.id}/roles/${team.everyoneRole.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(res.status).toBe(400);
    expect(() => deleteRole(ctx.deps, actorOf(manager), team.team.id, team.adminRole.id)).toThrow(
      /Administrator/,
    );
  });
});

describe('reorderRoles', () => {
  it('reorders every role (except @everyone) and audits the new order', async () => {
    const low = createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'Low' });
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    giveAgentOwnerRoles(ctx.db, owner.id);
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/roles/order`,
      json('PUT', { roleIds: [low.id, team.adminRole.id, managerRole.id] }, bearer(key)),
    );
    expect(res.status).toBe(200);
    expect(roleListResponseSchema.parse(await res.json()).items.map((role) => role.name)).toEqual([
      'Low',
      'Admin',
      'Role manager',
      '@everyone',
    ]);
    expect(activity('role.reordered')[0]?.changes).toEqual({
      order: { from: ['Role manager', 'Admin', 'Low'], to: ['Low', 'Admin', 'Role manager'] },
    });
  });

  it('rejects incomplete lists', () => {
    expect(() =>
      reorderRoles(ctx.deps, actorOf(owner), team.team.id, { roleIds: [managerRole.id] }),
    ).toThrow(/exactly once/);
    expect(() =>
      reorderRoles(ctx.deps, actorOf(owner), team.team.id, {
        roleIds: [managerRole.id, managerRole.id],
      }),
    ).toThrow(/exactly once/);
  });

  it('keeps roles the member cannot manage in place', () => {
    const a = createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'A' });
    const b = createRole(ctx.deps, actorOf(owner), team.team.id, { name: 'B' });
    // New roles go to the bottom. Admin is not manageable by the manager.
    expect(names()).toEqual(['Role manager', 'Admin', 'A', 'B', '@everyone']);
    expect(() =>
      reorderRoles(ctx.deps, actorOf(manager), team.team.id, {
        roleIds: [team.adminRole.id, managerRole.id, a.id, b.id],
      }),
    ).toThrow(/can't move “Admin”/);
    reorderRoles(ctx.deps, actorOf(manager), team.team.id, {
      roleIds: [b.id, team.adminRole.id, a.id, managerRole.id],
    });
    expect(names()).toEqual(['B', 'Admin', 'A', 'Role manager', '@everyone']);
  });
});
