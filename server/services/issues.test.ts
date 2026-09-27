import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { EVERYONE_DEFAULTS, type Permission } from '@shared/permissions';
import { okResponseSchema } from '@shared/schemas/common';
import { activityListResponseSchema } from '@shared/schemas/core';
import {
  issueListResponseSchema,
  issueSchema,
  listIssuesQuerySchema,
  type ListIssuesQueryInput,
} from '@shared/schemas/issues';
import type { Actor } from '../context';
import * as s from '../db/schema';
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
import { uploadAttachment } from './attachments';
import {
  createIssue,
  deleteIssue,
  getIssue,
  getIssueByNumber,
  listIssues,
  reopenIssue,
  resolveIssue,
  restoreIssue,
  updateIssue,
} from './issues';
import { deleteProject } from './projects';
import { createReply } from './replies';
import { search } from './search';
import { setSubscription } from './subscriptions';
import { listTrash, restoreItem } from './trash';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let other: UserRow;
let outsider: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let events: LiveEvent[];

const actorOf = (user: { id: string }, key: Actor['key'] = null): Actor => ({
  userId: user.id,
  source: key ? 'mcp' : 'web',
  key,
});

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive Owner' });
  member = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  other = createUser(ctx.db, { username: 'otto', name: 'Otto' });
  outsider = createUser(ctx.db, { username: 'stranger' });
  // These tests are about the actions themselves; sign-off has its own (agentActions.test.ts).
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', agentSignoff: false });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  addMember(ctx.db, { teamId: team.team.id, userId: other.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

/** Replaces the permissions every member gets from `@everyone`. */
function setEveryone(permissions: Permission[]) {
  ctx.db.orm.update(s.role).set({ permissions }).where(eq(s.role.id, team.everyoneRole.id)).run();
}

function label(name: string, projectId = project.project.id) {
  return ctx.db.orm.insert(s.label).values({ projectId, name, color: '#ef4444' }).returning().get();
}

function open(
  user: UserRow,
  title: string,
  extra: Partial<Parameters<typeof createIssue>[3]> = {},
) {
  return createIssue(ctx.deps, actorOf(user), project.project.id, { title, ...extra });
}

function list(user: UserRow, query: ListIssuesQueryInput = {}) {
  return listIssues(
    ctx.deps,
    actorOf(user),
    project.project.id,
    listIssuesQuerySchema.parse(query),
  );
}

function notificationsOf(user: UserRow) {
  return ctx.db.orm.select().from(s.notification).where(eq(s.notification.userId, user.id)).all();
}

function activityOf(issueId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(and(eq(s.activity.entityType, 'issue'), eq(s.activity.entityId, issueId)))
    .all();
}

async function pendingUpload(user: UserRow, filename = 'shot.png') {
  // A 1x1 PNG, so the attachment is sniffed as an inline image.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return uploadAttachment(ctx.deps, actorOf(user), {
    teamId: team.team.id,
    parentType: 'pending',
    filename,
    bytes: new Uint8Array(png),
  });
}

describe('createIssue', () => {
  it('numbers issues per project and records author, labels, activity, search and events', () => {
    const bug = label('Bug');
    const first = open(member, 'Login fails', {
      body: 'Steps to **reproduce**',
      labelIds: [bug.id],
    });
    const second = open(owner, 'Dark mode');
    const elsewhere = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const third = createIssue(ctx.deps, actorOf(member), elsewhere.project.id, { title: 'Other' });

    expect(issueSchema.parse(first)).toMatchObject({
      number: 1,
      ref: 'API#1',
      title: 'Login fails',
      body: 'Steps to **reproduce**',
      resolved: false,
      replyCount: 0,
      author: { id: member.id, username: 'mia' },
      via: null,
      labels: [{ id: bug.id, name: 'Bug' }],
      linkedTasks: [],
      subscribed: true,
      editedAt: null,
      path: '/t/acme/p/API/issues/1',
    });
    expect(second.number).toBe(2);
    expect(third).toMatchObject({ number: 1, ref: 'WEB#1' });

    const [created] = activityOf(first.id);
    expect(created).toMatchObject({
      action: 'issue.created',
      actorId: member.id,
      meta: { ref: 'API#1', title: 'Login fails', labels: ['Bug'] },
    });
    expect(
      search(ctx.deps, actorOf(owner), { q: 'reproduce', types: ['issue'], limit: 10 }).results,
    ).toMatchObject([{ entityId: first.id, ref: 'API#1', url: '/t/acme/p/API/issues/1' }]);
    expect(events.filter((event) => event.type === 'issue.created')).toHaveLength(3);
    expect(events.find((event) => event.entityId === first.id)).toMatchObject({
      type: 'issue.created',
      teamId: team.team.id,
      projectId: project.project.id,
      actorId: member.id,
    });
  });

  it('attributes issues opened through an API key', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: member.id, name: 'Claude on laptop' });
    const issue = createIssue(
      ctx.deps,
      actorOf(member, { id: apiKey.id, name: apiKey.name }),
      project.project.id,
      { title: 'From an agent' },
    );
    expect(issue.via).toEqual({ keyId: apiKey.id, keyName: 'Claude on laptop' });
    expect(activityOf(issue.id)[0]).toMatchObject({
      source: 'mcp',
      viaKeyName: 'Claude on laptop',
    });
  });

  it('notifies mentioned members, but not the author', () => {
    const issue = open(member, 'Crash on save', { body: 'cc @otto and @mia and @stranger' });
    expect(notificationsOf(other)).toMatchObject([
      { type: 'mention', entityType: 'issue', entityId: issue.id, title: 'API#1: Crash on save' },
    ]);
    expect(notificationsOf(member)).toHaveLength(0);
    expect(notificationsOf(outsider)).toHaveLength(0);
  });

  it('attaches explicit uploads and images linked from the body', async () => {
    const file = await pendingUpload(member, 'report.png');
    const image = await pendingUpload(member, 'inline.png');
    const issue = open(member, 'With files', {
      body: `See ![shot](${image.url})`,
      attachmentIds: [file.id],
    });
    expect(issue.attachments.map((attachment) => attachment.filename).sort()).toEqual([
      'inline.png',
      'report.png',
    ]);
    expect(issue.attachments.every((attachment) => attachment.parentType === 'issue')).toBe(true);
  });

  it('refuses members without CREATE_ISSUES, outsiders and foreign labels', () => {
    const foreign = label(
      'Bug',
      createProject(ctx.db, { teamId: team.team.id, key: 'WEB' }).project.id,
    );
    expect(() => open(member, 'Nope', { labelIds: [foreign.id] })).toThrow(/labels/);
    expect(() => open(outsider, 'Nope')).toThrow(/not found/);
    setEveryone(EVERYONE_DEFAULTS.filter((permission) => permission !== 'CREATE_ISSUES'));
    expect(() => open(member, 'Nope')).toThrow(/permission/);
    expect(open(owner, 'Owner can').number).toBe(1);
  });
});

describe('listIssues', () => {
  it('filters by state with per-state counts, and excludes deleted issues and projects', () => {
    const a = open(member, 'Alpha');
    const b = open(member, 'Beta');
    const c = open(owner, 'Gamma');
    resolveIssue(ctx.deps, actorOf(member), b.id);
    deleteIssue(ctx.deps, actorOf(owner), c.id);

    const openPage = issueListResponseSchema.parse(list(owner));
    expect(openPage.items.map((issue) => issue.id)).toEqual([a.id]);
    expect(openPage.counts).toEqual({ open: 1, resolved: 1, all: 2 });
    expect(list(owner, { state: 'resolved' }).items.map((issue) => issue.id)).toEqual([b.id]);
    expect(list(owner, { state: 'all' }).items).toHaveLength(2);

    deleteProject(ctx.deps, actorOf(owner), project.project.id);
    expect(() => list(owner)).toThrow(/not found/);
  });

  it('filters by labels (any or all), author and text', () => {
    const bug = label('Bug');
    const ui = label('UI');
    const both = open(member, 'Button misaligned', { labelIds: [bug.id, ui.id] });
    const onlyBug = open(owner, 'Server crash', {
      labelIds: [bug.id],
      body: 'Stack overflow in parser',
    });
    const plain = open(other, 'Question about exports');
    createReply(ctx.deps, actorOf(owner), {
      parentType: 'issue',
      parentId: plain.id,
      body: 'Workaround: use the CSV endpoint',
    });

    const ids = (query: ListIssuesQueryInput) => list(owner, query).items.map((issue) => issue.id);
    expect(ids({ labels: `${bug.id},${ui.id}` }).sort()).toEqual([both.id, onlyBug.id].sort());
    expect(ids({ labels: `${bug.id},${ui.id}`, labelMatch: 'all' })).toEqual([both.id]);
    expect(ids({ author: owner.id })).toEqual([onlyBug.id]);
    expect(ids({ q: 'parser' })).toEqual([onlyBug.id]);
    expect(ids({ q: 'butt' })).toEqual([both.id]);
    expect(ids({ q: 'csv' })).toEqual([plain.id]);
    expect(ids({ q: '#2' })).toEqual([onlyBug.id]);
    expect(ids({ q: '3' })).toEqual([plain.id]);
    expect(ids({ q: '"' })).toEqual([]);
    expect(list(owner, { labels: bug.id, q: 'crash' }).counts).toEqual({
      open: 1,
      resolved: 0,
      all: 1,
    });
  });

  it('sorts by activity, number and replies, and paginates with a cursor', () => {
    const first = open(member, 'First');
    const second = open(member, 'Second');
    const third = open(member, 'Third');
    for (let n = 0; n < 2; n++) {
      createReply(ctx.deps, actorOf(owner), {
        parentType: 'issue',
        parentId: first.id,
        body: `r${n}`,
      });
    }
    createReply(ctx.deps, actorOf(owner), { parentType: 'issue', parentId: third.id, body: 'r' });
    // Make activity times distinct and deterministic.
    const times: Array<[string, number]> = [
      [first.id, 3000],
      [second.id, 5000],
      [third.id, 1000],
    ];
    for (const [id, ms] of times) {
      ctx.db.orm
        .update(s.issue)
        .set({ lastActivityAt: new Date(ms) })
        .where(eq(s.issue.id, id))
        .run();
    }

    const order = (sort: ListIssuesQueryInput['sort']) =>
      list(owner, { sort }).items.map((issue) => issue.title);
    expect(order('latest-activity')).toEqual(['Second', 'First', 'Third']);
    expect(order('newest')).toEqual(['Third', 'Second', 'First']);
    expect(order('oldest')).toEqual(['First', 'Second', 'Third']);
    expect(order('most-replies')).toEqual(['First', 'Third', 'Second']);

    for (const sort of ['latest-activity', 'newest', 'oldest', 'most-replies'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = list(owner, { sort, limit: 1, cursor });
        seen.push(...page.items.map((issue) => issue.title));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(order(sort));
    }
    expect(() => list(owner, { cursor: 'garbage' })).toThrow(/cursor/);
  });

  it('is 404 for non-members', () => {
    expect(() => list(outsider)).toThrow(/not found/);
  });
});

describe('getIssue', () => {
  it('includes live linked tasks, resolver and the viewer’s subscription', () => {
    const issue = open(member, 'Needs fixing');
    const fix = createTask(ctx.db, {
      project: project.project,
      title: 'Fix it',
      authorId: owner.id,
    });
    const related = createTask(ctx.db, { project: project.project, title: 'Related' });
    const gone = createTask(ctx.db, { project: project.project, title: 'Gone' });
    ctx.db.orm
      .insert(s.taskIssueLink)
      .values([
        { taskId: fix.id, issueId: issue.id, kind: 'fixes' },
        { taskId: related.id, issueId: issue.id, kind: 'relates' },
        { taskId: gone.id, issueId: issue.id, kind: 'fixes' },
      ])
      .run();
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, gone.id)).run();
    resolveIssue(ctx.deps, actorOf(owner), issue.id);

    const seen = getIssue(ctx.deps, actorOf(owner), issue.id);
    expect(seen.linkedTasks).toMatchObject([
      { ref: 'API-1', title: 'Fix it', kind: 'fixes', status: { name: 'Open', category: 'open' } },
      { ref: 'API-2', title: 'Related', kind: 'relates', path: '/t/acme/p/API/tasks/2' },
    ]);
    expect(seen).toMatchObject({ resolved: true, resolvedBy: { id: owner.id }, subscribed: false });
    expect(getIssue(ctx.deps, actorOf(member), issue.id).subscribed).toBe(true);
    setSubscription(ctx.deps, actorOf(member), {
      entityType: 'issue',
      entityId: issue.id,
      subscribed: false,
    });
    expect(getIssueByNumber(ctx.deps, actorOf(member), project.project.id, 1).subscribed).toBe(
      false,
    );
    expect(() => getIssueByNumber(ctx.deps, actorOf(member), project.project.id, 9)).toThrow(
      /not found/,
    );
    expect(() => getIssue(ctx.deps, actorOf(outsider), issue.id)).toThrow(/not found/);
  });
});

describe('updateIssue', () => {
  it('lets the author edit title and body, marking it edited and auditing the change', () => {
    const issue = open(member, 'Typo in title', { body: 'Original body' });
    const updated = updateIssue(ctx.deps, actorOf(member), issue.id, {
      title: 'Typo in the title',
      body: 'Updated body',
    });
    expect(updated).toMatchObject({ title: 'Typo in the title', body: 'Updated body' });
    expect(updated.editedAt).not.toBeNull();
    const row = activityOf(issue.id).find((entry) => entry.action === 'issue.updated');
    expect(row).toMatchObject({
      changes: {
        title: { from: 'Typo in title', to: 'Typo in the title' },
        description: { from: 'Original body', to: 'Updated body' },
      },
      meta: { ref: 'API#1', title: 'Typo in the title' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'issue.updated', entityId: issue.id });
    expect(
      search(ctx.deps, actorOf(owner), { q: 'updated', types: ['issue'], limit: 5 }).results,
    ).toHaveLength(1);
  });

  it('needs EDIT_ANY_CONTENT to edit someone else’s issue', () => {
    const issue = open(member, 'Mine');
    expect(() => updateIssue(ctx.deps, actorOf(other), issue.id, { title: 'Theirs' })).toThrow(
      /your own/,
    );
    const editor = createRole(ctx.db, { teamId: team.team.id, permissions: ['EDIT_ANY_CONTENT'] });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: other.id, roleId: editor.id })
      .run();
    expect(updateIssue(ctx.deps, actorOf(other), issue.id, { title: 'Theirs' }).title).toBe(
      'Theirs',
    );
  });

  it('notifies only newly added mentions', () => {
    const issue = open(member, 'Mentions', { body: 'cc @otto' });
    updateIssue(ctx.deps, actorOf(member), issue.id, { body: 'cc @otto and @owner' });
    expect(notificationsOf(other)).toHaveLength(1);
    expect(notificationsOf(owner)).toMatchObject([{ type: 'mention', entityId: issue.id }]);
  });

  it('adds, removes and sets labels (author or RESOLVE_ISSUES) and audits names', () => {
    const bug = label('Bug');
    const ui = label('UI');
    const docs = label('Docs');
    const issue = open(member, 'Labels', { labelIds: [bug.id] });
    const added = updateIssue(ctx.deps, actorOf(member), issue.id, { labels: { add: [ui.id] } });
    expect(added.labels.map((item) => item.name)).toEqual(['Bug', 'UI']);
    expect(added.editedAt).toBeNull();
    const removed = updateIssue(ctx.deps, actorOf(other), issue.id, {
      labels: { remove: [bug.id] },
    });
    expect(removed.labels.map((item) => item.name)).toEqual(['UI']);
    const set = updateIssue(ctx.deps, actorOf(owner), issue.id, { labels: { set: [docs.id] } });
    expect(set.labels.map((item) => item.name)).toEqual(['Docs']);
    const rows = activityOf(issue.id).filter((entry) => entry.action === 'issue.labels_changed');
    expect(rows.map((entry) => entry.changes.labels)).toEqual([
      { from: ['Bug'], to: ['Bug', 'UI'] },
      { from: ['Bug', 'UI'], to: ['UI'] },
      { from: ['UI'], to: ['Docs'] },
    ]);

    setEveryone(EVERYONE_DEFAULTS.filter((permission) => permission !== 'RESOLVE_ISSUES'));
    expect(() => updateIssue(ctx.deps, actorOf(other), issue.id, { labels: { set: [] } })).toThrow(
      /label your own/,
    );
    expect(() =>
      updateIssue(ctx.deps, actorOf(member), issue.id, { labels: { add: ['nope'] } }),
    ).toThrow(/labels/);
  });

  it('records nothing when nothing changes, and attaches uploads with an audit row', async () => {
    const issue = open(member, 'Same', { body: 'Body' });
    const before = activityOf(issue.id).length;
    updateIssue(ctx.deps, actorOf(member), issue.id, { title: 'Same', body: 'Body' });
    expect(activityOf(issue.id)).toHaveLength(before);

    const file = await pendingUpload(member, 'log.png');
    const updated = updateIssue(ctx.deps, actorOf(member), issue.id, { attachmentIds: [file.id] });
    expect(updated.attachments.map((attachment) => attachment.filename)).toEqual(['log.png']);
    expect(updated.editedAt).toBeNull();
    expect(activityOf(issue.id).at(-1)?.changes).toEqual({
      attachments: { from: [], to: ['log.png'] },
    });
  });
});

describe('resolve and reopen', () => {
  it('notifies the author and subscribers, never the actor, and is idempotent', () => {
    const issue = open(member, 'Broken');
    createReply(ctx.deps, actorOf(other), { parentType: 'issue', parentId: issue.id, body: '+1' });
    const resolved = resolveIssue(ctx.deps, actorOf(owner), issue.id);
    expect(resolved).toMatchObject({ resolved: true, resolvedBy: { id: owner.id } });
    expect(notificationsOf(member).filter((n) => n.type === 'issue_resolved')).toHaveLength(1);
    expect(notificationsOf(other).filter((n) => n.type === 'issue_resolved')).toHaveLength(1);
    expect(notificationsOf(owner)).toHaveLength(0);

    const count = activityOf(issue.id).length;
    resolveIssue(ctx.deps, actorOf(owner), issue.id);
    expect(activityOf(issue.id)).toHaveLength(count);

    const reopened = reopenIssue(ctx.deps, actorOf(member), issue.id);
    expect(reopened).toMatchObject({ resolved: false, resolvedAt: null, resolvedBy: null });
    expect(notificationsOf(other).filter((n) => n.type === 'issue_reopened')).toHaveLength(1);
    expect(notificationsOf(member).filter((n) => n.type === 'issue_reopened')).toHaveLength(0);
    expect(activityOf(issue.id).map((entry) => entry.action)).toEqual([
      'issue.created',
      'issue.resolved',
      'issue.reopened',
    ]);
  });

  it('needs the author or RESOLVE_ISSUES', () => {
    setEveryone(EVERYONE_DEFAULTS.filter((permission) => permission !== 'RESOLVE_ISSUES'));
    const issue = open(member, 'Mine');
    expect(() => resolveIssue(ctx.deps, actorOf(other), issue.id)).toThrow(/resolve your own/);
    expect(resolveIssue(ctx.deps, actorOf(member), issue.id).resolved).toBe(true);
    expect(() => reopenIssue(ctx.deps, actorOf(other), issue.id)).toThrow(/reopen your own/);
    expect(reopenIssue(ctx.deps, actorOf(owner), issue.id).resolved).toBe(false);
  });
});

describe('delete and restore', () => {
  it('moves issues to Trash and restores them through the trash registry', () => {
    const issue = open(member, 'Temporary');
    expect(() => deleteIssue(ctx.deps, actorOf(other), issue.id)).toThrow(/your own/);
    expect(deleteIssue(ctx.deps, actorOf(member), issue.id)).toEqual({ ok: true });
    expect(() => getIssue(ctx.deps, actorOf(member), issue.id)).toThrow(/not found/);
    expect(listTrash(ctx.deps, actorOf(member), team.team.id).items).toMatchObject([
      { type: 'issue', id: issue.id, title: 'Temporary', ref: 'API#1' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'issue.deleted', entityId: issue.id });

    expect(() => restoreIssue(ctx.deps, actorOf(other), issue.id)).toThrow(/restore your own/);
    restoreItem(ctx.deps, actorOf(member), { type: 'issue', id: issue.id });
    expect(getIssue(ctx.deps, actorOf(member), issue.id).title).toBe('Temporary');
    expect(events.at(-1)).toMatchObject({ type: 'issue.restored', entityId: issue.id });
    expect(() => restoreIssue(ctx.deps, actorOf(member), issue.id)).toThrow(/not found/);
  });

  it('lets DELETE_ANY_CONTENT and MANAGE_TRASH act on others’ issues', () => {
    const issue = open(member, 'Spam');
    deleteIssue(ctx.deps, actorOf(owner), issue.id);
    expect(restoreIssue(ctx.deps, actorOf(owner), issue.id).id).toBe(issue.id);
  });

  it('asks to restore the project first when it is in Trash', () => {
    const issue = open(member, 'In a deleted project');
    deleteIssue(ctx.deps, actorOf(member), issue.id);
    deleteProject(ctx.deps, actorOf(owner), project.project.id);
    expect(() => restoreIssue(ctx.deps, actorOf(member), issue.id)).toThrow(/project/);
  });
});

describe('issues over REST', () => {
  it('creates, reads, lists, updates, resolves, deletes and restores with an API key', async () => {
    const { key } = createApiKey(ctx.db, { userId: member.id, name: 'Codex' });
    const auth = bearer(key);
    const bug = label('Bug');
    const base = `/api/projects/${project.project.id}/issues`;

    const created = await ctx.app.request(
      base,
      json('POST', { title: '  Crash on start  ', body: 'Boom', labelIds: [bug.id] }, auth),
    );
    expect(created.status).toBe(201);
    const issue = issueSchema.parse(await created.json());
    expect(issue).toMatchObject({ title: 'Crash on start', via: { keyName: 'Codex' } });

    const byNumber = await ctx.app.request(`${base}/1`, { headers: auth });
    expect(issueSchema.parse(await byNumber.json()).id).toBe(issue.id);
    const listed = await ctx.app.request(`${base}?state=all&labels=${bug.id}&sort=newest`, {
      headers: auth,
    });
    expect(issueListResponseSchema.parse(await listed.json()).items).toHaveLength(1);
    const invalid = await ctx.app.request(`${base}?sort=random`, { headers: auth });
    expect(invalid.status).toBe(400);

    const patched = await ctx.app.request(
      `/api/issues/${issue.id}`,
      json('PATCH', { labels: { set: [] }, title: 'Crash on startup' }, auth),
    );
    expect(issueSchema.parse(await patched.json())).toMatchObject({
      title: 'Crash on startup',
      labels: [],
    });
    const empty = await ctx.app.request(`/api/issues/${issue.id}`, json('PATCH', {}, auth));
    expect(empty.status).toBe(400);

    const resolved = await ctx.app.request(`/api/issues/${issue.id}/resolve`, {
      method: 'POST',
      headers: auth,
    });
    expect(issueSchema.parse(await resolved.json()).resolved).toBe(true);
    const reopened = await ctx.app.request(`/api/issues/${issue.id}/reopen`, {
      method: 'POST',
      headers: auth,
    });
    expect(issueSchema.parse(await reopened.json()).resolved).toBe(false);

    const history = await ctx.app.request(`/api/activity?entityType=issue&entityId=${issue.id}`, {
      headers: auth,
    });
    expect(
      activityListResponseSchema.parse(await history.json()).items.map((entry) => entry.action),
    ).toEqual([
      'issue.created',
      'issue.updated',
      'issue.labels_changed',
      'issue.resolved',
      'issue.reopened',
    ]);

    const deleted = await ctx.app.request(`/api/issues/${issue.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    expect(okResponseSchema.parse(await deleted.json())).toEqual({ ok: true });
    const missing = await ctx.app.request(`/api/issues/${issue.id}`, { headers: auth });
    expect(missing.status).toBe(404);
    const restored = await ctx.app.request(`/api/issues/${issue.id}/restore`, {
      method: 'POST',
      headers: auth,
    });
    expect(restored.status).toBe(200);

    const { key: outsiderKey } = createApiKey(ctx.db, { userId: outsider.id });
    const hidden = await ctx.app.request(`/api/issues/${issue.id}`, {
      headers: bearer(outsiderKey),
    });
    expect(hidden.status).toBe(404);
  });
});
