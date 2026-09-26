import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  activityListResponseSchema,
  notificationListResponseSchema,
  replyListResponseSchema,
  replySchema,
} from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createIssue,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { uploadAttachment } from './attachments';
import { createReply, deleteReply, editReply, restoreReply } from './replies';
import { markNotificationsRead, unreadNotificationCount } from './notifications';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function notificationsOf(user: UserRow) {
  return ctx.db.orm.select().from(s.notification).where(eq(s.notification.userId, user.id)).all();
}

describe('replies over REST', () => {
  it('creates a reply via an API key: counts, subscription, activity, search and events', async () => {
    const task = createTask(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Fix login',
    });
    const { key, apiKey } = createApiKey(ctx.db, { userId: member.id, name: 'Claude on laptop' });

    const res = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        { parentType: 'task', parentId: task.id, body: 'On it — **looking** now' },
        bearer(key),
      ),
    );
    expect(res.status).toBe(201);
    const reply = replySchema.parse(await res.json());
    expect(reply).toMatchObject({
      parentType: 'task',
      parentId: task.id,
      author: { id: member.id, username: 'mia' },
      via: { keyId: apiKey.id, keyName: 'Claude on laptop' },
      editedAt: null,
      attachments: [],
    });

    const updated = ctx.db.orm.select().from(s.task).where(eq(s.task.id, task.id)).get();
    expect(updated?.replyCount).toBe(1);
    expect(updated?.lastActivityAt.getTime()).toBeGreaterThanOrEqual(task.lastActivityAt.getTime());

    const subscription = ctx.db.orm
      .select()
      .from(s.subscription)
      .where(and(eq(s.subscription.userId, member.id), eq(s.subscription.entityId, task.id)))
      .get();
    expect(subscription?.subscribed).toBe(true);

    const activity = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, reply.id))
      .get();
    expect(activity).toMatchObject({
      action: 'reply.created',
      source: 'api',
      viaKeyId: apiKey.id,
      viaKeyName: 'Claude on laptop',
      teamId: team.team.id,
      projectId: project.project.id,
    });
    expect(activity?.meta).toMatchObject({ parentRef: 'API-1', parentTitle: 'Fix login' });

    // BAT-6: the key's owner didn't write it, so the reply reaches their inbox too.
    expect(events.map((event) => event.type).sort()).toEqual([
      'activity.created',
      'notification.created',
      'reply.created',
    ]);
    expect(events.find((event) => event.type === 'reply.created')).toMatchObject({
      parentType: 'task',
      parentId: task.id,
      actorId: member.id,
    });

    const search = await ctx.app.request('/api/search?q=looking', { headers: bearer(key) });
    expect(await search.json()).toMatchObject({
      results: [{ entityType: 'reply', entityId: reply.id, ref: 'API-1', title: 'Fix login' }],
    });

    const list = replyListResponseSchema.parse(
      await (
        await ctx.app.request(`/api/replies?parentType=task&parentId=${task.id}`, {
          headers: bearer(key),
        })
      ).json(),
    );
    expect(list.items.map((item) => item.id)).toEqual([reply.id]);
  });

  it('requires the REPLY permission and membership', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    ctx.db.orm
      .update(s.role)
      .set({ permissions: [] })
      .where(eq(s.role.id, team.everyoneRole.id))
      .run();
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const denied = await ctx.app.request(
      '/api/replies',
      json('POST', { parentType: 'issue', parentId: issue.id, body: 'hi' }, bearer(key)),
    );
    expect(denied.status).toBe(403);

    const outsider = createUser(ctx.db);
    const outsiderKey = createApiKey(ctx.db, { userId: outsider.id });
    const hidden = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        { parentType: 'issue', parentId: issue.id, body: 'hi' },
        bearer(outsiderKey.key),
      ),
    );
    expect(hidden.status).toBe(404);
    const list = await ctx.app.request(`/api/replies?parentType=issue&parentId=${issue.id}`, {
      headers: bearer(outsiderKey.key),
    });
    expect(list.status).toBe(404);
  });

  it('edits and deletes via REST with author checks', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'first',
    });
    const other = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: other.id });
    const otherKey = createApiKey(ctx.db, { userId: other.id });
    const forbidden = await ctx.app.request(
      `/api/replies/${reply.id}`,
      json('PATCH', { body: 'hijack' }, bearer(otherKey.key)),
    );
    expect(forbidden.status).toBe(403);

    const { key } = createApiKey(ctx.db, { userId: member.id });
    const edited = await ctx.app.request(
      `/api/replies/${reply.id}`,
      json('PATCH', { body: 'second' }, bearer(key)),
    );
    expect(edited.status).toBe(200);
    const body = replySchema.parse(await edited.json());
    expect(body.body).toBe('second');
    expect(body.editedAt).not.toBeNull();

    const deleted = await ctx.app.request(`/api/replies/${reply.id}`, {
      method: 'DELETE',
      headers: bearer(otherKey.key),
    });
    expect(deleted.status).toBe(403);
    const ok = await ctx.app.request(`/api/replies/${reply.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(await ok.json()).toEqual({ ok: true });
    expect(
      ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get()?.replyCount,
    ).toBe(0);
  });
});

describe('reply lifecycle', () => {
  it('lets moderators edit and delete, and authors or MANAGE_TRASH restore', () => {
    const task = createTask(ctx.db, { project: project.project });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'x',
    });

    const moderator = createUser(ctx.db);
    const role = createRole(ctx.db, {
      teamId: team.team.id,
      permissions: ['EDIT_ANY_CONTENT', 'DELETE_ANY_CONTENT'],
    });
    addMember(ctx.db, { teamId: team.team.id, userId: moderator.id, roleIds: [role.id] });
    expect(editReply(ctx.deps, actorOf(moderator), reply.id, { body: 'moderated' }).body).toBe(
      'moderated',
    );
    deleteReply(ctx.deps, actorOf(moderator), reply.id);

    // The moderator can delete but not restore someone else's reply without MANAGE_TRASH.
    expect(() => restoreReply(ctx.deps, actorOf(moderator), reply.id)).toThrow(/your own/);
    restoreReply(ctx.deps, actorOf(member), reply.id);
    expect(ctx.db.orm.select().from(s.task).where(eq(s.task.id, task.id)).get()?.replyCount).toBe(
      1,
    );

    const history = ctx.db.orm
      .select({ action: s.activity.action })
      .from(s.activity)
      .where(eq(s.activity.entityId, reply.id))
      .all()
      .map((row) => row.action);
    expect(history).toEqual(['reply.created', 'reply.edited', 'reply.deleted', 'reply.restored']);
  });

  it('refuses to restore a reply of a deleted item', () => {
    const task = createTask(ctx.db, { project: project.project });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'x',
    });
    deleteReply(ctx.deps, actorOf(member), reply.id);
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(() => restoreReply(ctx.deps, actorOf(member), reply.id)).toThrow(/Restore the task/);
  });

  it('hides replies of deleted items', () => {
    const task = createTask(ctx.db, { project: project.project });
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(() =>
      createReply(ctx.deps, actorOf(member), { parentType: 'task', parentId: task.id, body: 'x' }),
    ).toThrow(/Task not found/);
  });
});

describe('notifications', () => {
  it('notifies subscribers and mentioned members once, never the actor', () => {
    const task = createTask(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Ship',
    });
    // The owner is subscribed as the author would be.
    ctx.db.orm
      .insert(s.subscription)
      .values({ userId: owner.id, entityType: 'task', entityId: task.id, subscribed: true })
      .run();
    const bob = createUser(ctx.db, { username: 'bob' });
    addMember(ctx.db, { teamId: team.team.id, userId: bob.id });
    const outsider = createUser(ctx.db, { username: 'stranger' });

    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: '@owner @bob @stranger @mia see `@notbob`',
    });

    expect(notificationsOf(owner).map((n) => n.type)).toEqual(['mention']);
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['mention']);
    expect(notificationsOf(outsider)).toEqual([]);
    expect(notificationsOf(member)).toEqual([]);
    expect(notificationsOf(bob)[0]).toMatchObject({
      title: 'API-1: Ship',
      url: `/t/acme/p/API/tasks/1#reply-${reply.id}`,
      entityType: 'reply',
      entityId: reply.id,
      actorId: member.id,
    });
    const personal = events.filter((event) => event.type === 'notification.created');
    expect(personal.map((event) => event.userId).sort()).toEqual([owner.id, bob.id].sort());

    // A plain reply by bob notifies subscribers (owner, mia) but not bob.
    createReply(ctx.deps, actorOf(bob), { parentType: 'task', parentId: task.id, body: 'ok' });
    expect(notificationsOf(owner).map((n) => n.type)).toEqual(['mention', 'reply']);
    expect(notificationsOf(member).map((n) => n.type)).toEqual(['reply']);
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['mention']);
  });

  it('honours explicit unsubscribe, even after replying again', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const { key } = createApiKey(ctx.db, { userId: member.id });
    createReply(ctx.deps, actorOf(member), { parentType: 'issue', parentId: issue.id, body: 'a' });
    const off = await ctx.app.request(
      '/api/subscriptions',
      json('POST', { entityType: 'issue', entityId: issue.id, subscribed: false }, bearer(key)),
    );
    expect(await off.json()).toEqual({ subscribed: false });
    createReply(ctx.deps, actorOf(member), { parentType: 'issue', parentId: issue.id, body: 'b' });
    createReply(ctx.deps, actorOf(owner), { parentType: 'issue', parentId: issue.id, body: 'c' });
    expect(notificationsOf(member)).toEqual([]);
    const state = await ctx.app.request(
      `/api/subscriptions?entityType=issue&entityId=${issue.id}`,
      { headers: bearer(key) },
    );
    expect(await state.json()).toEqual({ subscribed: false });
  });

  it('applies role and @everyone mention rules', () => {
    const task = createTask(ctx.db, { project: project.project });
    const devs = createRole(ctx.db, { teamId: team.team.id, slug: 'devs', mentionable: true });
    const secret = createRole(ctx.db, { teamId: team.team.id, slug: 'secret', mentionable: false });
    const dev = createUser(ctx.db);
    const spy = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: dev.id, roleIds: [devs.id] });
    addMember(ctx.db, { teamId: team.team.id, userId: spy.id, roleIds: [secret.id] });

    // A plain member may mention mentionable roles only, and not @everyone.
    createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: '@&devs @&secret @everyone',
    });
    expect(notificationsOf(dev).map((n) => n.type)).toEqual(['role_mention']);
    expect(notificationsOf(spy)).toEqual([]);
    expect(notificationsOf(owner)).toEqual([]);

    // The owner has MENTION_EVERYONE.
    createReply(ctx.deps, actorOf(owner), {
      parentType: 'task',
      parentId: task.id,
      body: '@&secret and @everyone',
    });
    expect(notificationsOf(spy).map((n) => n.type)).toEqual(['role_mention']);
    expect(notificationsOf(member).map((n) => n.type)).toContain('role_mention');
    expect(notificationsOf(owner)).toEqual([]);
  });

  it('notifies only newly added mentions on edit', () => {
    const task = createTask(ctx.db, { project: project.project });
    const bob = createUser(ctx.db, { username: 'bob' });
    addMember(ctx.db, { teamId: team.team.id, userId: bob.id });
    const reply = createReply(ctx.deps, actorOf(owner), {
      parentType: 'task',
      parentId: task.id,
      body: '@mia',
    });
    editReply(ctx.deps, actorOf(owner), reply.id, { body: '@mia and @bob' });
    expect(notificationsOf(member)).toHaveLength(1);
    expect(notificationsOf(bob)).toHaveLength(1);
  });

  it('attaches images pasted into the body when replying and when editing', async () => {
    const task = createTask(ctx.db, { project: project.project });
    // A 1×1 PNG, uploaded as pending (as the editor does while typing).
    const png = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const upload = (filename: string) =>
      uploadAttachment(ctx.deps, actorOf(member), {
        teamId: team.team.id,
        parentType: 'pending',
        filename,
        bytes: png,
      });
    const first = await upload('first.png');
    const second = await upload('second.png');
    const unused = await upload('unused.png');

    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: `Before: ![first](${first.url})`,
    });
    expect(reply.attachments.map((attachment) => attachment.filename)).toEqual(['first.png']);
    const edited = editReply(ctx.deps, actorOf(member), reply.id, {
      body: `Before: ![first](${first.url}) after: ![second](${second.url})`,
    });
    expect(edited.attachments.map((attachment) => attachment.filename).sort()).toEqual([
      'first.png',
      'second.png',
    ]);
    const parentOf = (id: string) =>
      ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, id)).get()?.parentType;
    expect(parentOf(unused.id)).toBe('pending');

    // Someone else's pending upload linked from a reply is not claimed.
    const owners = await uploadAttachment(ctx.deps, actorOf(owner), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'owner.png',
      bytes: png,
    });
    createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: `![theirs](${owners.url})`,
    });
    expect(parentOf(owners.id)).toBe('pending');
  });

  it('lists, counts and marks notifications read', async () => {
    const task = createTask(ctx.db, { project: project.project });
    for (let i = 0; i < 3; i += 1) {
      createReply(ctx.deps, actorOf(owner), {
        parentType: 'task',
        parentId: task.id,
        body: `@mia ${i}`,
      });
    }
    const { key } = createApiKey(ctx.db, { userId: member.id });
    expect(unreadNotificationCount(ctx.deps, actorOf(member))).toBe(3);

    const page1 = notificationListResponseSchema.parse(
      await (await ctx.app.request('/api/notifications?limit=2', { headers: bearer(key) })).json(),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.actor?.username).toBe('owner');
    const page2 = notificationListResponseSchema.parse(
      await (
        await ctx.app.request(`/api/notifications?limit=2&cursor=${page1.nextCursor ?? ''}`, {
          headers: bearer(key),
        })
      ).json(),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const firstId = page1.items[0]?.id ?? '';
    const marked = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { ids: [firstId] }, bearer(key)),
    );
    expect(await marked.json()).toEqual({ updated: 1 });
    const unread = await ctx.app.request('/api/notifications?unread=1', { headers: bearer(key) });
    expect(notificationListResponseSchema.parse(await unread.json()).items).toHaveLength(2);
    expect(
      await (
        await ctx.app.request('/api/notifications/unread-count', { headers: bearer(key) })
      ).json(),
    ).toEqual({
      count: 2,
    });
    expect(markNotificationsRead(ctx.deps, actorOf(member), { all: true })).toEqual({ updated: 2 });
    // Someone else's ids are not touched.
    expect(markNotificationsRead(ctx.deps, actorOf(owner), { ids: [firstId] })).toEqual({
      updated: 0,
    });
  });

  it('hides notifications from teams the user has left', () => {
    const task = createTask(ctx.db, { project: project.project });
    createReply(ctx.deps, actorOf(owner), { parentType: 'task', parentId: task.id, body: '@mia' });
    ctx.db.orm.delete(s.teamMember).where(eq(s.teamMember.userId, member.id)).run();
    expect(unreadNotificationCount(ctx.deps, actorOf(member))).toBe(0);
  });
});

describe('item history', () => {
  it('returns entity history to members and 404 to outsiders', async () => {
    const task = createTask(ctx.db, { project: project.project });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'x',
    });
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const res = await ctx.app.request(`/api/activity?entityType=reply&entityId=${reply.id}`, {
      headers: bearer(key),
    });
    const history = activityListResponseSchema.parse(await res.json());
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      action: 'reply.created',
      actor: { user: { username: 'mia' }, via: null, source: 'web' },
      url: `/t/acme/p/API/tasks/1#reply-${reply.id}`,
    });

    const outsider = createApiKey(ctx.db, { userId: createUser(ctx.db).id });
    const hidden = await ctx.app.request(`/api/activity?entityType=reply&entityId=${reply.id}`, {
      headers: bearer(outsider.key),
    });
    expect(hidden.status).toBe(404);
  });
});
