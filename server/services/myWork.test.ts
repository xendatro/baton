import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type RoleRow,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { addDays, dueSoonUntil, listMyTasks } from './myWork';

let ctx: TestContext;
let owner: UserRow;
let ada: UserRow;
let teamId: string;
let everyoneRoleId: string;
let backend: RoleRow;
let web: CreatedProject;

const TODAY = '2026-03-10';

function actor(user: UserRow): Actor {
  return { userId: user.id, source: 'web', key: null };
}

function assign(task: TaskRow, assignees: { users?: UserRow[]; roles?: string[] }) {
  for (const user of assignees.users ?? []) {
    ctx.db.orm.insert(s.taskAssigneeUser).values({ taskId: task.id, userId: user.id }).run();
  }
  for (const roleId of assignees.roles ?? []) {
    ctx.db.orm.insert(s.taskAssigneeRole).values({ taskId: task.id, roleId }).run();
  }
}

function update(task: TaskRow, patch: Partial<typeof s.task.$inferInsert>) {
  ctx.db.orm.update(s.task).set(patch).where(eq(s.task.id, task.id)).run();
}

function newTask(title: string, options: { project?: CreatedProject; statusId?: string } = {}) {
  const project = options.project ?? web;
  return createTask(ctx.db, {
    project: project.project,
    authorId: owner.id,
    title,
    ...(options.statusId ? { statusId: options.statusId } : {}),
  });
}

function doneStatus(project: CreatedProject = web): string {
  const done = project.statuses.find((status) => status.category === 'done');
  if (!done) throw new Error('no done status');
  return done.id;
}

function mine(query: Parameters<typeof listMyTasks>[2] = { sort: 'priority', today: TODAY }) {
  return listMyTasks(ctx.deps, actor(ada), query);
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive Owner' });
  ada = createUser(ctx.db, { username: 'ada', name: 'Ada Lovelace' });
  const created = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', name: 'Acme' });
  teamId = created.team.id;
  everyoneRoleId = created.everyoneRole.id;
  backend = createRole(ctx.db, { teamId, name: 'Backend', slug: 'backend', color: '#3b82f6' });
  addMember(ctx.db, { teamId, userId: ada.id, roleIds: [backend.id] });
  web = createProject(ctx.db, { teamId, key: 'WEB', name: 'Web app' });
});

afterEach(() => ctx.close());

describe('due dates', () => {
  it('adds calendar days across month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-29', 6)).toBe('2027-01-04');
    expect(dueSoonUntil('2026-02-26')).toBe('2026-03-04');
  });
});

describe('listMyTasks', () => {
  it('lists open tasks assigned to me directly, through my roles and through @everyone', () => {
    const direct = newTask('Direct');
    assign(direct, { users: [ada] });
    const viaRole = newTask('Via backend');
    assign(viaRole, { roles: [backend.id] });
    const viaEveryone = newTask('Via everyone');
    assign(viaEveryone, { roles: [everyoneRoleId] });
    const both = newTask('Both');
    assign(both, { users: [ada, owner], roles: [backend.id] });

    const frontend = createRole(ctx.db, { teamId, name: 'Frontend', slug: 'frontend' });
    assign(newTask('Other role'), { roles: [frontend.id] });
    assign(newTask('Other user'), { users: [owner] });
    newTask('Unassigned');
    assign(newTask('Finished', { statusId: doneStatus() }), { users: [ada] });

    const result = mine();
    expect(result.total).toBe(4);
    const byTitle = Object.fromEntries(result.items.map((task) => [task.title, task]));
    expect(Object.keys(byTitle).sort()).toEqual(['Both', 'Direct', 'Via backend', 'Via everyone']);
    expect(byTitle.Direct?.assignment).toEqual({ direct: true, roles: [] });
    expect(byTitle['Via backend']?.assignment).toEqual({
      direct: false,
      roles: [{ id: backend.id, slug: 'backend', name: 'Backend', color: '#3b82f6' }],
    });
    expect(byTitle['Via everyone']?.assignment.roles.map((role) => role.slug)).toEqual([
      'everyone',
    ]);
    expect(byTitle.Both?.assignment.direct).toBe(true);
    expect(byTitle.Both?.assignees.users.map((user) => user.username)).toEqual(['ada', 'owner']);
    expect(byTitle.Both?.assignees.roles.map((role) => role.slug)).toEqual(['backend']);
  });

  it('describes each task with its team, project, status, labels, url and ref', () => {
    const task = newTask('Fix login');
    assign(task, { users: [ada] });
    update(task, { priority: 3, dueDate: '2026-03-12', replyCount: 2 });
    const label = ctx.db.orm
      .insert(s.label)
      .values({ projectId: web.project.id, name: 'Bug', color: '#ef4444' })
      .returning()
      .get();
    ctx.db.orm.insert(s.taskLabel).values({ taskId: task.id, labelId: label.id }).run();

    const [item] = mine().items;
    expect(item).toMatchObject({
      id: task.id,
      ref: `WEB-${task.number}`,
      number: task.number,
      title: 'Fix login',
      projectId: web.project.id,
      teamId,
      status: { name: 'Open', category: 'open' },
      priority: 3,
      dueDate: '2026-03-12',
      labels: [{ id: label.id, name: 'Bug', color: '#ef4444' }],
      claim: null,
      blocked: false,
      replyCount: 2,
      team: { id: teamId, slug: 'acme', name: 'Acme' },
      project: { id: web.project.id, key: 'WEB', name: 'Web app' },
      url: `/t/acme/p/WEB/tasks/${task.number}`,
    });
  });

  it('shows a valid claim with its key and ignores an expired one', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: ada.id, name: 'Claude on laptop' });
    const claimed = newTask('Claimed');
    const expired = newTask('Expired');
    assign(claimed, { users: [ada] });
    assign(expired, { users: [ada] });
    const now = Date.now();
    update(claimed, {
      claimedById: ada.id,
      claimedViaKeyId: apiKey.id,
      claimedAt: new Date(now - 60_000),
      claimExpiresAt: new Date(now + 30 * 60_000),
    });
    update(expired, {
      claimedById: owner.id,
      claimedAt: new Date(now - 60 * 60_000),
      claimExpiresAt: new Date(now - 60_000),
    });

    const byTitle = Object.fromEntries(mine().items.map((task) => [task.title, task]));
    expect(byTitle.Claimed?.claim).toMatchObject({
      user: { username: 'ada' },
      via: { keyId: apiKey.id, keyName: 'Claude on laptop' },
    });
    expect(byTitle.Expired?.claim).toBeNull();
  });

  it('marks tasks blocked only by live blockers in open statuses', () => {
    const blocked = newTask('Blocked');
    const unblocked = newTask('Unblocked');
    const deletedBlocker = newTask('Behind a deleted task');
    assign(blocked, { users: [ada] });
    assign(unblocked, { users: [ada] });
    assign(deletedBlocker, { users: [ada] });
    const openBlocker = newTask('Open blocker');
    const doneBlocker = newTask('Done blocker', { statusId: doneStatus() });
    const trashedBlocker = newTask('Trashed blocker');
    update(trashedBlocker, { deletedAt: new Date() });
    ctx.db.orm
      .insert(s.taskDependency)
      .values([
        { taskId: blocked.id, blockedByTaskId: openBlocker.id },
        { taskId: unblocked.id, blockedByTaskId: doneBlocker.id },
        { taskId: deletedBlocker.id, blockedByTaskId: trashedBlocker.id },
      ])
      .run();

    const byTitle = Object.fromEntries(mine().items.map((task) => [task.title, task.blocked]));
    expect(byTitle).toEqual({
      Blocked: true,
      Unblocked: false,
      'Behind a deleted task': false,
    });
  });

  it('leaves out deleted tasks, deleted projects, deleted teams and teams I left', () => {
    const live = newTask('Live');
    assign(live, { users: [ada] });
    const trashed = newTask('Trashed');
    assign(trashed, { users: [ada] });
    update(trashed, { deletedAt: new Date() });

    const gone = createProject(ctx.db, { teamId, key: 'GONE' });
    const inGone = newTask('In deleted project', { project: gone });
    assign(inGone, { users: [ada] });
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, gone.project.id))
      .run();

    const other = createTeam(ctx.db, { ownerId: owner.id, slug: 'other' });
    addMember(ctx.db, { teamId: other.team.id, userId: ada.id });
    const otherProject = createProject(ctx.db, { teamId: other.team.id, key: 'OTH' });
    const inDeletedTeam = newTask('In deleted team', { project: otherProject });
    assign(inDeletedTeam, { users: [ada] });
    ctx.db.orm
      .update(s.team)
      .set({ deletedAt: new Date() })
      .where(eq(s.team.id, other.team.id))
      .run();

    const left = createTeam(ctx.db, { ownerId: owner.id, slug: 'left' });
    const leftProject = createProject(ctx.db, { teamId: left.team.id, key: 'LFT' });
    // Assigned while a member; the membership is gone now.
    assign(newTask('In a team I left', { project: leftProject }), { users: [ada] });

    expect(mine().items.map((task) => task.title)).toEqual(['Live']);
  });

  it('works across several teams', () => {
    const second = createTeam(ctx.db, { ownerId: ada.id, slug: 'second', name: 'Second' });
    const api = createProject(ctx.db, { teamId: second.team.id, key: 'API' });
    assign(newTask('Here'), { users: [ada] });
    assign(newTask('There', { project: api }), { users: [ada] });
    const result = mine();
    expect(result.items.map((task) => `${task.team.slug}/${task.ref}`).sort()).toEqual([
      'acme/WEB-1',
      'second/API-1',
    ]);
  });

  it('filters by team, project, priority, due date and text', () => {
    const api = createProject(ctx.db, { teamId, key: 'API', name: 'API' });
    const tasks = {
      overdue: newTask('Overdue report'),
      today: newTask('Due today'),
      week: newTask('Due this week'),
      later: newTask('Due later'),
      undated: newTask('No date', { project: api }),
    };
    for (const task of Object.values(tasks)) assign(task, { users: [ada] });
    update(tasks.overdue, { dueDate: '2026-03-09', priority: 4 });
    update(tasks.today, { dueDate: TODAY, priority: 3 });
    update(tasks.week, { dueDate: '2026-03-16', priority: 1 });
    update(tasks.later, { dueDate: '2026-03-17' });

    const titles = (query: Partial<Parameters<typeof listMyTasks>[2]>) =>
      mine({ sort: 'priority', today: TODAY, ...query })
        .items.map((task) => task.title)
        .sort();

    expect(titles({ due: 'overdue' })).toEqual(['Overdue report']);
    expect(titles({ due: 'today' })).toEqual(['Due today']);
    expect(titles({ due: 'week' })).toEqual(['Due this week', 'Due today']);
    expect(titles({ due: 'none' })).toEqual(['No date']);
    expect(titles({ projectId: api.project.id })).toEqual(['No date']);
    expect(titles({ teamId })).toHaveLength(5);
    expect(titles({ priority: ['urgent', 'high'] })).toEqual(['Due today', 'Overdue report']);
    expect(titles({ priority: ['none'] })).toEqual(['Due later', 'No date']);
    expect(titles({ q: 'REPORT' })).toEqual(['Overdue report']);
    expect(titles({ q: `WEB-${tasks.week.number}` })).toEqual(['Due this week']);
    expect(titles({ q: `acme/web-${tasks.week.number}` })).toEqual(['Due this week']);
    expect(titles({ q: `#${tasks.undated.number}` })).toContain('No date');
    expect(titles({ q: '100%' })).toEqual([]);
  });

  it('sorts by priority, due date, last update or creation', () => {
    const a = newTask('A');
    const b = newTask('B');
    const c = newTask('C');
    for (const task of [a, b, c]) assign(task, { users: [ada] });
    update(a, { priority: 1, dueDate: '2026-03-20', updatedAt: new Date(3000) });
    update(b, { priority: 4, updatedAt: new Date(1000) });
    update(c, { priority: 1, dueDate: '2026-03-11', updatedAt: new Date(2000) });

    const order = (sort: 'priority' | 'due' | 'updated' | 'created') =>
      mine({ sort, today: TODAY }).items.map((task) => task.title);
    expect(order('priority')).toEqual(['B', 'C', 'A']);
    expect(order('due')).toEqual(['C', 'A', 'B']);
    expect(order('updated')).toEqual(['A', 'C', 'B']);
  });

  it('answers not found for a team or project the caller cannot see', () => {
    const stranger = createTeam(ctx.db, { ownerId: owner.id, slug: 'secret' });
    const secret = createProject(ctx.db, { teamId: stranger.team.id, key: 'SEC' });
    expect(() => mine({ sort: 'priority', teamId: stranger.team.id })).toThrow(/Team not found/);
    expect(() => mine({ sort: 'priority', projectId: secret.project.id })).toThrow(
      /Project not found/,
    );
    expect(() => mine({ sort: 'priority', projectId: 'nope' })).toThrow(/Project not found/);
  });

  it('is empty for someone without teams', () => {
    const loner = createUser(ctx.db);
    expect(listMyTasks(ctx.deps, actor(loner), { sort: 'priority' })).toEqual({
      items: [],
      total: 0,
    });
  });
});
