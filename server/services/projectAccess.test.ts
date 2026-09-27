import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  EVERYONE_DEFAULTS,
  PERMISSIONS,
  PROJECT_PERMISSIONS,
  type Permission,
} from '@shared/permissions';
import {
  projectPermissionsResponseSchema,
  projectRoleListResponseSchema,
  projectRoleSchema,
} from '@shared/schemas/projectAccess';
import { meResponseSchema } from '@shared/schemas/core';
import { myTasksQuerySchema } from '@shared/schemas/work';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { liveEvent } from '../lib/eventBus';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { getProjectAccess, visibleProjectIds } from './access';
import { getDashboard } from './dashboard';
import { userEventFilter } from './events';
import { createIssue } from './issues';
import { removeMember } from './members';
import { listMyTasks } from './myWork';
import {
  assignProjectRole,
  createProjectRole,
  deleteProjectRole,
  getProjectPermissions,
  setPermissionOverride,
  unassignProjectRole,
} from './projectAccess';
import { listAllProjects, listTeamProjects } from './projects';
import { resolveProject } from './refs';
import { createReply } from './replies';
import { deleteRole } from './roles';
import { search } from './search';
import { createTeam as createTeamService } from './teams';

let ctx: TestContext;
let owner: UserRow;
let alice: UserRow;
let bob: UserRow;
let team: CreatedTeam;
let dev: ReturnType<typeof createRole>;
let api: CreatedProject;
let web: CreatedProject;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  alice = createUser(ctx.db, { username: 'alice' });
  bob = createUser(ctx.db, { username: 'bob' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  dev = createRole(ctx.db, { teamId: team.team.id, name: 'Dev', slug: 'dev', permissions: [] });
  addMember(ctx.db, { teamId: team.team.id, userId: alice.id, roleIds: [dev.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: bob.id });
  api = createProject(ctx.db, { teamId: team.team.id, key: 'API', name: 'Api' });
  web = createProject(ctx.db, { teamId: team.team.id, key: 'WEB', name: 'Web' });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

/** Writes an override directly (the service is tested separately). */
function override(
  projectId: string,
  subjectType: 'team_role' | 'project_role' | 'user',
  subjectId: string,
  sets: { allow?: Permission[]; deny?: Permission[] },
) {
  ctx.db.orm
    .insert(s.projectPermissionOverride)
    .values({
      projectId,
      subjectType,
      subjectId,
      allow: sets.allow ?? [],
      deny: sets.deny ?? [],
    })
    .onConflictDoUpdate({
      target: [
        s.projectPermissionOverride.projectId,
        s.projectPermissionOverride.subjectType,
        s.projectPermissionOverride.subjectId,
      ],
      set: { allow: sets.allow ?? [], deny: sets.deny ?? [] },
    })
    .run();
}

function projectPermissionsOf(user: { id: string }, projectId = api.project.id) {
  return getProjectAccess(ctx.db.orm, user.id, projectId)?.projectPermissions ?? [];
}

function hide(projectId: string, user: { id: string }) {
  override(projectId, 'user', user.id, { deny: ['VIEW_PROJECT'] });
}

describe('effective project permissions', () => {
  it('start from the project-level part of the team roles', () => {
    const access = getProjectAccess(ctx.db.orm, bob.id, api.project.id);
    expect(access?.projectPermissions).toEqual(
      PROJECT_PERMISSIONS.filter((p) => EVERYONE_DEFAULTS.includes(p)),
    );
    expect(access?.membership.permissions).toEqual(
      PERMISSIONS.filter((p) => EVERYONE_DEFAULTS.includes(p)),
    );
    expect(getProjectAccess(ctx.db.orm, createUser(ctx.db).id, api.project.id)).toBeNull();
  });

  it('applies @everyone, then role overrides (denies before allows), then the member', () => {
    override(api.project.id, 'team_role', team.everyoneRole.id, { deny: ['REPLY'] });
    expect(projectPermissionsOf(bob)).not.toContain('REPLY');
    expect(projectPermissionsOf(bob, web.project.id)).toContain('REPLY');

    // A role allow beats the @everyone deny, only for its holders.
    override(api.project.id, 'team_role', dev.id, { allow: ['REPLY', 'MENTION_EVERYONE'] });
    expect(projectPermissionsOf(alice)).toEqual(
      expect.arrayContaining(['REPLY', 'MENTION_EVERYONE']),
    );
    expect(projectPermissionsOf(bob)).not.toContain('REPLY');

    // Between roles (team and project), allows win over denies.
    const role = createProjectRole(ctx.deps, actorOf(owner), api.project.id, { name: 'Guests' });
    assignProjectRole(ctx.deps, actorOf(owner), api.project.id, role.id, alice.id);
    override(api.project.id, 'project_role', role.id, {
      deny: ['MENTION_EVERYONE', 'CREATE_TASKS'],
    });
    expect(projectPermissionsOf(alice)).toContain('MENTION_EVERYONE');
    expect(projectPermissionsOf(alice)).not.toContain('CREATE_TASKS');

    // A role deny beats an @everyone allow.
    override(api.project.id, 'team_role', team.everyoneRole.id, {
      allow: ['EDIT_ANY_CONTENT'],
      deny: ['REPLY'],
    });
    override(api.project.id, 'team_role', dev.id, {
      allow: ['REPLY', 'MENTION_EVERYONE'],
      deny: ['EDIT_ANY_CONTENT'],
    });
    expect(projectPermissionsOf(bob)).toContain('EDIT_ANY_CONTENT');
    expect(projectPermissionsOf(alice)).not.toContain('EDIT_ANY_CONTENT');

    // The member's own override is applied last, both ways.
    override(api.project.id, 'user', alice.id, { allow: ['CREATE_TASKS'], deny: ['REPLY'] });
    expect(projectPermissionsOf(alice)).toContain('CREATE_TASKS');
    expect(projectPermissionsOf(alice)).not.toContain('REPLY');
  });

  it('keeps team-level permissions from team roles only', () => {
    const managers = createRole(ctx.db, {
      teamId: team.team.id,
      permissions: ['MANAGE_TEAM', 'MANAGE_PROJECTS'],
    });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: bob.id, roleId: managers.id })
      .run();
    hide(api.project.id, bob);
    const access = getProjectAccess(ctx.db.orm, bob.id, api.project.id);
    expect(access?.permissions).toEqual(expect.arrayContaining(['MANAGE_TEAM', 'MANAGE_PROJECTS']));
    // MANAGE_PROJECTS can't be hidden from the project it manages.
    expect(access?.projectPermissions).toContain('VIEW_PROJECT');
  });

  it('lets the owner and administrators bypass every override', () => {
    const everything = { deny: [...PROJECT_PERMISSIONS] };
    override(api.project.id, 'team_role', team.everyoneRole.id, everything);
    override(api.project.id, 'user', owner.id, everything);
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: bob.id, roleId: team.adminRole.id })
      .run();
    override(api.project.id, 'user', bob.id, everything);
    expect(projectPermissionsOf(owner)).toEqual([...PROJECT_PERMISSIONS]);
    expect(projectPermissionsOf(bob)).toEqual([...PROJECT_PERMISSIONS]);
    expect(getProjectAccess(ctx.db.orm, bob.id, api.project.id)?.permissions).toEqual([
      ...PERMISSIONS,
    ]);
    expect(projectPermissionsOf(alice)).toEqual([]);
  });

  it('caps an agent member by its owner in the same project', () => {
    const agent = createUser(ctx.db, { username: 'alice-ai' });
    ctx.db.orm
      .update(s.user)
      .set({ kind: 'agent', agentOwnerId: alice.id })
      .where(eq(s.user.id, agent.id))
      .run();
    addMember(ctx.db, { teamId: team.team.id, userId: agent.id, roleIds: [team.adminRole.id] });
    override(api.project.id, 'user', alice.id, { deny: ['REPLY', 'CREATE_TASKS'] });
    const own = projectPermissionsOf(agent);
    expect(own).not.toContain('REPLY');
    expect(own).not.toContain('CREATE_TASKS');
    expect(own).toContain('CREATE_ISSUES');
    // Owners' extra permissions don't pass to the agent either.
    expect(own).not.toContain('MANAGE_STATUSES');
    // The owner not seeing the project hides it from the agent too.
    hide(api.project.id, alice);
    expect(visibleProjectIds(ctx.db.orm, agent.id)).toEqual([web.project.id]);
  });
});

describe('hidden projects (no VIEW_PROJECT)', () => {
  beforeEach(() => {
    hide(api.project.id, bob);
  });

  it('are left out of /api/me, project lists and ref resolution', async () => {
    const { key } = createApiKey(ctx.db, { userId: bob.id });
    const me = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(key) })).json(),
    );
    const keys = me.teams[0]?.projects.map((project) => project.key);
    expect(keys).toEqual(['WEB']);
    expect(me.teams[0]?.projects[0]?.permissions).toContain('VIEW_PROJECT');

    const aliceKey = createApiKey(ctx.db, { userId: alice.id }).key;
    const aliceMe = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(aliceKey) })).json(),
    );
    expect(aliceMe.teams[0]?.projects.map((project) => project.key)).toEqual(['API', 'WEB']);

    expect(listTeamProjects(ctx.deps, actorOf(bob), team.team.id).items.map((p) => p.key)).toEqual([
      'WEB',
    ]);
    expect(listAllProjects(ctx.deps, actorOf(bob)).items.map((p) => p.key)).toEqual(['WEB']);
    expect(() => resolveProject(ctx.deps, actorOf(bob), 'API')).toThrow(/not found/i);
    expect(() => resolveProject(ctx.deps, actorOf(bob), api.project.id)).toThrow(/not found/i);
    expect(resolveProject(ctx.deps, actorOf(alice), 'API').project.id).toBe(api.project.id);
  });

  it('answer 404 on direct access to the project and its content', async () => {
    const { key } = createApiKey(ctx.db, { userId: bob.id });
    const task = createTask(ctx.db, { project: api.project, authorId: alice.id });
    const issue = createIssue(ctx.deps, actorOf(alice), api.project.id, { title: 'Secret' });
    for (const url of [
      `/api/projects/${api.project.id}`,
      `/api/projects/${api.project.id}/board`,
      `/api/projects/${api.project.id}/labels`,
      `/api/projects/${api.project.id}/roles`,
      `/api/projects/${api.project.id}/permissions`,
      `/api/tasks/${task.id}`,
      `/api/issues/${issue.id}`,
      `/api/replies?parentType=issue&parentId=${issue.id}`,
    ]) {
      const res = await ctx.app.request(url, { headers: bearer(key) });
      expect(res.status, url).toBe(404);
    }
    const reply = await ctx.app.request(
      '/api/replies',
      json('POST', { parentType: 'issue', parentId: issue.id, body: 'hi' }, bearer(key)),
    );
    expect(reply.status).toBe(404);
    const other = await ctx.app.request(`/api/projects/${web.project.id}`, {
      headers: bearer(key),
    });
    expect(other.status).toBe(200);
  });

  it('are left out of search, my tasks and the dashboard', () => {
    createIssue(ctx.deps, actorOf(alice), api.project.id, { title: 'Quasar secret' });
    createIssue(ctx.deps, actorOf(alice), web.project.id, { title: 'Quasar public' });
    const hits = search(ctx.deps, actorOf(bob), {
      q: 'quasar',
      types: ['task', 'issue', 'reply'],
      limit: 20,
    }).results;
    expect(hits.map((hit) => hit.title)).toEqual(['Quasar public']);
    expect(
      search(ctx.deps, actorOf(alice), { q: 'quasar', types: ['issue'], limit: 20 }).results,
    ).toHaveLength(2);

    const hidden = createTask(ctx.db, { project: api.project, authorId: alice.id });
    const shown = createTask(ctx.db, { project: web.project, authorId: alice.id });
    for (const task of [hidden, shown]) {
      ctx.db.orm.insert(s.taskAssigneeUser).values({ taskId: task.id, userId: bob.id }).run();
    }
    const mine = listMyTasks(ctx.deps, actorOf(bob), myTasksQuerySchema.parse({}));
    expect(mine.items.map((item) => item.id)).toEqual([shown.id]);
    expect(() =>
      listMyTasks(ctx.deps, actorOf(bob), myTasksQuerySchema.parse({ projectId: api.project.id })),
    ).toThrow(/not found/i);

    const dashboard = getDashboard(ctx.deps, actorOf(bob), {});
    expect(dashboard.assigned.map((item) => item.id)).toEqual([shown.id]);
    expect(dashboard.teams[0]?.projects.map((project) => project.key)).toEqual(['WEB']);
    expect(dashboard.activity.every((entry) => entry.projectId !== api.project.id)).toBe(true);
    expect(
      getDashboard(ctx.deps, actorOf(alice), {}).activity.some(
        (entry) => entry.projectId === api.project.id,
      ),
    ).toBe(true);
  });

  it('keep their live events and notifications from people who can’t see them', () => {
    const canSee = userEventFilter(ctx.deps, bob.id);
    const event = (projectId: string, type: LiveEvent['type'] = 'task.updated') =>
      liveEvent({
        type,
        teamId: team.team.id,
        projectId,
        entityType: 'task',
        entityId: 't',
        actorId: alice.id,
      });
    expect(canSee(event(api.project.id))).toBe(false);
    expect(canSee(event(web.project.id))).toBe(true);
    expect(canSee(event(api.project.id, 'project_access.changed'))).toBe(true);

    // Showing the project again takes effect on the open connection after the access event.
    ctx.db.orm
      .delete(s.projectPermissionOverride)
      .where(eq(s.projectPermissionOverride.subjectId, bob.id))
      .run();
    expect(canSee(event(api.project.id, 'project_access.changed'))).toBe(true);
    expect(canSee(event(api.project.id))).toBe(true);
    hide(api.project.id, bob);

    const mention = (projectId: string) =>
      createIssue(ctx.deps, actorOf(alice), projectId, { title: 'Ping', body: 'hey @bob' });
    const inbox = () =>
      ctx.db.orm.select().from(s.notification).where(eq(s.notification.userId, bob.id)).all();
    mention(api.project.id);
    expect(inbox()).toHaveLength(0);
    mention(web.project.id);
    expect(inbox()).toHaveLength(1);
  });

  it('hide inbox rows of projects that were hidden later', async () => {
    ctx.db.orm
      .delete(s.projectPermissionOverride)
      .where(eq(s.projectPermissionOverride.subjectId, bob.id))
      .run();
    const issue = createIssue(ctx.deps, actorOf(alice), api.project.id, {
      title: 'Ping',
      body: 'hey @bob',
    });
    createReply(ctx.deps, actorOf(alice), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'again @bob',
    });
    const { key } = createApiKey(ctx.db, { userId: bob.id });
    const count = async () =>
      (
        (await (await ctx.app.request('/api/notifications', { headers: bearer(key) })).json()) as {
          items: unknown[];
        }
      ).items.length;
    expect(await count()).toBeGreaterThan(0);
    hide(api.project.id, bob);
    expect(await count()).toBe(0);
  });
});

describe('project roles', () => {
  async function request(user: UserRow, method: string, url: string, body?: unknown) {
    const { key } = createApiKey(ctx.db, { userId: user.id });
    return ctx.app.request(
      url,
      body === undefined ? { method, headers: bearer(key) } : json(method, body, bearer(key)),
    );
  }

  it('can be created, renamed, reordered, given and deleted through REST (audited, live)', async () => {
    const base = `/api/projects/${api.project.id}/roles`;
    const created = await request(owner, 'POST', base, { name: 'Reviewers', color: '#22c55e' });
    expect(created.status).toBe(201);
    const reviewers = projectRoleSchema.parse(await created.json());
    expect(reviewers).toMatchObject({ slug: 'reviewers', position: 1, members: [] });
    const second = projectRoleSchema.parse(
      await (await request(owner, 'POST', base, { name: 'Reviewers' })).json(),
    );
    expect(second.slug).toBe('reviewers-2');

    const renamed = await request(owner, 'PATCH', `${base}/${second.id}`, { name: 'QA' });
    expect(projectRoleSchema.parse(await renamed.json()).slug).toBe('qa');

    const order = await request(owner, 'PUT', `${base}/order`, {
      roleIds: [second.id, reviewers.id],
    });
    expect(
      projectRoleListResponseSchema.parse(await order.json()).items.map((r) => r.name),
    ).toEqual(['QA', 'Reviewers']);

    const given = await request(owner, 'PUT', `${base}/${reviewers.id}/members/${bob.id}`);
    expect(projectRoleSchema.parse(await given.json()).members.map((m) => m.username)).toEqual([
      'bob',
    ]);
    const outsider = createUser(ctx.db);
    expect(
      (await request(owner, 'PUT', `${base}/${reviewers.id}/members/${outsider.id}`)).status,
    ).toBe(404);
    const taken = await request(owner, 'DELETE', `${base}/${reviewers.id}/members/${bob.id}`);
    expect(projectRoleSchema.parse(await taken.json()).members).toEqual([]);

    expect((await request(owner, 'DELETE', `${base}/${second.id}`)).status).toBe(200);
    const list = projectRoleListResponseSchema.parse(
      await (await request(bob, 'GET', base)).json(),
    );
    expect(list.items.map((role) => role.name)).toEqual(['Reviewers']);

    const actions = ctx.db.orm
      .select({ action: s.activity.action })
      .from(s.activity)
      .where(eq(s.activity.projectId, api.project.id))
      .all()
      .map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'project_role.created',
        'project_role.updated',
        'project_role.reordered',
        'project_role.assigned',
        'project_role.unassigned',
        'project_role.deleted',
      ]),
    );
    expect(events.some((event) => event.type === 'project_access.changed')).toBe(true);
  });

  it('need Manage project access (or Manage projects) and respect anti-escalation', () => {
    expect(() =>
      createProjectRole(ctx.deps, actorOf(alice), api.project.id, { name: 'Nope' }),
    ).toThrow(/permission/);
    // Alice may manage access in API only.
    override(api.project.id, 'user', alice.id, { allow: ['MANAGE_PROJECT_ACCESS'] });
    expect(() =>
      createProjectRole(ctx.deps, actorOf(alice), web.project.id, { name: 'Nope' }),
    ).toThrow(/permission/);
    const role = createProjectRole(ctx.deps, actorOf(alice), api.project.id, { name: 'Crew' });
    assignProjectRole(ctx.deps, actorOf(alice), api.project.id, role.id, bob.id);

    // The owner lets the role mention everyone, which Alice can't do herself.
    setPermissionOverride(ctx.deps, actorOf(owner), api.project.id, {
      subjectType: 'project_role',
      subjectId: role.id,
      allow: ['MENTION_EVERYONE'],
      deny: [],
    });
    expect(() =>
      unassignProjectRole(ctx.deps, actorOf(alice), api.project.id, role.id, bob.id),
    ).toThrow(/Mention everyone/);
    expect(() =>
      assignProjectRole(ctx.deps, actorOf(alice), api.project.id, role.id, alice.id),
    ).toThrow(/permissions you have/);
    expect(() => deleteProjectRole(ctx.deps, actorOf(alice), api.project.id, role.id)).toThrow(
      /permissions you have/,
    );
    expect(() =>
      setPermissionOverride(ctx.deps, actorOf(alice), api.project.id, {
        subjectType: 'team_role',
        subjectId: team.everyoneRole.id,
        allow: ['MENTION_EVERYONE'],
        deny: [],
      }),
    ).toThrow(/you have/);
    // Permissions she has are fine, both ways.
    const result = setPermissionOverride(ctx.deps, actorOf(alice), api.project.id, {
      subjectType: 'team_role',
      subjectId: team.everyoneRole.id,
      allow: [],
      deny: ['CREATE_TASKS'],
    });
    expect(result.overrides[0]).toMatchObject({ subjectName: '@everyone', deny: ['CREATE_TASKS'] });

    // Team MANAGE_PROJECTS can manage access in every project.
    const managers = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_PROJECTS'] });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: bob.id, roleId: managers.id })
      .run();
    expect(getProjectPermissions(ctx.deps, actorOf(bob), web.project.id).canManage).toBe(true);
  });

  it('are lost when the member leaves, and overrides go with deleted roles', () => {
    const role = createProjectRole(ctx.deps, actorOf(owner), api.project.id, { name: 'Crew' });
    assignProjectRole(ctx.deps, actorOf(owner), api.project.id, role.id, bob.id);
    override(api.project.id, 'user', bob.id, { allow: ['MENTION_EVERYONE'] });
    override(api.project.id, 'team_role', dev.id, { deny: ['REPLY'] });
    removeMember(ctx.deps, actorOf(owner), team.team.id, bob.id);
    expect(
      ctx.db.orm
        .select()
        .from(s.projectRoleMember)
        .where(eq(s.projectRoleMember.userId, bob.id))
        .all(),
    ).toEqual([]);
    deleteRole(ctx.deps, actorOf(owner), team.team.id, dev.id);
    expect(ctx.db.orm.select().from(s.projectPermissionOverride).all()).toEqual([]);
  });
});

describe('permission overrides API', () => {
  it('sets, lists and removes overrides of project-level permissions only', async () => {
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const url = `/api/projects/${api.project.id}/permissions`;
    const put = (body: unknown) =>
      ctx.app.request(`${url}/overrides`, json('PUT', body, bearer(key)));

    expect(
      (await put({ subjectType: 'team_role', subjectId: dev.id, allow: ['MANAGE_TEAM'], deny: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await put({
          subjectType: 'team_role',
          subjectId: dev.id,
          allow: ['REPLY'],
          deny: ['REPLY'],
        })
      ).status,
    ).toBe(400);
    const otherTeam = createTeam(ctx.db, { ownerId: owner.id });
    expect(
      (
        await put({
          subjectType: 'team_role',
          subjectId: otherTeam.adminRole.id,
          allow: [],
          deny: ['REPLY'],
        })
      ).status,
    ).toBe(404);

    expect(
      (await put({ subjectType: 'user', subjectId: bob.id, allow: [], deny: ['VIEW_PROJECT'] }))
        .status,
    ).toBe(200);
    const res = await put({
      subjectType: 'team_role',
      subjectId: team.everyoneRole.id,
      allow: ['MANAGE_STATUSES'],
      deny: ['REPLY'],
    });
    const body = projectPermissionsResponseSchema.parse(await res.json());
    expect(body.canManage).toBe(true);
    expect(body.overrides.map((o) => o.subjectName)).toEqual(['@everyone', '@bob']);
    expect(visibleProjectIds(ctx.db.orm, bob.id)).toEqual([web.project.id]);

    const audit = ctx.db.orm
      .select()
      .from(s.activity)
      .where(
        and(
          eq(s.activity.action, 'project.permissions_changed'),
          eq(s.activity.projectId, api.project.id),
        ),
      )
      .all();
    expect(audit.at(-1)).toMatchObject({
      entityType: 'project',
      changes: {
        allowed: { from: [], to: ['Manage statuses'] },
        denied: { from: [], to: ['Reply'] },
      },
      meta: { subject: '@everyone' },
    });

    const removed = await ctx.app.request(`${url}/overrides/user/${bob.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(projectPermissionsResponseSchema.parse(await removed.json()).overrides).toHaveLength(1);
    expect(visibleProjectIds(ctx.db.orm, bob.id).sort()).toEqual(
      [api.project.id, web.project.id].sort(),
    );

    const member = await ctx.app.request(`${url}/members/${bob.id}`, { headers: bearer(key) });
    const memberBody = (await member.json()) as { canView: boolean; permissions: string[] };
    expect(memberBody.canView).toBe(true);
    expect(memberBody.permissions).not.toContain('REPLY');
    expect(memberBody.permissions).toContain('MANAGE_STATUSES');
  });
});

describe('invite default (design §3)', () => {
  it('seeds @everyone with VIEW_PROJECT and without CREATE_INVITES', () => {
    const created = createTeamService(ctx.deps, actorOf(alice), { name: 'Fresh' });
    const everyone = ctx.db.orm
      .select()
      .from(s.role)
      .where(and(eq(s.role.teamId, created.id), eq(s.role.isEveryone, true)))
      .get();
    expect(everyone?.permissions).toContain('VIEW_PROJECT');
    expect(everyone?.permissions).not.toContain('CREATE_INVITES');
  });

  it('migration 0007 moves existing @everyone roles to the new defaults', () => {
    const old: Permission[] = ['CREATE_INVITES', 'MANAGE_LABELS', 'REPLY'];
    ctx.db.orm.update(s.role).set({ permissions: old }).where(eq(s.role.isEveryone, true)).run();
    ctx.db.orm
      .update(s.role)
      .set({ permissions: ['CREATE_INVITES'] })
      .where(eq(s.role.id, dev.id))
      .run();
    const file = path.join(
      import.meta.dirname,
      '..',
      'db',
      'migrations',
      '0007_project_permissions.sql',
    );
    const statement = fs
      .readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .find((part) => part.includes('UPDATE `role`'));
    expect(statement).toBeDefined();
    ctx.db.sqlite.exec(statement ?? '');
    const everyone = ctx.db.orm
      .select()
      .from(s.role)
      .where(eq(s.role.id, team.everyoneRole.id))
      .get();
    expect([...(everyone?.permissions ?? [])].sort()).toEqual(
      ['MANAGE_LABELS', 'REPLY', 'VIEW_PROJECT'].sort(),
    );
    // Other roles keep what they had.
    expect(
      ctx.db.orm.select().from(s.role).where(eq(s.role.id, dev.id)).get()?.permissions,
    ).toEqual(['CREATE_INVITES']);
    // Running it again changes nothing.
    ctx.db.sqlite.exec(statement ?? '');
    expect(
      ctx.db.orm.select().from(s.role).where(eq(s.role.id, team.everyoneRole.id)).get()
        ?.permissions,
    ).toHaveLength(3);
  });
});
