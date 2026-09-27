import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { issueListResponseSchema } from '@shared/schemas/issues';
import { boardResponseSchema, taskListResponseSchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createIssue } from './issues';
import { unreadNotificationCount } from './notifications';
import { createReply, deleteReply } from './replies';
import { createTask, getTask } from './tasks';

/**
 * BAT-15: marking the notifications about a task or issue (and its replies) read when it is
 * opened. BAT-16: the viewer's unread count per item on the board, the task list and the issue
 * list.
 */

let ctx: TestContext;
let leo: UserRow;
let maya: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let mayaKey: string;
let events: LiveEvent[];

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  const owner = createUser(ctx.db, { username: 'owner' });
  leo = createUser(ctx.db, { username: 'leo' });
  maya = createUser(ctx.db, { username: 'maya' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: leo.id, roleIds: [team.adminRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: maya.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  mayaKey = createApiKey(ctx.db, { userId: maya.id }).key;
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => ctx.close());

function markItem(item: { type: 'task' | 'issue'; id: string }, key = mayaKey) {
  return ctx.app.request('/api/notifications/read', json('POST', { item }, bearer(key)));
}

/** A task assigned to maya (1 notification) with a reply mentioning her (1 more). */
function taskWithTwoUnread(title: string) {
  const task = createTask(ctx.deps, web(leo), project.project.id, {
    title,
    assigneeUserIds: [maya.id],
  });
  const reply = createReply(ctx.deps, web(leo), {
    parentType: 'task',
    parentId: task.id,
    body: '@maya can you look?',
  });
  return { task, reply };
}

describe('mark read by item (BAT-15)', () => {
  it('marks the notifications about a task and its replies, and nothing else', async () => {
    const { task } = taskWithTwoUnread('Fix login');
    const other = createTask(ctx.deps, web(leo), project.project.id, {
      title: 'Other',
      assigneeUserIds: [maya.id],
    });
    // Leo's own notification about the task stays unread: read state is personal.
    createReply(ctx.deps, web(maya), { parentType: 'task', parentId: task.id, body: '@leo ok' });
    const mayaBefore = unreadNotificationCount(ctx.deps, web(maya));
    const leoBefore = unreadNotificationCount(ctx.deps, web(leo));
    expect(mayaBefore).toBe(3);
    expect(leoBefore).toBeGreaterThan(0);

    events = [];
    const res = await markItem({ type: 'task', id: task.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    expect(unreadNotificationCount(ctx.deps, web(maya))).toBe(1);
    expect(unreadNotificationCount(ctx.deps, web(leo))).toBe(leoBefore);

    // A personal event names the item, so maya's other tabs refresh the badge and the inbox.
    expect(events).toEqual([
      expect.objectContaining({
        type: 'notification.read',
        userId: maya.id,
        teamId: team.team.id,
        projectId: project.project.id,
        parentType: 'task',
        parentId: task.id,
      }),
    ]);

    // Nothing left to mark: no change and no event.
    events = [];
    expect(await (await markItem({ type: 'task', id: task.id })).json()).toEqual({ updated: 0 });
    expect(events).toEqual([]);

    expect(await (await markItem({ type: 'task', id: other.id })).json()).toEqual({ updated: 1 });
    expect(unreadNotificationCount(ctx.deps, web(maya))).toBe(0);
  });

  it('marks an issue’s mentions and reply notifications', async () => {
    const issue = createIssue(ctx.deps, web(leo), project.project.id, {
      title: 'Crash',
      body: 'Seen by @maya',
    });
    createReply(ctx.deps, web(leo), {
      parentType: 'issue',
      parentId: issue.id,
      body: '@maya more logs',
    });
    expect(unreadNotificationCount(ctx.deps, web(maya))).toBe(2);
    // A task id with the issue type matches nothing.
    const { task } = taskWithTwoUnread('Unrelated');
    expect(await (await markItem({ type: 'issue', id: task.id })).json()).toEqual({ updated: 0 });
    expect(await (await markItem({ type: 'issue', id: issue.id })).json()).toEqual({ updated: 2 });
    expect(unreadNotificationCount(ctx.deps, web(maya))).toBe(2);
  });

  it('accepts exactly one of ids, all and item', async () => {
    const res = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { all: true, item: { type: 'task', id: 'x' } }, bearer(mayaKey)),
    );
    expect(res.status).toBe(400);
    const bad = await markItem({ type: 'project' as 'task', id: 'x' });
    expect(bad.status).toBe(400);
  });

  it('emits a read event per project when marking all', async () => {
    taskWithTwoUnread('One');
    const second = createProject(ctx.db, {
      teamId: team.team.id,
      key: 'WEB',
      createdById: leo.id,
    });
    createTask(ctx.deps, web(leo), second.project.id, {
      title: 'Two',
      assigneeUserIds: [maya.id],
    });
    events = [];
    const res = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { all: true }, bearer(mayaKey)),
    );
    expect(await res.json()).toEqual({ updated: 3 });
    const reads = events.filter((event) => event.type === 'notification.read');
    expect(reads.map((event) => event.projectId).sort()).toEqual(
      [project.project.id, second.project.id].sort(),
    );
    expect(reads.every((event) => event.userId === maya.id && !event.parentId)).toBe(true);
  });

  it('names the item on notification.created events, including reply notifications', () => {
    const { task, reply } = taskWithTwoUnread('Events');
    const created = events.filter(
      (event) => event.type === 'notification.created' && event.userId === maya.id,
    );
    expect(created).toHaveLength(2);
    for (const event of created) {
      expect(event).toMatchObject({
        projectId: project.project.id,
        parentType: 'task',
        parentId: task.id,
      });
    }
    expect(reply.parentId).toBe(task.id);
  });

  it('does not mark anything read when an agent reads the task', () => {
    const { task } = taskWithTwoUnread('Agent reads');
    const { apiKey } = createApiKey(ctx.db, { userId: maya.id, name: 'Claude' });
    getTask(ctx.deps, { userId: maya.id, source: 'mcp', key: apiKey }, task.id);
    expect(unreadNotificationCount(ctx.deps, web(maya))).toBe(2);
  });
});

describe('unread counts on lists (BAT-16)', () => {
  it('counts the viewer’s unread notifications per task on the board and the list', async () => {
    const { task, reply } = taskWithTwoUnread('Counted');
    const quiet = createTask(ctx.deps, web(leo), project.project.id, { title: 'Quiet' });
    const headers = bearer(mayaKey);

    const board = async () => {
      const res = await ctx.app.request(`/api/projects/${project.project.id}/board`, { headers });
      const cards = boardResponseSchema.parse(await res.json()).columns.flatMap((c) => c.tasks);
      return Object.fromEntries(cards.map((card) => [card.id, card.unreadCount]));
    };
    const list = async () => {
      const res = await ctx.app.request(`/api/projects/${project.project.id}/tasks`, { headers });
      const { items } = taskListResponseSchema.parse(await res.json());
      return Object.fromEntries(items.map((card) => [card.id, card.unreadCount]));
    };

    expect(await board()).toEqual({ [task.id]: 2, [quiet.id]: 0 });
    expect(await list()).toEqual({ [task.id]: 2, [quiet.id]: 0 });

    // Another viewer sees their own counts.
    const leoKey = createApiKey(ctx.db, { userId: leo.id }).key;
    const leoBoard = await ctx.app.request(`/api/projects/${project.project.id}/board`, {
      headers: bearer(leoKey),
    });
    const leoCards = boardResponseSchema
      .parse(await leoBoard.json())
      .columns.flatMap((c) => c.tasks);
    expect(leoCards.map((card) => card.unreadCount)).toEqual([0, 0]);

    // A deleted reply's notification no longer counts; reading the item clears the rest.
    deleteReply(ctx.deps, web(leo), reply.id);
    expect(await board()).toEqual({ [task.id]: 1, [quiet.id]: 0 });
    await markItem({ type: 'task', id: task.id });
    expect(await list()).toEqual({ [task.id]: 0, [quiet.id]: 0 });
  });

  it('counts unread notifications per issue on the issue list', async () => {
    const issue = createIssue(ctx.deps, web(leo), project.project.id, {
      title: 'Crash',
      body: 'Seen by @maya',
    });
    createReply(ctx.deps, web(leo), {
      parentType: 'issue',
      parentId: issue.id,
      body: '@maya more logs',
    });
    const quiet = createIssue(ctx.deps, web(leo), project.project.id, { title: 'Quiet' });
    const issues = async () => {
      const res = await ctx.app.request(`/api/projects/${project.project.id}/issues`, {
        headers: bearer(mayaKey),
      });
      const { items } = issueListResponseSchema.parse(await res.json());
      return Object.fromEntries(items.map((item) => [item.id, item.unreadCount]));
    };
    expect(await issues()).toEqual({ [issue.id]: 2, [quiet.id]: 0 });
    await markItem({ type: 'issue', id: issue.id });
    expect(await issues()).toEqual({ [issue.id]: 0, [quiet.id]: 0 });
  });
});
