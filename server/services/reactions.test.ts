import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  reactionInputSchema,
  reactionListResponseSchema,
  replyListResponseSchema,
} from '@shared/schemas/core';
import { issueSchema } from '@shared/schemas/issues';
import { taskSchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
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
import { addReaction, removeReaction } from './reactions';
import { createReply, deleteReply } from './replies';
import { purgeTrash } from './trash';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive Owner' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function newTask() {
  return createTask(ctx.db, { project: project.project, authorId: owner.id, title: 'Fix login' });
}

function reactionEvents() {
  return events.filter((event) => event.type === 'reaction.changed');
}

describe('reaction emoji validation', () => {
  const parse = (emoji: string) =>
    reactionInputSchema.safeParse({ targetType: 'task', targetId: 'x', emoji }).success;

  it('accepts single emoji, including skin tones, ZWJ sequences, flags and keycaps', () => {
    for (const emoji of ['👍', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🇳🇿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '1️⃣']) {
      expect(parse(emoji), emoji).toBe(true);
    }
  });

  it('rejects text, several emoji and empty values', () => {
    for (const emoji of ['', 'a', ':+1:', '👍👍', '🔥 🔥', 'x👍']) {
      expect(parse(emoji), emoji).toBe(false);
    }
  });
});

describe('reactions service', () => {
  it('adds, aggregates in first-reaction order and marks reactedByMe per viewer', () => {
    const task = newTask();
    const target = { targetType: 'task' as const, targetId: task.id };
    addReaction(ctx.deps, actorOf(owner), { ...target, emoji: '🔥' });
    addReaction(ctx.deps, actorOf(mia), { ...target, emoji: '👍' });
    const result = addReaction(ctx.deps, actorOf(mia), { ...target, emoji: '🔥' });

    expect(result.ref).toBe('acme/API-1');
    expect(result.url).toBe('http://localhost:4100/t/acme/p/API/tasks/1');
    expect(result.reactions).toEqual([
      {
        emoji: '🔥',
        count: 2,
        reactedByMe: true,
        users: [
          expect.objectContaining({ id: owner.id, name: 'Olive Owner', via: null }),
          expect.objectContaining({ id: mia.id, via: null }),
        ],
      },
      {
        emoji: '👍',
        count: 1,
        reactedByMe: true,
        users: [expect.objectContaining({ id: mia.id })],
      },
    ]);

    const asOwner = removeReaction(ctx.deps, actorOf(owner), { ...target, emoji: '👍' });
    expect(asOwner.reactions.map((r) => [r.emoji, r.count, r.reactedByMe])).toEqual([
      ['🔥', 2, true],
      ['👍', 1, false],
    ]);
  });

  it('is idempotent: one row per person and emoji, repeated adds and removes change nothing', () => {
    const task = newTask();
    const input = { targetType: 'task' as const, targetId: task.id, emoji: '🎉' };
    addReaction(ctx.deps, actorOf(mia), input);
    addReaction(ctx.deps, actorOf(mia), input);
    expect(ctx.db.orm.select().from(s.reaction).all()).toHaveLength(1);
    expect(reactionEvents()).toHaveLength(1);

    expect(removeReaction(ctx.deps, actorOf(mia), input).reactions).toEqual([]);
    expect(removeReaction(ctx.deps, actorOf(mia), input).reactions).toEqual([]);
    expect(ctx.db.orm.select().from(s.reaction).all()).toHaveLength(0);
    expect(reactionEvents()).toHaveLength(2);
  });

  it('emits reaction.changed after commit, naming a reply’s thread; no activity or notifications', () => {
    const task = newTask();
    const reply = createReply(ctx.deps, actorOf(owner), {
      parentType: 'task',
      parentId: task.id,
      body: 'Done',
    });
    const activityBefore = ctx.db.orm.select().from(s.activity).all().length;
    const notificationsBefore = ctx.db.orm.select().from(s.notification).all().length;
    events.length = 0;

    addReaction(ctx.deps, actorOf(mia), { targetType: 'reply', targetId: reply.id, emoji: '👀' });

    expect(reactionEvents()).toEqual([
      expect.objectContaining({
        type: 'reaction.changed',
        teamId: team.team.id,
        projectId: project.project.id,
        entityType: 'reply',
        entityId: reply.id,
        parentType: 'task',
        parentId: task.id,
        actorId: mia.id,
      }),
    ]);
    expect(ctx.db.orm.select().from(s.activity).all()).toHaveLength(activityBefore);
    expect(ctx.db.orm.select().from(s.notification).all()).toHaveLength(notificationsBefore);
  });

  it('requires REPLY to react, but anyone can still remove their own reaction', () => {
    const task = newTask();
    const input = { targetType: 'task' as const, targetId: task.id, emoji: '👍' };
    addReaction(ctx.deps, actorOf(mia), input);
    ctx.db.orm
      .update(s.role)
      .set({ permissions: ['VIEW_PROJECT'] })
      .where(eq(s.role.id, team.everyoneRole.id))
      .run();

    expect(() => addReaction(ctx.deps, actorOf(mia), { ...input, emoji: '🔥' })).toThrowError(
      expect.objectContaining({ code: 'forbidden' }),
    );
    expect(removeReaction(ctx.deps, actorOf(mia), input).reactions).toEqual([]);
  });

  it('hides targets from non-members and caps the number of different emojis', () => {
    const outsider = createUser(ctx.db, { username: 'outsider' });
    const task = newTask();
    const input = { targetType: 'task' as const, targetId: task.id, emoji: '👍' };
    expect(() => addReaction(ctx.deps, actorOf(outsider), input)).toThrowError(
      expect.objectContaining({ code: 'not_found' }),
    );

    const emojis = [
      ...'😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥸🤩🥳😏😒😞😔😟😕🙁😣😖😫😩🥺😢😭😤😠😡🤬',
    ];
    expect(emojis).toHaveLength(50);
    for (const emoji of emojis) addReaction(ctx.deps, actorOf(owner), { ...input, emoji });
    expect(() => addReaction(ctx.deps, actorOf(owner), { ...input, emoji: '🔥' })).toThrowError(
      expect.objectContaining({ code: 'conflict' }),
    );
    // Joining an existing emoji is still fine.
    expect(
      addReaction(ctx.deps, actorOf(mia), { ...input, emoji: '😀' }).reactions[0],
    ).toMatchObject({ emoji: '😀', count: 2 });
  });

  it('hides deleted targets, and the purge removes their reactions', () => {
    const task = newTask();
    const reply = createReply(ctx.deps, actorOf(owner), {
      parentType: 'task',
      parentId: task.id,
      body: 'Done',
    });
    addReaction(ctx.deps, actorOf(mia), { targetType: 'reply', targetId: reply.id, emoji: '👍' });
    addReaction(ctx.deps, actorOf(mia), { targetType: 'task', targetId: task.id, emoji: '👍' });

    deleteReply(ctx.deps, actorOf(owner), reply.id);
    expect(() =>
      addReaction(ctx.deps, actorOf(mia), { targetType: 'reply', targetId: reply.id, emoji: '🔥' }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));

    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    ctx.db.orm.update(s.task).set({ deletedAt: past }).where(eq(s.task.id, task.id)).run();
    ctx.db.orm.update(s.reply).set({ deletedAt: past }).where(eq(s.reply.id, reply.id)).run();
    expect(() =>
      addReaction(ctx.deps, actorOf(mia), { targetType: 'task', targetId: task.id, emoji: '🔥' }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));

    const other = newTask();
    addReaction(ctx.deps, actorOf(mia), { targetType: 'task', targetId: other.id, emoji: '🎉' });
    purgeTrash(ctx.deps);
    expect(ctx.db.orm.select({ targetId: s.reaction.targetId }).from(s.reaction).all()).toEqual([
      { targetId: other.id },
    ]);
  });
});

describe('reactions over REST', () => {
  it('PUT adds and DELETE removes, returning the aggregated reactions with the via key', async () => {
    const task = newTask();
    const { key, apiKey } = createApiKey(ctx.db, { userId: mia.id, name: 'MSI' });
    ctx.db.orm
      .update(s.apiKey)
      .set({ agentName: 'Claude' })
      .where(eq(s.apiKey.id, apiKey.id))
      .run();

    const put = await ctx.app.request(
      '/api/reactions',
      json('PUT', { targetType: 'task', targetId: task.id, emoji: '🔥' }, bearer(key)),
    );
    expect(put.status).toBe(200);
    const added = reactionListResponseSchema.strict().parse(await put.json());
    expect(added).toEqual({
      targetType: 'task',
      targetId: task.id,
      reactions: [
        {
          emoji: '🔥',
          count: 1,
          reactedByMe: true,
          users: [
            expect.objectContaining({
              id: mia.id,
              via: { keyId: apiKey.id, keyName: 'MSI', agentName: 'Claude' },
            }),
          ],
        },
      ],
    });

    const query = new URLSearchParams({ targetType: 'task', targetId: task.id, emoji: '🔥' });
    const del = await ctx.app.request(`/api/reactions?${query.toString()}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(del.status).toBe(200);
    expect(reactionListResponseSchema.parse(await del.json()).reactions).toEqual([]);
  });

  it('rejects invalid emoji and unknown targets', async () => {
    const task = newTask();
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    const invalid = await ctx.app.request(
      '/api/reactions',
      json('PUT', { targetType: 'task', targetId: task.id, emoji: '👍👍' }, bearer(key)),
    );
    expect(invalid.status).toBe(400);
    const missing = await ctx.app.request(
      '/api/reactions',
      json('PUT', { targetType: 'issue', targetId: task.id, emoji: '👍' }, bearer(key)),
    );
    expect(missing.status).toBe(404);
  });

  it('includes reactions in task, issue and reply payloads', async () => {
    const task = newTask();
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const reply = createReply(ctx.deps, actorOf(owner), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Seen',
    });
    addReaction(ctx.deps, actorOf(owner), { targetType: 'task', targetId: task.id, emoji: '🎉' });
    addReaction(ctx.deps, actorOf(owner), { targetType: 'issue', targetId: issue.id, emoji: '❤️' });
    addReaction(ctx.deps, actorOf(owner), { targetType: 'reply', targetId: reply.id, emoji: '👀' });
    const { key } = createApiKey(ctx.db, { userId: mia.id });

    const taskRes = await ctx.app.request(`/api/tasks/${task.id}`, { headers: bearer(key) });
    expect(taskSchema.parse(await taskRes.json()).reactions).toEqual([
      expect.objectContaining({ emoji: '🎉', count: 1, reactedByMe: false }),
    ]);
    const issueRes = await ctx.app.request(`/api/issues/${issue.id}`, { headers: bearer(key) });
    expect(issueSchema.parse(await issueRes.json()).reactions).toEqual([
      expect.objectContaining({ emoji: '❤️', count: 1 }),
    ]);
    const repliesRes = await ctx.app.request(`/api/replies?parentType=issue&parentId=${issue.id}`, {
      headers: bearer(key),
    });
    expect(replyListResponseSchema.parse(await repliesRes.json()).items[0]?.reactions).toEqual([
      expect.objectContaining({ emoji: '👀', count: 1 }),
    ]);
  });
});
