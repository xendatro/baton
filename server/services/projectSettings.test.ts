import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelMappingsSchema } from '@shared/schemas/agentRunner';
import {
  myProjectSettingsSchema,
  type ProjectNotifications,
} from '@shared/schemas/projectSettings';
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
  updateMyProjectSettings,
  wantsNotification,
} from './projectSettings';

/**
 * Your settings for one project (BAT-29): notification overrides that fall back to the account's
 * wherever notifications are created, your agent's notification level there, and your agent's
 * default model chain there.
 */

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let api: CreatedProject;
let web2: CreatedProject;

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  team = createTeam(ctx.db, { ownerId: ethan.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  api = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  web2 = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
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

describe('wantsNotification', () => {
  const override = (patch: Partial<ProjectNotifications>): ProjectNotifications => ({
    level: 'all',
    kinds: { replies: true, roleMentions: true, issueStatus: true, stages: true },
    ...patch,
  });

  it('lets everything through without an override (the account default)', () => {
    for (const type of ['mention', 'reply', 'issue_resolved', 'stage_entered'] as const) {
      expect(wantsNotification(null, type)).toBe(true);
    }
  });

  it('applies the level, the per-kind switches and always-delivered requests', () => {
    const mentions = override({ level: 'mentions' });
    expect(wantsNotification(mentions, 'mention')).toBe(true);
    expect(wantsNotification(mentions, 'assigned')).toBe(true);
    expect(wantsNotification(mentions, 'reply')).toBe(false);
    const none = override({ level: 'none' });
    expect(wantsNotification(none, 'mention')).toBe(false);
    expect(wantsNotification(none, 'agent_action_request', true)).toBe(true);
    const quiet = override({
      kinds: { replies: false, roleMentions: true, issueStatus: false, stages: false },
    });
    expect(wantsNotification(quiet, 'reply')).toBe(false);
    expect(wantsNotification(quiet, 'issue_reopened')).toBe(false);
    expect(wantsNotification(quiet, 'task_done')).toBe(false);
    expect(wantsNotification(quiet, 'mention')).toBe(true);
    expect(wantsNotification(quiet, 'role_mention')).toBe(true);
  });
});

describe('notification overrides', () => {
  it('start empty: the account defaults apply and nothing changes', () => {
    const settings = getMyProjectSettings(ctx.deps, person(mia), api.project.id);
    expect(settings).toMatchObject({
      notifications: null,
      agentNotifications: null,
      models: { chain: [] },
      defaults: { notifications: { level: 'all' }, agentNotifications: 'needs_me' },
    });
    const task = followedTask(api);
    say(person(ethan), task.id, 'a reply');
    expect(inbox(mia)).toEqual(['reply']);
  });

  it('resolve project override → account default, per project', () => {
    const task = followedTask(api);
    const other = followedTask(web2);
    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, {
      notifications: { level: 'mentions' },
    });

    say(person(ethan), task.id, 'a plain reply');
    expect(inbox(mia)).toEqual([]);
    say(person(ethan), task.id, '@mia over to you');
    expect(inbox(mia)).toEqual(['mention']);
    // Another project keeps the account's settings.
    clearInbox();
    say(person(ethan), other.id, 'a plain reply');
    expect(inbox(mia)).toEqual(['reply']);

    // Nothing at all.
    clearInbox();
    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, {
      notifications: { level: 'none' },
    });
    say(person(ethan), task.id, '@mia still there?');
    expect(inbox(mia)).toEqual([]);

    // All activity without replies.
    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, {
      notifications: { level: 'all', kinds: { replies: false } },
    });
    say(person(ethan), task.id, 'another reply');
    expect(inbox(mia)).toEqual([]);
    say(person(ethan), task.id, '@mia and a mention');
    expect(inbox(mia)).toEqual(['mention']);

    // Back to my defaults: the row goes.
    clearInbox();
    const reset = updateMyProjectSettings(ctx.deps, person(mia), api.project.id, {
      notifications: null,
    });
    expect(reset.notifications).toBeNull();
    expect(ctx.db.orm.select().from(s.projectMemberSettings).all()).toEqual([]);
    say(person(ethan), task.id, 'reply again');
    expect(inbox(mia)).toEqual(['reply']);
  });

  it('set the agent notification level per project', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: mia.id, name: 'MSI' });
    const miaAgent = agentActor(ctx.db, mia.id, { id: apiKey.id, name: apiKey.name });
    const task = followedTask(api);
    const other = followedTask(web2);

    // needs_me (the account's): her agent's plain reply doesn't reach her.
    say(miaAgent, task.id, 'a plain reply');
    expect(inbox(mia)).toEqual([]);

    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, { agentNotifications: 'all' });
    say(miaAgent, task.id, 'another reply');
    expect(inbox(mia)).toEqual(['reply']);
    clearInbox();
    say(miaAgent, other.id, 'elsewhere');
    expect(inbox(mia)).toEqual([]);

    updateMyProjectSettings(ctx.deps, person(mia), api.project.id, { agentNotifications: 'none' });
    say(miaAgent, task.id, '@mia look');
    expect(inbox(mia)).toEqual([]);
  });
});

describe('GET/PUT /api/projects/:projectId/my-settings', () => {
  async function session(user: UserRow) {
    return web(ctx, await signIn(ctx, user));
  }

  it('reads and saves your default model for the project', async () => {
    const headers = await session(mia);
    const url = `/api/projects/${api.project.id}/my-settings`;

    const saved = await ctx.app.request(
      url,
      json('PUT', { models: { chain: [{ harness: 'codex', effort: 'high' }] } }, headers),
    );
    expect(saved.status).toBe(200);
    expect(myProjectSettingsSchema.parse(await saved.json()).models.chain).toEqual([
      { harness: 'codex', model: '', effort: 'high' },
    ]);
    // The same stored default Automatic agents lists under "Projects with their own default".
    const mappings = modelMappingsSchema.parse(
      await (await ctx.app.request('/api/me/agent/models', { headers })).json(),
    );
    expect(mappings.projects[api.project.id]?.chain[0]?.harness).toBe('codex');

    // Difficulty levels are gone: the old shape isn't a chain.
    const old = await ctx.app.request(
      url,
      json('PUT', { models: { levels: { x: [{ harness: 'claude' }] } } }, headers),
    );
    expect(old.status).toBe(400);

    // Empty: back to my account default (the row stays, without a chain).
    await ctx.app.request(url, json('PUT', { models: { chain: [] } }, headers));
    expect(
      ctx.db.orm.select({ chain: s.agentProjectMapping.chain }).from(s.agentProjectMapping).all(),
    ).toEqual([{ chain: null }]);
    const cleared = modelMappingsSchema.parse(
      await (await ctx.app.request('/api/me/agent/models', { headers })).json(),
    );
    expect(cleared.projects).toEqual({});
  });

  it('is personal and needs only to see the project', async () => {
    const outsider = createUser(ctx.db, { username: 'zed' });
    const headers = await session(outsider);
    const res = await ctx.app.request(`/api/projects/${api.project.id}/my-settings`, { headers });
    expect(res.status).toBe(404);

    // A plain member (no MANAGE permissions) has their own.
    const miaHeaders = await session(mia);
    const put = await ctx.app.request(
      `/api/projects/${api.project.id}/my-settings`,
      json('PUT', { notifications: { level: 'none' } }, miaHeaders),
    );
    expect(put.status).toBe(200);
    expect(getMyProjectSettings(ctx.deps, person(ethan), api.project.id).notifications).toBeNull();

    // Her agent's key reads its owner's.
    const { apiKey } = createApiKey(ctx.db, { userId: mia.id, name: 'MSI' });
    const miaAgent = agentActor(ctx.db, mia.id, { id: apiKey.id, name: apiKey.name });
    expect(getMyProjectSettings(ctx.deps, miaAgent, api.project.id).notifications?.level).toBe(
      'none',
    );
  });
});
