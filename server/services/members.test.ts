import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { memberListResponseSchema, memberSchema } from '@shared/schemas/teams';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createAgent,
  createApiKey,
  createProject,
  createRole,
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
import { getMembership } from './access';
import { assignRole, leaveTeam, listMembers, removeMember, unassignRole } from './members';

let ctx: TestContext;
let owner: UserRow;
let admin: UserRow;
let moderator: UserRow;
let member: UserRow;
let team: CreatedTeam;
let modRole: RoleRow;
let designRole: RoleRow;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive' });
  admin = createUser(ctx.db, { username: 'admin_ada', name: 'Ada' });
  moderator = createUser(ctx.db, { username: 'mod', name: 'Mo' });
  member = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  modRole = createRole(ctx.db, {
    teamId: team.team.id,
    name: 'Moderator',
    slug: 'moderator',
    color: '#3b82f6',
    position: 5,
    permissions: ['MANAGE_MEMBERS', 'MANAGE_LABELS'],
  });
  designRole = createRole(ctx.db, {
    teamId: team.team.id,
    name: 'Design',
    slug: 'design',
    color: '#ec4899',
    position: 3,
    permissions: ['MANAGE_LABELS'],
  });
  addMember(ctx.db, { teamId: team.team.id, userId: admin.id, roleIds: [team.adminRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: moderator.id, roleIds: [modRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function activity(action: string) {
  return ctx.db.orm.select().from(s.activity).where(eq(s.activity.action, action)).all();
}

describe('listMembers', () => {
  it('lists the owner first, then by name, with roles and the display color', async () => {
    assignRole(ctx.deps, actorOf(owner), team.team.id, member.id, designRole.id);
    assignRole(ctx.deps, actorOf(owner), team.team.id, member.id, modRole.id);
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const res = await ctx.app.request(`/api/teams/${team.team.id}/members`, {
      headers: bearer(key),
    });
    const { items } = memberListResponseSchema.parse(await res.json());
    // Mia's key made her agent member ("Mia AI"), which joined with her (agents A).
    expect(items.map((item) => item.user.username)).toEqual([
      'owner',
      'admin_ada',
      'mia',
      'mia-ai',
      'mod',
    ]);
    expect(items.find((item) => item.user.username === 'mia-ai')).toMatchObject({
      user: { name: 'Mia AI', kind: 'agent', agentOwner: { id: member.id, username: 'mia' } },
      roles: [],
    });
    const mia = items.find((item) => item.user.id === member.id);
    expect(mia?.roles.map((role) => role.name)).toEqual(['Moderator', 'Design']);
    expect(mia?.color).toBe('#3b82f6');
    expect(items[0]?.isOwner).toBe(true);
  });

  it('is 404 for non-members', async () => {
    const outsider = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: outsider.id });
    const res = await ctx.app.request(`/api/teams/${team.team.id}/members`, {
      headers: bearer(key),
    });
    expect(res.status).toBe(404);
    expect(() => listMembers(ctx.deps, actorOf(outsider), team.team.id)).toThrow(/not found/);
  });
});

describe('removeMember', () => {
  it('needs Manage members and records the removal', async () => {
    expect(() => removeMember(ctx.deps, actorOf(member), team.team.id, moderator.id)).toThrow(
      /permission to manage members/,
    );
    const project = createProject(ctx.db, { teamId: team.team.id });
    const task = createTask(ctx.db, { project: project.project });
    ctx.db.orm.insert(s.taskAssigneeUser).values({ taskId: task.id, userId: member.id }).run();

    const miaAgent = createAgent(ctx.db, member.id);
    const { key } = createApiKey(ctx.db, { userId: moderator.id });
    // The moderator's key acts as the moderator's agent, which needs the role too (agents A).
    giveAgentOwnerRoles(ctx.db, moderator.id);
    const res = await ctx.app.request(`/api/teams/${team.team.id}/members/${member.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    expect(getMembership(ctx.db.orm, team.team.id, member.id)).toBeNull();
    // Mia's agent went with her.
    expect(getMembership(ctx.db.orm, team.team.id, miaAgent.id)).toBeNull();
    expect(
      ctx.db.orm
        .select()
        .from(s.taskAssigneeUser)
        .where(eq(s.taskAssigneeUser.userId, member.id))
        .all(),
    ).toEqual([]);
    expect(activity('member.removed')[0]?.meta).toMatchObject({
      username: 'mia',
      unassignedTasks: 1,
      agent: 'mia-ai',
    });
    expect(
      events.some((event) => event.type === 'member.left' && event.entityId === member.id),
    ).toBe(true);
  });

  it('never removes the owner; administrators only by administrators; never yourself', () => {
    expect(() => removeMember(ctx.deps, actorOf(admin), team.team.id, owner.id)).toThrow(/owner/);
    expect(() => removeMember(ctx.deps, actorOf(moderator), team.team.id, admin.id)).toThrow(
      /Administrator/,
    );
    expect(() => removeMember(ctx.deps, actorOf(moderator), team.team.id, moderator.id)).toThrow(
      /leave/,
    );
    expect(() =>
      removeMember(ctx.deps, actorOf(admin), team.team.id, createUser(ctx.db).id),
    ).toThrow(/Member not found/);
    removeMember(ctx.deps, actorOf(owner), team.team.id, admin.id);
    expect(getMembership(ctx.db.orm, team.team.id, admin.id)).toBeNull();
  });
});

describe('leaveTeam', () => {
  it('lets members leave, dropping their roles; the owner must transfer first', async () => {
    expect(() => leaveTeam(ctx.deps, actorOf(owner), team.team.id)).toThrow(/transfer ownership/);
    // Membership is the person's: leaving through a key, the key's owner leaves, and the agent
    // with them (agents A).
    const { key } = createApiKey(ctx.db, { userId: moderator.id });
    const agent = createAgent(ctx.db, moderator.id);
    const res = await ctx.app.request(
      `/api/teams/${team.team.id}/leave`,
      json('POST', {}, bearer(key)),
    );
    expect(res.status).toBe(200);
    expect(
      ctx.db.orm.select().from(s.memberRole).where(eq(s.memberRole.userId, moderator.id)).all(),
    ).toEqual([]);
    expect(getMembership(ctx.db.orm, team.team.id, moderator.id)).toBeNull();
    expect(getMembership(ctx.db.orm, team.team.id, agent.id)).toBeNull();
    expect(activity('member.left')[0]).toMatchObject({
      actorId: agent.id,
      entityId: moderator.id,
      meta: { username: 'mod', roles: ['Moderator'], agent: 'mod-ai' },
    });
  });
});

describe('assigning roles', () => {
  it('grants and revokes roles with an audit row listing the role names', async () => {
    const { key } = createApiKey(ctx.db, { userId: moderator.id });
    giveAgentOwnerRoles(ctx.db, moderator.id);
    const put = await ctx.app.request(
      `/api/teams/${team.team.id}/members/${member.id}/roles/${designRole.id}`,
      { method: 'PUT', headers: bearer(key) },
    );
    expect(put.status).toBe(200);
    expect(memberSchema.parse(await put.json()).roles.map((role) => role.name)).toEqual(['Design']);
    expect(activity('member.roles_changed')[0]).toMatchObject({
      entityType: 'member',
      entityId: member.id,
      changes: { roles: { from: [], to: ['Design'] } },
      meta: { added: ['Design'], removed: [] },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['member.updated', 'role.changed']),
    );

    // Granting twice is a no-op.
    assignRole(ctx.deps, actorOf(moderator), team.team.id, member.id, designRole.id);
    expect(activity('member.roles_changed')).toHaveLength(1);

    const del = await ctx.app.request(
      `/api/teams/${team.team.id}/members/${member.id}/roles/${designRole.id}`,
      { method: 'DELETE', headers: bearer(key) },
    );
    expect(memberSchema.parse(await del.json()).roles).toEqual([]);
    expect(activity('member.roles_changed')).toHaveLength(2);
  });

  it('enforces anti-escalation', () => {
    const lead = createRole(ctx.db, {
      teamId: team.team.id,
      name: 'Lead',
      permissions: ['MANAGE_PROJECTS'],
    });
    // Moderator lacks MANAGE_PROJECTS: can't grant Lead, nor Admin.
    expect(() =>
      assignRole(ctx.deps, actorOf(moderator), team.team.id, member.id, lead.id),
    ).toThrow(/permissions you have/);
    expect(() =>
      assignRole(ctx.deps, actorOf(moderator), team.team.id, member.id, team.adminRole.id),
    ).toThrow(/Administrator/);
    // Nor touch an administrator's roles.
    expect(() =>
      assignRole(ctx.deps, actorOf(moderator), team.team.id, admin.id, designRole.id),
    ).toThrow(/Administrator/);
    // Nobody changes the owner's roles …
    expect(() =>
      assignRole(ctx.deps, actorOf(admin), team.team.id, owner.id, designRole.id),
    ).toThrow(/owner/);
    // … except the owner.
    assignRole(ctx.deps, actorOf(owner), team.team.id, owner.id, designRole.id);
    // Members without Manage members can't grant anything, not even to themselves.
    expect(() =>
      assignRole(ctx.deps, actorOf(member), team.team.id, member.id, designRole.id),
    ).toThrow(/permission to manage members/);
    // Administrators can grant anything.
    assignRole(ctx.deps, actorOf(admin), team.team.id, member.id, team.adminRole.id);
    expect(getMembership(ctx.db.orm, team.team.id, member.id)?.permissions).toContain(
      'ADMINISTRATOR',
    );
  });

  it('refuses @everyone and unknown roles', () => {
    expect(() =>
      assignRole(ctx.deps, actorOf(owner), team.team.id, member.id, team.everyoneRole.id),
    ).toThrow(/@everyone/);
    expect(() => unassignRole(ctx.deps, actorOf(owner), team.team.id, member.id, 'nope')).toThrow(
      /Role not found/,
    );
  });
});
