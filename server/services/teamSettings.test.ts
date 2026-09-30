import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  notificationCountsResponseSchema,
  notificationListResponseSchema,
} from '@shared/schemas/core';
import { myProjectSettingsSchema, myTeamSettingsSchema } from '@shared/schemas/projectSettings';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createReply } from './replies';
import {
  getMyProjectSettings,
  getMyTeamSettings,
  updateMyProjectSettings,
  updateMyTeamSettings,
} from './projectSettings';

/**
 * BAT-34: your notifications per team (project override → team override → account default), and
 * the inbox broken down by team and project (filters and counts).
 */

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let acme: CreatedTeam;
let other: CreatedTeam;
let api: CreatedProject;
let webProject: CreatedProject;
let ops: CreatedProject;

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  acme = createTeam(ctx.db, { ownerId: ethan.id, slug: 'acme' });
  other = createTeam(ctx.db, { ownerId: ethan.id, slug: 'other' });
  addMember(ctx.db, { teamId: acme.team.id, userId: mia.id });
  addMember(ctx.db, { teamId: other.team.id, userId: mia.id });
  api = createProject(ctx.db, { teamId: acme.team.id, key: 'API' });
  webProject = createProject(ctx.db, { teamId: acme.team.id, key: 'WEB' });
  ops = createProject(ctx.db, { teamId: other.team.id, key: 'OPS' });
});

afterEach(() => {
  ctx.close();
});

function inbox(user: UserRow) {
  return ctx.db.orm
    .select({ type: s.notification.type })
    .from(s.notification)
    .where(eq(s.notification.userId, user.id))
    .all()
    .map((row) => row.type);
}

function clearInbox() {
  ctx.db.orm.delete(s.notification).run();
}

/** A task in `project` Mia follows (she replied on it). */
function followedTask(project: CreatedProject) {
  const task = createTask(ctx.db, { project: project.project, authorId: ethan.id });
  createReply(ctx.deps, person(mia), { parentType: 'task', parentId: task.id, body: 'following' });
  clearInbox();
  return task;
}

function say(actor: Actor, taskId: string, body: string) {
  createReply(ctx.deps, actor, { parentType: 'task', parentId: taskId, body });
}

describe('team notification overrides', () => {
  it('resolve project override → team override → account default', () => {
    const inApi = followedTask(api);
    const inWeb = followedTask(webProject);
    const inOps = followedTask(ops);

    // The team is set to Nothing: both of its projects go quiet, the other team doesn't.
    updateMyTeamSettings(ctx.deps, person(mia), acme.team.id, {
      notifications: { level: 'none' },
    });
    say(person(ethan), inApi.id, '@mia a mention');
    say(person(ethan), inWeb.id, 'a reply');
    expect(inbox(mia)).toEqual([]);
    say(person(ethan), inOps.id, 'a reply elsewhere');
    expect(inbox(mia)).toEqual(['reply']);

    // A project override wins over the team's.
    clearInbox();
    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, {
      notifications: { level: 'all' },
    });
    say(person(ethan), inApi.id, 'a reply in API');
    say(person(ethan), inWeb.id, 'a reply in WEB');
    expect(inbox(mia)).toEqual(['reply']);

    // "Use my defaults" in the project now shows (and follows) the team's.
    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, { notifications: null });
    const project = getMyProjectSettings(ctx.deps, person(mia), api.project.id);
    expect(project.defaults.notifications.level).toBe('none');
    expect(project.inherited).toEqual({ notifications: 'team', agentNotifications: 'account' });

    // Back to the account's: the team row goes.
    clearInbox();
    const reset = updateMyTeamSettings(ctx.deps, person(mia), acme.team.id, {
      notifications: null,
    });
    expect(reset.notifications).toBeNull();
    expect(ctx.db.orm.select().from(s.teamMemberSettings).all()).toEqual([]);
    say(person(ethan), inWeb.id, 'reply again');
    expect(inbox(mia)).toEqual(['reply']);
  });

  it('mentions only, team-wide', () => {
    const task = followedTask(webProject);
    updateMyTeamSettings(ctx.deps, person(mia), acme.team.id, {
      notifications: { level: 'mentions' },
    });
    say(person(ethan), task.id, 'a plain reply');
    expect(inbox(mia)).toEqual([]);
    say(person(ethan), task.id, '@mia over to you');
    expect(inbox(mia)).toEqual(['mention']);
  });

  it('set the agent notification level per team, under a project override', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: mia.id, name: 'MSI' });
    const miaAgent = agentActor(ctx.db, mia.id, { id: apiKey.id, name: apiKey.name });
    const inApi = followedTask(api);
    const inOps = followedTask(ops);

    updateMyTeamSettings(ctx.deps, person(mia), acme.team.id, { agentNotifications: 'all' });
    say(miaAgent, inApi.id, 'a plain reply');
    expect(inbox(mia)).toEqual(['reply']);
    clearInbox();
    say(miaAgent, inOps.id, 'elsewhere');
    expect(inbox(mia)).toEqual([]);

    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, { agentNotifications: 'none' });
    say(miaAgent, inApi.id, 'quiet now');
    expect(inbox(mia)).toEqual([]);
  });
});

describe('GET/PUT /api/teams/:teamId/my-settings', () => {
  it('reads and saves your notifications for the team, members only', async () => {
    const headers = web(ctx, await signIn(ctx, mia));
    const url = `/api/teams/${acme.team.id}/my-settings`;
    const read = myTeamSettingsSchema.parse(await (await ctx.app.request(url, { headers })).json());
    expect(read).toMatchObject({
      teamId: acme.team.id,
      notifications: null,
      agentNotifications: null,
      defaults: { notifications: { level: 'all' }, agentNotifications: 'needs_me' },
    });

    const saved = await ctx.app.request(
      url,
      json('PUT', { notifications: { level: 'mentions' }, agentNotifications: 'none' }, headers),
    );
    expect(saved.status).toBe(200);
    expect(myTeamSettingsSchema.parse(await saved.json())).toMatchObject({
      notifications: { level: 'mentions' },
      agentNotifications: 'none',
    });
    // Personal: Ethan's are untouched.
    expect(getMyTeamSettings(ctx.deps, person(ethan), acme.team.id).notifications).toBeNull();
    // A project of the team says where its defaults come from.
    const project = myProjectSettingsSchema.parse(
      await (
        await ctx.app.request(`/api/projects/${api.project.id}/my-settings`, { headers })
      ).json(),
    );
    expect(project.inherited).toEqual({ notifications: 'team', agentNotifications: 'team' });

    const outsider = createUser(ctx.db, { username: 'zed' });
    const outsiderHeaders = web(ctx, await signIn(ctx, outsider));
    expect((await ctx.app.request(url, { headers: outsiderHeaders })).status).toBe(404);
  });
});

describe('inbox by team and project', () => {
  it('filters the list and counts per team and project', async () => {
    followedTask(api);
    const inApi = followedTask(api);
    const inWeb = followedTask(webProject);
    const inOps = followedTask(ops);
    say(person(ethan), inApi.id, 'one');
    say(person(ethan), inWeb.id, 'two');
    say(person(ethan), inWeb.id, 'three');
    say(person(ethan), inOps.id, 'four');

    const headers = web(ctx, await signIn(ctx, mia));
    const list = async (query: string) =>
      notificationListResponseSchema.parse(
        await (await ctx.app.request(`/api/notifications?${query}`, { headers })).json(),
      ).items;

    expect(await list('')).toHaveLength(4);
    const byTeam = await list(`teamId=${acme.team.id}`);
    expect(byTeam).toHaveLength(3);
    expect(byTeam.every((item) => item.teamId === acme.team.id)).toBe(true);
    const byProject = await list(`projectId=${webProject.project.id}`);
    expect(byProject.map((item) => item.snippet)).toEqual(['three', 'two']);
    expect(byProject.every((item) => item.projectId === webProject.project.id)).toBe(true);
    expect(await list(`teamId=${other.team.id}&projectId=${api.project.id}`)).toEqual([]);

    // Mark one read, then count.
    const [first] = byProject;
    await ctx.app.request(
      '/api/notifications/read',
      json('POST', { ids: [first?.id ?? ''] }, headers),
    );
    const counts = notificationCountsResponseSchema.parse(
      await (await ctx.app.request('/api/notifications/counts', { headers })).json(),
    );
    const sort = <T extends { total: number }>(items: T[]) =>
      [...items].sort((a, b) => b.total - a.total);
    expect(sort(counts.teams)).toEqual([
      { teamId: acme.team.id, total: 3, unread: 2 },
      { teamId: other.team.id, total: 1, unread: 1 },
    ]);
    expect(sort(counts.projects)).toEqual([
      { teamId: acme.team.id, projectId: webProject.project.id, total: 2, unread: 1 },
      { teamId: acme.team.id, projectId: api.project.id, total: 1, unread: 1 },
      { teamId: other.team.id, projectId: ops.project.id, total: 1, unread: 1 },
    ]);

    // "Mark all as read" within a filter touches only that project.
    const marked = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { all: true, projectId: api.project.id }, headers),
    );
    expect(await marked.json()).toEqual({ updated: 1 });
    expect((await list('unread=1')).map((item) => item.snippet).sort()).toEqual(['four', 'two']);
    const invalid = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { ids: [first?.id ?? ''], teamId: acme.team.id }, headers),
    );
    expect(invalid.status).toBe(400);
  });
});
