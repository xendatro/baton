import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyListResponseSchema, replySchema, type ListRepliesQuery } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { coreTools } from '../mcp/tools/core';
import { registerTools } from '../mcp/tools/index';
import { tasksTools } from '../mcp/tools/tasks';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
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
import { createReply, deleteReply, listReplies, restoreReply } from './replies';
import { ReplyTree, type ReplySkeleton } from './replyTree';
import { setSubscription } from './subscriptions';

/** Threaded replies (BAT-13): answering a reply, the comment tree, placeholders, notifications. */

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
});

afterEach(() => {
  ctx.close();
});

function newTask() {
  return createTask(ctx.db, { project: project.project, authorId: owner.id, title: 'Fix login' });
}

function reply(user: UserRow, taskId: string, body: string, parentReplyId?: string) {
  return createReply(ctx.deps, actorOf(user), {
    parentType: 'task',
    parentId: taskId,
    body,
    parentReplyId,
  });
}

/** Inserts `count` replies straight into the database, one millisecond apart. */
function insertReplies(
  taskId: string,
  count: number,
  parentOf: (index: number, ids: string[]) => string | null,
): string[] {
  const ids: string[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const row = ctx.db.orm
      .insert(s.reply)
      .values({
        teamId: team.team.id,
        projectId: project.project.id,
        parentType: 'task',
        parentId: taskId,
        parentReplyId: parentOf(index, ids),
        authorId: owner.id,
        body: `Reply ${index}`,
        createdAt: new Date(start + index),
        updatedAt: new Date(start + index),
      })
      .returning({ id: s.reply.id })
      .get();
    ids.push(row.id);
  }
  return ids;
}

function tree(taskId: string, view: Omit<ListRepliesQuery, 'parentType' | 'parentId'> = {}) {
  return listReplies(ctx.deps, actorOf(owner), { parentType: 'task', parentId: taskId, ...view });
}

describe('answering a reply', () => {
  it('stores parentReplyId over REST and validates the answered reply', async () => {
    const task = newTask();
    const other = newTask();
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const { key } = createApiKey(ctx.db, { userId: member.id, name: 'Laptop' });
    const top = reply(owner, task.id, 'Top-level');
    const elsewhere = reply(owner, other.id, 'On another task');

    const res = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        { parentType: 'task', parentId: task.id, parentReplyId: top.id, body: 'An answer' },
        bearer(key),
      ),
    );
    expect(res.status).toBe(201);
    const answer = replySchema.parse(await res.json());
    expect(answer.parentReplyId).toBe(top.id);
    expect(top.parentReplyId).toBeNull();

    const post = (parentReplyId: string, parentType = 'task', parentId = task.id) =>
      ctx.app.request(
        '/api/replies',
        json('POST', { parentType, parentId, parentReplyId, body: 'Hi' }, bearer(key)),
      );
    // Another item's reply, a reply of an issue with the same id space, an unknown id.
    expect((await post(elsewhere.id)).status).toBe(400);
    expect((await post(top.id, 'issue', issue.id)).status).toBe(400);
    const unknown = await post('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({
      error: { message: 'You can only answer a reply on this task' },
    });

    deleteReply(ctx.deps, actorOf(owner), top.id);
    const deleted = await post(top.id);
    expect(deleted.status).toBe(409);

    // The activity row names the answered reply.
    const activity = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, answer.id), eq(s.activity.action, 'reply.created')))
      .get();
    expect(activity?.meta).toMatchObject({ parentReplyId: top.id });
  });

  it('lets agents answer a reply with add_reply inReplyTo and shows parentReplyId', async () => {
    const task = newTask();
    const top = reply(owner, task.id, 'Can you look at this?');
    const { apiKey } = createApiKey(ctx.db, { userId: member.id, name: 'Claude' });
    const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
    registerTools(
      server,
      {
        deps: ctx.deps,
        actor: { userId: member.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
      },
      [...coreTools, ...tasksTools],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const added = await client.callTool({
        name: 'add_reply',
        arguments: { item: 'API-1', body: 'Looking now', inReplyTo: top.id },
      });
      expect(added.isError).toBeFalsy();
      const created = added.structuredContent as { id: string; parentReplyId: string | null };
      expect(created.parentReplyId).toBe(top.id);

      const listed = await client.callTool({ name: 'list_replies', arguments: { item: 'API-1' } });
      const replies = (
        listed.structuredContent as { replies: { id: string; parentReplyId: string | null }[] }
      ).replies;
      expect(replies.map((r) => [r.id, r.parentReplyId])).toEqual([
        [top.id, null],
        [created.id, top.id],
      ]);

      const got = await client.callTool({ name: 'get_task', arguments: { task: 'API-1' } });
      const recent = (
        got.structuredContent as { recentReplies: { parentReplyId: string | null }[] }
      ).recentReplies;
      expect(recent.map((r) => r.parentReplyId)).toEqual([null, top.id]);

      const bad = await client.callTool({
        name: 'add_reply',
        arguments: { item: 'API-1', body: 'Nope', inReplyTo: 'missing' },
      });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the comment tree', () => {
  it('nests answers under their parents, oldest first, with counts and depths', async () => {
    const task = newTask();
    const a = reply(owner, task.id, 'A');
    const b = reply(member, task.id, 'B');
    const a1 = reply(member, task.id, 'A1', a.id);
    const a2 = reply(owner, task.id, 'A2', a.id);
    const a1x = reply(owner, task.id, 'A1x', a1.id);

    const { key } = createApiKey(ctx.db, { userId: owner.id, name: 'Laptop' });
    const res = await ctx.app.request(`/api/replies?parentType=task&parentId=${task.id}`, {
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    const body = replyListResponseSchema.parse(await res.json());
    expect(body.items.map((item) => [item.body, item.depth, item.replyCount])).toEqual([
      ['A', 0, 2],
      ['A1', 1, 1],
      ['A1x', 2, 0],
      ['A2', 1, 0],
      ['B', 0, 0],
    ]);
    expect(body.items.find((item) => item.id === a1x.id)?.parentReplyId).toBe(a1.id);
    expect(body).toMatchObject({ total: 5, topLevelCount: 2, ancestors: [] });
    expect(body.items.every((item) => !item.deleted)).toBe(true);

    // One sub-thread ("Continue this thread").
    const focused = tree(task.id, { root: a1.id });
    expect(focused.items.map((item) => [item.body, item.depth])).toEqual([
      ['A1', 0],
      ['A1x', 1],
    ]);
    expect(focused).toMatchObject({ total: 2, topLevelCount: 1, ancestors: [a.id] });
    expect(() => tree(task.id, { root: b.id + 'x' })).toThrow(/not found/);
    expect(a2.parentReplyId).toBe(a.id);
  });

  it('loads the oldest 200 comments first, then more with limit and expand', () => {
    const task = newTask();
    // 150 top-level comments, then 100 answers to the first one.
    const ids = insertReplies(task.id, 250, (index, previous) =>
      index < 150 ? null : (previous[0] ?? null),
    );
    const first = tree(task.id);
    expect(first.items).toHaveLength(200);
    expect(first.total).toBe(250);
    expect(first.topLevelCount).toBe(150);
    const top = first.items.find((item) => item.id === ids[0]);
    expect(top?.replyCount).toBe(100);
    expect(first.items.filter((item) => item.parentReplyId === ids[0])).toHaveLength(50);

    // "N more replies" on the first comment loads the rest of its answers.
    const expanded = tree(task.id, { expand: [ids[0]!] });
    expect(expanded.items.filter((item) => item.parentReplyId === ids[0])).toHaveLength(100);
    expect(tree(task.id, { limit: 1000 }).items).toHaveLength(250);
    // Over REST the ids are comma-separated.
    const parsed = listReplies(ctx.deps, actorOf(owner), {
      parentType: 'task',
      parentId: task.id,
      expand: [ids[0]!, 'unknown'],
    });
    expect(parsed.items).toHaveLength(250);
  });

  it('shows 10 levels, deeper ones through root, and includes a linked reply with its ancestors', async () => {
    const task = newTask();
    const chain = insertReplies(task.id, 14, (index, previous) => previous[index - 1] ?? null);
    const main = tree(task.id);
    expect(main.items.map((item) => item.depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(main.items.at(-1)?.replyCount).toBe(1);

    const deeper = tree(task.id, { root: chain[9] });
    expect(deeper.items.map((item) => item.id)).toEqual(chain.slice(9));
    expect(deeper.ancestors).toEqual(chain.slice(0, 9));

    const linked = tree(task.id, { include: [chain[12]!, 'unknown'] });
    expect(linked.items.map((item) => item.id)).toEqual(chain.slice(0, 13));
    expect(linked.items.at(-1)?.depth).toBe(12);

    const { key } = createApiKey(ctx.db, { userId: owner.id, name: 'Laptop' });
    const res = await ctx.app.request(
      `/api/replies?parentType=task&parentId=${task.id}&expand=${chain[0]},${chain[1]}&limit=5`,
      { headers: bearer(key) },
    );
    expect(res.status).toBe(200);
    const bad = await ctx.app.request(
      `/api/replies?parentType=task&parentId=${task.id}&limit=5000`,
      { headers: bearer(key) },
    );
    expect(bad.status).toBe(400);
  });

  it('keeps deleted replies with answers as placeholders and hides the rest', () => {
    const task = newTask();
    const a = reply(member, task.id, 'Secret parent text');
    const a1 = reply(owner, task.id, 'Answer', a.id);
    const b = reply(member, task.id, 'B');
    const b1 = reply(owner, task.id, 'B1', b.id);
    const c = reply(member, task.id, 'Leaf');

    deleteReply(ctx.deps, actorOf(member), a.id);
    deleteReply(ctx.deps, actorOf(member), c.id);
    let view = tree(task.id);
    const placeholder = view.items.find((item) => item.id === a.id);
    expect(placeholder).toMatchObject({
      deleted: true,
      body: '',
      author: null,
      via: null,
      attachments: [],
      replyCount: 1,
    });
    expect(view.items.map((item) => item.id)).toEqual([a.id, a1.id, b.id, b1.id]);
    expect(JSON.stringify(view)).not.toContain('Secret parent text');

    // A placeholder whose answers are all deleted disappears; so does a deleted chain.
    deleteReply(ctx.deps, actorOf(owner), a1.id);
    deleteReply(ctx.deps, actorOf(owner), b1.id);
    deleteReply(ctx.deps, actorOf(member), b.id);
    view = tree(task.id);
    expect(view.items).toEqual([]);
    expect(view.total).toBe(0);

    // Restoring an answer brings its placeholder back.
    restoreReply(ctx.deps, actorOf(owner), b1.id);
    view = tree(task.id);
    expect(view.items.map((item) => [item.id, item.deleted])).toEqual([
      [b.id, true],
      [b1.id, false],
    ]);
  });

  it('turns answers into top-level comments when their deleted parent is purged', () => {
    const task = newTask();
    const a = reply(member, task.id, 'Parent');
    const a1 = reply(owner, task.id, 'Answer', a.id);
    ctx.db.orm.delete(s.reply).where(eq(s.reply.id, a.id)).run();
    const view = tree(task.id);
    expect(view.items.map((item) => [item.id, item.parentReplyId, item.depth])).toEqual([
      [a1.id, null, 0],
    ]);
  });
});

describe('ReplyTree', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);
  const row = (id: string, parent: string | null, ms: number, deleted = false): ReplySkeleton => ({
    id,
    parentReplyId: parent,
    createdAt: at(ms),
    deleted,
  });

  it('selects the oldest reachable comments within the limit and depth', () => {
    const tree = new ReplyTree([
      row('b', null, 2),
      row('a', null, 1),
      row('a1', 'a', 3),
      row('a1x', 'a1', 4),
      row('c', null, 5),
    ]);
    const view = tree.view({ limit: 3, depth: 10 });
    expect(view?.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'b']);
    expect(tree.view({ limit: 10, depth: 2 })?.nodes.map((node) => node.id)).toEqual([
      'a',
      'a1',
      'b',
      'c',
    ]);
    expect(tree.view({ root: 'missing', limit: 10, depth: 10 })).toBeNull();
  });

  it('keeps a deleted reply only while a visible answer is under it', () => {
    const tree = new ReplyTree([
      row('a', null, 1, true),
      row('a1', 'a', 2, true),
      row('a1x', 'a1', 3),
      row('b', null, 4, true),
      row('b1', 'b', 5, true),
    ]);
    const view = tree.view({ limit: 10, depth: 10 });
    expect(view?.nodes.map((node) => node.id)).toEqual(['a', 'a1', 'a1x']);
    expect(view?.total).toBe(3);
  });
});

describe('notifications for answers', () => {
  function replyNotifications(user: UserRow) {
    return ctx.db.orm
      .select()
      .from(s.notification)
      .where(and(eq(s.notification.userId, user.id), eq(s.notification.type, 'reply')))
      .all();
  }

  it('notifies the answered reply’s author, even unsubscribed, once, and never the actor', () => {
    const task = newTask();
    const third = createUser(ctx.db, { username: 'zed' });
    addMember(ctx.db, { teamId: team.team.id, userId: third.id });
    // Replying subscribed mia; the answer notifies her once, not as author and subscriber.
    const top = reply(member, task.id, 'Question');
    const first = reply(third, task.id, 'Answer', top.id);
    expect(replyNotifications(member).filter((note) => note.entityId === first.id)).toHaveLength(1);

    setSubscription(ctx.deps, actorOf(member), {
      entityType: 'task',
      entityId: task.id,
      subscribed: false,
    });
    const answer = reply(third, task.id, 'Another answer', top.id);
    expect(replyNotifications(member).at(-1)).toMatchObject({
      entityType: 'reply',
      entityId: answer.id,
    });
    // A top-level reply doesn't reach her any more.
    const unrelated = reply(third, task.id, 'Unrelated');
    expect(replyNotifications(member).map((note) => note.entityId)).not.toContain(unrelated.id);

    // Answering your own reply from the web doesn't notify you.
    const self = reply(third, task.id, 'Adding to my answer', answer.id);
    expect(replyNotifications(third).filter((note) => note.entityId === self.id)).toHaveLength(0);
  });

  it('notifies the author when their own agent answers them through an API key (BAT-6)', () => {
    const task = newTask();
    const top = reply(member, task.id, 'Agent, please check');
    const { apiKey } = createApiKey(ctx.db, { userId: member.id, name: 'Claude' });
    const agent: Actor = {
      userId: member.id,
      source: 'mcp',
      key: { id: apiKey.id, name: apiKey.name },
    };
    const answer = createReply(ctx.deps, agent, {
      parentType: 'task',
      parentId: task.id,
      parentReplyId: top.id,
      body: 'Checked',
    });
    expect(replyNotifications(member).map((note) => note.entityId)).toContain(answer.id);
  });
});
