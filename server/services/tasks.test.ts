import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { EVERYONE_DEFAULTS, type Permission } from '@shared/permissions';
import { apiErrorSchema } from '@shared/schemas/common';
import {
  boardQuerySchema,
  boardResponseSchema,
  listTasksQuerySchema,
  taskListResponseSchema,
  taskSchema,
  taskSummarySchema,
  type CreateTaskData,
  type Task,
} from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTask as createTaskRow,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createReply } from './replies';
import { search } from './search';
import { listTrash, restoreItem } from './trash';
import {
  createTask,
  createTaskFromIssue,
  deleteTask,
  getBoard,
  getTask,
  listTasks,
  moveTask,
  restoreTask,
  updateTask,
} from './tasks';
import { toTaskCards, toTaskSummary } from './taskViews';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let bob: UserRow;
let outsider: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let events: LiveEvent[];

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive Owner' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  bob = createUser(ctx.db, { username: 'bob', name: 'Bob' });
  outsider = createUser(ctx.db, { username: 'olga' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  addMember(ctx.db, { teamId: team.team.id, userId: bob.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

const [open, done] = [0, 1] as const;
const statusId = (index: number) => project.statuses[index]?.id ?? '';

function setEveryone(permissions: readonly Permission[]) {
  ctx.db.orm
    .update(s.role)
    .set({ permissions: [...permissions] })
    .where(eq(s.role.id, team.everyoneRole.id))
    .run();
}

function activityOf(entityId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(eq(s.activity.entityId, entityId))
    .all()
    .sort((a, b) => a.id.localeCompare(b.id));
}

function notificationsOf(user: { id: string }) {
  return ctx.db.orm.select().from(s.notification).where(eq(s.notification.userId, user.id)).all();
}

function newTask(
  title: string,
  extra: Partial<CreateTaskData> = {},
  actor: Actor = web(owner),
): Task {
  return createTask(ctx.deps, actor, project.project.id, { title, ...extra });
}

describe('creating tasks', () => {
  it('numbers tasks, uses the default status, appends to the column and audits', () => {
    const first = newTask('Fix login');
    const second = newTask('Add SSO', { description: 'Use **SAML**' });
    expect(taskSchema.parse(first)).toMatchObject({
      ref: 'API-1',
      number: 1,
      title: 'Fix login',
      status: { id: statusId(open), name: 'Open', category: 'open' },
      priority: 0,
      dueDate: null,
      claim: null,
      blocked: false,
      teamSlug: 'acme',
      projectKey: 'API',
      author: { username: 'owner' },
      via: null,
      subscribed: true,
      path: '/t/acme/p/API/tasks/1',
    });
    expect(second.ref).toBe('API-2');
    expect(second.position > first.position).toBe(true);
    const created = activityOf(first.id).find((row) => row.action === 'task.created');
    expect(created?.meta).toMatchObject({ ref: 'API-1', title: 'Fix login', status: 'Open' });
    expect(events.map((event) => event.type)).toContain('task.created');
    // Searchable by its description.
    const results = search(ctx.deps, web(owner), { q: 'saml', types: ['task'], limit: 20 });
    expect(results.results.map((result) => result.ref)).toEqual(['API-2']);
    const row = ctx.db.orm
      .select({ updatedAt: s.project.updatedAt, taskSeq: s.project.taskSeq })
      .from(s.project)
      .where(eq(s.project.id, project.project.id))
      .get();
    expect(row?.taskSeq).toBe(2);
    expect(row?.updatedAt.getTime()).toBe(project.project.updatedAt.getTime());
  });

  it('assigns members and roles, subscribes and notifies them (roles through their members)', () => {
    const backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend', slug: 'backend' });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: bob.id, roleId: backend.id })
      .run();
    const label = ctx.db.orm
      .insert(s.label)
      .values({ projectId: project.project.id, name: 'bug', color: '#ef4444' })
      .returning()
      .get();
    const task = newTask('Crash on save', {
      assigneeUserIds: [mia.id],
      assigneeRoleIds: [backend.id],
      labelIds: [label.id],
      priority: 3,
      dueDate: '2030-01-31',
    });
    expect(task.assignees.users.map((user) => user.username)).toEqual(['mia']);
    expect(task.assignees.roles.map((role) => role.slug)).toEqual(['backend']);
    expect(task.labels).toEqual([{ id: label.id, name: 'bug', color: '#ef4444' }]);
    expect(notificationsOf(mia).map((n) => n.type)).toEqual(['assigned']);
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['assigned']);
    expect(notificationsOf(owner)).toEqual([]);
    const subscribers = ctx.db.orm
      .select({ userId: s.subscription.userId })
      .from(s.subscription)
      .where(eq(s.subscription.entityId, task.id))
      .all()
      .map((row) => row.userId)
      .sort();
    expect(subscribers).toEqual([owner.id, mia.id].sort());
  });

  it('notifies members mentioned in the description', () => {
    newTask('Review', { description: 'Please look @bob' });
    expect(notificationsOf(bob).map((n) => [n.type, n.title])).toEqual([
      ['mention', 'API-1: Review'],
    ]);
  });

  it('only accepts team members, team roles (not @everyone) and project labels', () => {
    expect(() => newTask('X', { assigneeUserIds: [outsider.id] })).toThrow(/members of the team/);
    expect(() => newTask('X', { assigneeRoleIds: [team.everyoneRole.id] })).toThrow(/@everyone/);
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const foreign = ctx.db.orm
      .insert(s.label)
      .values({ projectId: other.project.id, name: 'x', color: '#000000' })
      .returning()
      .get();
    expect(() => newTask('X', { labelIds: [foreign.id] })).toThrow(/labels of this project/);
    expect(() => newTask('X', { statusId: other.statuses[0]?.id })).toThrow(/statuses/);
    // Nothing was written by the failed attempts.
    expect(
      listTasks(ctx.deps, web(owner), project.project.id, listTasksQuerySchema.parse({})).total,
    ).toBe(0);
  });

  it('needs CREATE_TASKS, and hides projects from outsiders', async () => {
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'CREATE_TASKS'));
    expect(() => newTask('X', {}, web(mia))).toThrow(/permission to create tasks/);
    const key = createApiKey(ctx.db, { userId: outsider.id }).key;
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks`,
      json('POST', { title: 'Hi' }, bearer(key)),
    );
    expect(res.status).toBe(404);
  });

  it('creates over REST with a key, attributed to the key', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: mia.id, name: 'Claude on laptop' });
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks`,
      json('POST', { title: 'From an agent', priority: 4 }, bearer(key)),
    );
    expect(res.status).toBe(201);
    const task = taskSchema.parse(await res.json());
    expect(task.via).toEqual({ keyId: apiKey.id, keyName: 'Claude on laptop' });
    const row = activityOf(task.id)[0];
    expect(row).toMatchObject({ source: 'api', viaKeyName: 'Claude on laptop' });
    const bad = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks`,
      json('POST', { title: '' }, bearer(key)),
    );
    expect(bad.status).toBe(400);
  });
});

describe('updating tasks', () => {
  it('edits fields with add/remove/set lists and audits human-readable changes', () => {
    const backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend', slug: 'backend' });
    const task = newTask('Fix login', { assigneeUserIds: [mia.id] });
    const updated = updateTask(ctx.deps, web(owner), task.id, {
      title: 'Fix the login',
      priority: 2,
      dueDate: '2030-02-01',
      assigneeUsers: { add: [bob.id], remove: [mia.id] },
      assigneeRoles: { set: [backend.id] },
    });
    expect(updated.title).toBe('Fix the login');
    expect(updated.assignees.users.map((user) => user.username)).toEqual(['bob']);
    const row = activityOf(task.id).find((entry) => entry.action === 'task.updated');
    expect(row?.changes).toEqual({
      title: { from: 'Fix login', to: 'Fix the login' },
      priority: { from: 'No priority', to: 'Medium' },
      dueDate: { from: null, to: '2030-02-01' },
      assignees: { from: ['@mia'], to: ['@bob', 'Backend (role)'] },
    });
    expect(row?.meta).toEqual({ ref: 'API-1', title: 'Fix the login' });
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['assigned']);
    // Nothing to change: no audit row.
    const before = activityOf(task.id).length;
    updateTask(ctx.deps, web(owner), task.id, { priority: 2 });
    expect(activityOf(task.id)).toHaveLength(before);
    // Clearing the due date.
    expect(updateTask(ctx.deps, web(owner), task.id, { dueDate: null }).dueDate).toBeNull();
  });

  it('lets authors edit everything, others need EDIT_ANY_CONTENT or UPDATE_TASKS', () => {
    const task = newTask('Owner task');
    // Members have UPDATE_TASKS by default, not EDIT_ANY_CONTENT.
    expect(updateTask(ctx.deps, web(mia), task.id, { priority: 1 }).priority).toBe(1);
    expect(() => updateTask(ctx.deps, web(mia), task.id, { title: 'Mine now' })).toThrow(
      /your own/,
    );
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS'));
    expect(() => updateTask(ctx.deps, web(mia), task.id, { priority: 2 })).toThrow(
      /permission to update tasks/,
    );
    const own = newTask('Mia task', {}, web(mia));
    expect(
      updateTask(ctx.deps, web(mia), own.id, { title: 'Still mine', priority: 4 }),
    ).toMatchObject({
      title: 'Still mine',
      priority: 4,
    });
    expect(() => updateTask(ctx.deps, web(outsider), task.id, { priority: 1 })).toThrow(
      /Task not found/,
    );
  });

  it('re-indexes edited text, marks it edited and notifies new mentions only', () => {
    const task = newTask('Old', { description: 'hi @mia' });
    expect(notificationsOf(mia)).toHaveLength(1);
    const updated = updateTask(ctx.deps, web(owner), task.id, {
      description: 'hi @mia and @bob about zebras',
    });
    expect(updated.editedAt).not.toBeNull();
    expect(notificationsOf(mia)).toHaveLength(1);
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['mention']);
    const found = search(ctx.deps, web(owner), { q: 'zebras', types: ['task'], limit: 5 });
    expect(found.results).toHaveLength(1);
    const row = activityOf(task.id).find((entry) => entry.action === 'task.updated');
    expect(row?.changes.description).toEqual({
      from: 'hi @mia',
      to: 'hi @mia and @bob about zebras',
    });
  });
});

describe('moving tasks', () => {
  it('reorders within a column and audits the position', () => {
    const a = newTask('A');
    const b = newTask('B');
    const c = newTask('C');
    moveTask(ctx.deps, web(owner), c.id, { beforeId: a.id });
    const column = () =>
      getBoard(
        ctx.deps,
        web(owner),
        project.project.id,
        boardQuerySchema.parse({}),
      ).columns[0]?.tasks.map((task) => task.title);
    expect(column()).toEqual(['C', 'A', 'B']);
    moveTask(ctx.deps, web(owner), c.id, { afterId: b.id });
    expect(column()).toEqual(['A', 'B', 'C']);
    moveTask(ctx.deps, web(owner), a.id, { afterId: b.id });
    expect(column()).toEqual(['B', 'A', 'C']);
    const moves = activityOf(c.id).filter((row) => row.action === 'task.moved');
    expect(moves.map((row) => row.changes)).toEqual([
      { position: { from: 3, to: 1 } },
      { position: { from: 1, to: 3 } },
    ]);
    // Placing it where it already is changes nothing.
    moveTask(ctx.deps, web(owner), c.id, { afterId: a.id });
    expect(activityOf(c.id).filter((row) => row.action === 'task.moved')).toHaveLength(2);
    expect(() => moveTask(ctx.deps, web(owner), c.id, { afterId: c.id })).toThrow(/itself/);
  });

  it('moves between columns, setting and clearing completedAt', () => {
    const task = newTask('Ship it');
    const other = newTask('Done already', { statusId: statusId(done) });
    const moved = moveTask(ctx.deps, web(owner), task.id, {
      statusId: statusId(done),
      beforeId: other.id,
    });
    expect(moved.status.name).toBe('Done');
    expect(moved.completedAt).not.toBeNull();
    expect(moved.position < other.position).toBe(true);
    expect(activityOf(task.id).find((row) => row.action === 'task.moved')?.changes).toEqual({
      status: { from: 'Open', to: 'Done' },
    });
    const reopened = updateTask(ctx.deps, web(owner), task.id, { statusId: statusId(open) });
    expect(reopened.completedAt).toBeNull();
    expect(() =>
      moveTask(ctx.deps, web(owner), task.id, { statusId: statusId(done), afterId: task.id }),
    ).toThrow(/itself/);
  });

  it('repairs invalid position keys written by hand', () => {
    // The shared fixture writes `a<n>` keys; `a10` is not a valid fractional-index key.
    const rows = Array.from({ length: 11 }, (_, index) =>
      createTaskRow(ctx.db, { project: project.project, title: `T${index + 1}` }),
    );
    const last = rows.at(-1);
    const first = rows[0];
    if (!last || !first) throw new Error('fixtures');
    const moved = moveTask(ctx.deps, web(owner), last.id, { beforeId: first.id });
    expect(moved.position).toMatch(/^[a-zA-Z0-9]+$/);
    const titles = getBoard(
      ctx.deps,
      web(owner),
      project.project.id,
      boardQuerySchema.parse({}),
    ).columns[0]?.tasks.map((task) => task.title);
    expect(titles?.[0]).toBe(last.title);
    expect(new Set(titles).size).toBe(11);
    // New tasks still append at the end.
    const appended = newTask('Appended');
    const again = getBoard(ctx.deps, web(owner), project.project.id, boardQuerySchema.parse({}));
    expect(again.columns[0]?.tasks.at(-1)?.id).toBe(appended.id);
  });

  it('needs UPDATE_TASKS unless you wrote the task', () => {
    const task = newTask('Owner task');
    setEveryone(EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS'));
    expect(() => moveTask(ctx.deps, web(mia), task.id, { statusId: statusId(done) })).toThrow(
      /permission to move tasks/,
    );
  });
});

describe('done statuses', () => {
  it('resolves fixed issues, notifies the issue author, task author and assignees', () => {
    const fixed = createIssue(ctx.db, {
      project: project.project,
      authorId: bob.id,
      title: 'Login broken',
    });
    const related = createIssue(ctx.db, {
      project: project.project,
      authorId: bob.id,
      title: 'Docs',
    });
    const task = newTask(
      'Fix login',
      {
        assigneeUserIds: [mia.id],
        issueLinks: [
          { issueId: fixed.id, kind: 'fixes' },
          { issueId: related.id, kind: 'relates' },
        ],
      },
      web(bob),
    );
    const done_ = updateTask(ctx.deps, web(owner), task.id, { statusId: statusId(done) });
    expect(done_.issues.map((issue) => [issue.ref, issue.kind, issue.resolved])).toEqual([
      ['API#1', 'fixes', true],
      ['API#2', 'relates', false],
    ]);
    const issueRows = activityOf(fixed.id);
    expect(issueRows.map((row) => row.action)).toEqual(['issue.links_changed', 'issue.resolved']);
    expect(issueRows[1]?.meta).toMatchObject({ ref: 'API#1', byTask: 'API-1' });
    const resolved = ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, fixed.id)).get();
    expect(resolved).toMatchObject({ resolved: true, resolvedById: owner.id });
    // Bob authored both: one notification (the issue resolution) for this change.
    expect(notificationsOf(bob).map((n) => n.type)).toEqual(['issue_resolved']);
    expect(notificationsOf(mia).map((n) => n.type)).toEqual(['assigned', 'task_done']);
    expect(events.filter((e) => e.type === 'issue.updated').length).toBeGreaterThan(0);
  });
});

describe('links', () => {
  it('tracks blockers within a project and rejects cycles', () => {
    const a = newTask('A');
    const b = newTask('B', { blockedByTaskIds: [a.id] });
    const c = newTask('C');
    expect(b.blocked).toBe(true);
    expect(b.blockedBy.map((task) => task.ref)).toEqual(['API-1']);
    expect(getTask(ctx.deps, web(owner), a.id).blocking.map((task) => task.ref)).toEqual(['API-2']);
    updateTask(ctx.deps, web(owner), c.id, { blockedBy: { add: [b.id] } });
    expect(() => updateTask(ctx.deps, web(owner), a.id, { blockedBy: { add: [c.id] } })).toThrow(
      /cycle/,
    );
    expect(() => updateTask(ctx.deps, web(owner), a.id, { blockedBy: { add: [a.id] } })).toThrow(
      /itself/,
    );
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const foreign = createTaskRow(ctx.db, { project: other.project });
    expect(() =>
      updateTask(ctx.deps, web(owner), a.id, { blockedBy: { add: [foreign.id] } }),
    ).toThrow(/same project/);
    // Done blockers don't block.
    moveTask(ctx.deps, web(owner), a.id, { statusId: statusId(done) });
    expect(getTask(ctx.deps, web(owner), b.id).blocked).toBe(false);
    const row = activityOf(c.id).find((entry) => entry.action === 'task.updated');
    expect(row?.changes).toEqual({ blockedBy: { from: [], to: ['API-2'] } });
  });

  it('links issues of the team (audited on both sides) and changes their kind', async () => {
    const issue = createIssue(ctx.db, { project: project.project, title: 'Bug' });
    const task = newTask('Fix');
    const key = createApiKey(ctx.db, { userId: owner.id }).key;
    const res = await ctx.app.request(
      `/api/tasks/${task.id}/issues/${issue.id}`,
      json('PUT', { kind: 'relates' }, bearer(key)),
    );
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json()).issues[0]?.kind).toBe('relates');
    updateTask(ctx.deps, web(owner), task.id, {
      issueLinks: { add: [{ issueId: issue.id, kind: 'fixes' }] },
    });
    const taskRows = activityOf(task.id).filter((row) => row.action === 'task.updated');
    expect(taskRows.map((row) => row.changes)).toEqual([
      { links: { from: [], to: ['API#1 (relates)'] } },
      { links: { from: ['API#1 (relates)'], to: ['API#1 (fixes)'] } },
    ]);
    expect(activityOf(issue.id).map((row) => row.changes)).toEqual([
      { linkedTasks: { from: [], to: ['API-1 (relates)'] } },
      { linkedTasks: { from: ['API-1 (relates)'], to: ['API-1 (fixes)'] } },
    ]);
    const removed = await ctx.app.request(`/api/tasks/${task.id}/issues/${issue.id}`, {
      method: 'DELETE',
      headers: bearer(key),
    });
    expect(taskSchema.parse(await removed.json()).issues).toEqual([]);
    const otherTeam = createTeam(ctx.db, { ownerId: owner.id, slug: 'other' });
    const otherProject = createProject(ctx.db, { teamId: otherTeam.team.id, key: 'OTH' });
    const foreign = createIssue(ctx.db, { project: otherProject.project });
    expect(() =>
      updateTask(ctx.deps, web(owner), task.id, {
        issueLinks: { add: [{ issueId: foreign.id, kind: 'fixes' }] },
      }),
    ).toThrow(/same team/);
    // Blockers over REST.
    const blocker = newTask('Blocker');
    const put = await ctx.app.request(`/api/tasks/${task.id}/blocked-by/${blocker.id}`, {
      method: 'PUT',
      headers: bearer(key),
    });
    expect(taskSchema.parse(await put.json()).blocked).toBe(true);
  });
});

describe('creating a task from an issue', () => {
  it('copies the title, links back, copies labels and links it with fixes', async () => {
    const label = ctx.db.orm
      .insert(s.label)
      .values({ projectId: project.project.id, name: 'Bug', color: '#ef4444' })
      .returning()
      .get();
    const issue = createIssue(ctx.db, {
      project: project.project,
      authorId: bob.id,
      title: 'Login fails',
      body: 'Steps:\n\n1. Open the app',
    });
    ctx.db.orm.insert(s.issueLabel).values({ issueId: issue.id, labelId: label.id }).run();
    const key = createApiKey(ctx.db, { userId: mia.id }).key;
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks/from-issue`,
      json('POST', { issueId: issue.id }, bearer(key)),
    );
    expect(res.status).toBe(201);
    const task = taskSchema.parse(await res.json());
    expect(task).toMatchObject({ number: 1, ref: 'API-1', title: 'Login fails' });
    expect(task.description).toBe(
      'From issue [API#1](/t/acme/p/API/issues/1): Login fails\n\nSteps:\n\n1. Open the app',
    );
    expect(task.labels.map((l) => l.name)).toEqual(['Bug']);
    expect(task.issues.map((i) => [i.ref, i.kind])).toEqual([['API#1', 'fixes']]);
    expect(activityOf(task.id)[0]?.meta).toMatchObject({ fromIssue: 'API#1' });
    expect(activityOf(issue.id).map((row) => row.action)).toEqual(['issue.links_changed']);
    const missing = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks/from-issue`,
      json('POST', { issueId: 'nope' }, bearer(key)),
    );
    expect(missing.status).toBe(404);
    expect(
      createTaskFromIssue(ctx.deps, web(owner), project.project.id, { issueId: issue.id }).number,
    ).toBe(2);
  });
});

describe('board and list', () => {
  function board(query: Record<string, string> = {}, actor = web(owner)) {
    return boardResponseSchema.parse(
      getBoard(ctx.deps, actor, project.project.id, boardQuerySchema.parse(query)),
    );
  }
  function titles(query: Record<string, string>, actor = web(owner)) {
    return listTasks(
      ctx.deps,
      actor,
      project.project.id,
      listTasksQuerySchema.parse({ sort: 'number', ...query }),
    ).items.map((task) => task.title);
  }

  it('groups the board by status in position order with counts and a per-column limit', () => {
    newTask('A');
    newTask('B');
    newTask('C', { statusId: statusId(done) });
    const result = board();
    expect(result.total).toBe(3);
    expect(result.columns.map((column) => [column.status.name, column.count])).toEqual([
      ['Open', 2],
      ['Done', 1],
    ]);
    expect(board({ limit: '1' }).columns[0]).toMatchObject({ count: 2 });
    expect(board({ limit: '1' }).columns[0]?.tasks).toHaveLength(1);
  });

  it('filters by assignee: me (including my roles), a user, a role and unassigned', () => {
    const backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend', slug: 'backend' });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: mia.id, roleId: backend.id })
      .run();
    newTask('Direct', { assigneeUserIds: [mia.id] });
    newTask('Via role', { assigneeRoleIds: [backend.id] });
    newTask('Bob', { assigneeUserIds: [bob.id] });
    newTask('Nobody');
    expect(titles({ assignee: 'me' }, web(mia))).toEqual(['Direct', 'Via role']);
    expect(titles({ assignee: `user:${bob.id}` })).toEqual(['Bob']);
    expect(titles({ assignee: `role:${backend.id}` })).toEqual(['Via role']);
    expect(titles({ assignee: 'unassigned' })).toEqual(['Nobody']);
    expect(titles({ assignee: `unassigned,user:${bob.id}` })).toEqual(['Bob', 'Nobody']);
  });

  it('filters by due date, labels, priority, text, claim and blocked state', () => {
    const label = ctx.db.orm
      .insert(s.label)
      .values({ projectId: project.project.id, name: 'bug', color: '#ef4444' })
      .returning()
      .get();
    const overdue = newTask('Overdue', {
      dueDate: '2030-01-01',
      labelIds: [label.id],
      priority: 4,
    });
    newTask('Overdue but done', { dueDate: '2030-01-01', statusId: statusId(done) });
    newTask('Today', { dueDate: '2030-01-10', description: 'unicorn' });
    newTask('This week', { dueDate: '2030-01-16' });
    newTask('Later', { dueDate: '2030-01-17', blockedByTaskIds: [overdue.id] });
    newTask('No date');
    const today = '2030-01-10';
    expect(titles({ due: 'overdue', today })).toEqual(['Overdue']);
    expect(titles({ due: 'today', today })).toEqual(['Today']);
    expect(titles({ due: 'week', today })).toEqual(['Today', 'This week']);
    expect(titles({ due: 'none', today })).toEqual(['No date']);
    expect(titles({ label: label.id })).toEqual(['Overdue']);
    expect(titles({ priority: 'urgent,0' })).toHaveLength(6);
    expect(titles({ priority: '4' })).toEqual(['Overdue']);
    expect(titles({ q: 'unicorn' })).toEqual(['Today']);
    expect(titles({ q: 'API-5' })).toEqual(['Later']);
    expect(titles({ blocked: 'yes' })).toEqual(['Later']);
    expect(titles({ blocked: 'no' })).not.toContain('Later');
    ctx.db.orm
      .update(s.task)
      .set({
        claimedById: mia.id,
        claimedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(s.task.id, overdue.id))
      .run();
    expect(titles({ claimed: 'yes' })).toEqual(['Overdue']);
    expect(titles({ claimed: 'mine' }, web(mia))).toEqual(['Overdue']);
    expect(titles({ claimed: 'mine' })).toEqual([]);
    expect(titles({ claimed: 'no' })).not.toContain('Overdue');
  });

  it('sorts and pages the list', async () => {
    newTask('b', { priority: 1, dueDate: '2030-01-02' });
    newTask('a', { priority: 3 });
    newTask('c', { priority: 2, dueDate: '2030-01-01' });
    expect(titles({ sort: 'title' })).toEqual(['a', 'b', 'c']);
    expect(titles({ sort: 'priority', order: 'desc' })).toEqual(['a', 'c', 'b']);
    expect(titles({ sort: 'dueDate' })).toEqual(['c', 'b', 'a']);
    expect(titles({ sort: 'dueDate', order: 'desc' })).toEqual(['b', 'c', 'a']);
    const key = createApiKey(ctx.db, { userId: owner.id }).key;
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks?sort=number&limit=2`,
      { headers: bearer(key) },
    );
    const page = taskListResponseSchema.parse(await res.json());
    expect(page.items.map((task) => task.title)).toEqual(['b', 'a']);
    expect(page.total).toBe(3);
    const next = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks?sort=number&limit=2&cursor=${page.nextCursor}`,
      { headers: bearer(key) },
    );
    const second = taskListResponseSchema.parse(await next.json());
    expect(second.items.map((task) => task.title)).toEqual(['c']);
    expect(second.nextCursor).toBeNull();
    const invalid = await ctx.app.request(`/api/projects/${project.project.id}/tasks?due=someday`, {
      headers: bearer(key),
    });
    expect(apiErrorSchema.parse(await invalid.json()).error.code).toBe('validation_failed');
    const boardRes = await ctx.app.request(`/api/projects/${project.project.id}/board`, {
      headers: bearer(key),
    });
    expect(boardResponseSchema.parse(await boardRes.json()).total).toBe(3);
    const byNumber = await ctx.app.request(`/api/projects/${project.project.id}/tasks/2`, {
      headers: bearer(key),
    });
    expect(taskSchema.parse(await byNumber.json()).title).toBe('a');
  });

  it('exports the task summary contract for other modules', () => {
    const task = newTask('Summary');
    const row = ctx.db.orm.select().from(s.task).where(eq(s.task.id, task.id)).get();
    if (!row) throw new Error('missing');
    const [card] = toTaskCards(ctx.db.orm, [row]);
    if (!card) throw new Error('missing card');
    expect(Object.keys(taskSummarySchema.strict().parse(toTaskSummary(card))).sort()).toEqual(
      Object.keys(taskSummarySchema.shape).sort(),
    );
  });
});

describe('delete and restore', () => {
  it('moves tasks to Trash and back (author or MANAGE_TRASH), through the trash registry too', () => {
    const task = newTask('Temporary', {}, web(mia));
    expect(() => deleteTask(ctx.deps, web(bob), task.id)).toThrow(/your own/);
    deleteTask(ctx.deps, web(mia), task.id);
    expect(() => getTask(ctx.deps, web(mia), task.id)).toThrow(/not found/);
    expect(listTrash(ctx.deps, web(mia), team.team.id).items.map((item) => item.ref)).toEqual([
      'API-1',
    ]);
    expect(() => restoreTask(ctx.deps, web(bob), task.id)).toThrow(/your own/);
    restoreItem(ctx.deps, web(mia), { type: 'task', id: task.id });
    expect(getTask(ctx.deps, web(owner), task.id).title).toBe('Temporary');
    expect(activityOf(task.id).map((row) => row.action)).toEqual([
      'task.created',
      'task.deleted',
      'task.restored',
    ]);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['task.deleted', 'task.restored']),
    );
  });

  it("won't restore a task whose project is in Trash", () => {
    const task = newTask('Inside');
    deleteTask(ctx.deps, web(owner), task.id);
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, project.project.id))
      .run();
    expect(() => restoreTask(ctx.deps, web(owner), task.id)).toThrow(/Restore the project API/);
  });

  it('keeps replies working on tasks (thread counts and activity)', () => {
    const task = newTask('Chatty');
    createReply(ctx.deps, web(mia), { parentType: 'task', parentId: task.id, body: 'On it' });
    expect(getTask(ctx.deps, web(owner), task.id).replyCount).toBe(1);
    const sub = ctx.db.orm
      .select()
      .from(s.subscription)
      .where(and(eq(s.subscription.entityId, task.id), eq(s.subscription.userId, mia.id)))
      .get();
    expect(sub?.subscribed).toBe(true);
  });
});
