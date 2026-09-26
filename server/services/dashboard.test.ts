import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntityType } from '@shared/constants';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { recordActivity } from './activity';
import { getDashboard, recentActivity } from './dashboard';
import { workScope } from './myWork';

let ctx: TestContext;
let owner: UserRow;
let ada: UserRow;
let teamId: string;
let web: CreatedProject;

const TODAY = '2026-03-10';

function actor(user: UserRow, key: Actor['key'] = null): Actor {
  return { userId: user.id, source: key ? 'mcp' : 'web', key };
}

function newTask(title: string, patch: Partial<typeof s.task.$inferInsert> = {}): TaskRow {
  const task = createTask(ctx.db, { project: web.project, authorId: owner.id, title });
  if (Object.keys(patch).length > 0) {
    ctx.db.orm.update(s.task).set(patch).where(eq(s.task.id, task.id)).run();
  }
  return task;
}

function assignToAda(task: TaskRow) {
  ctx.db.orm.insert(s.taskAssigneeUser).values({ taskId: task.id, userId: ada.id }).run();
}

function log(
  by: UserRow,
  entityType: ActivityEntityType,
  entityId: string,
  action: string,
  options: { team?: string; meta?: Record<string, unknown> } = {},
) {
  ctx.db.write((tx) =>
    recordActivity(tx, actor(by), {
      teamId: options.team ?? teamId,
      projectId: web.project.id,
      entityType,
      entityId,
      action,
      meta: options.meta ?? {},
    }),
  );
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ada = createUser(ctx.db, { username: 'ada', name: 'Ada' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', name: 'Acme' }).team.id;
  addMember(ctx.db, { teamId, userId: ada.id });
  web = createProject(ctx.db, { teamId, key: 'WEB', name: 'Web app' });
});

afterEach(() => ctx.close());

describe('getDashboard', () => {
  it('is empty for a user without teams (first run)', () => {
    const loner = createUser(ctx.db);
    expect(getDashboard(ctx.deps, actor(loner), { today: TODAY })).toEqual({
      today: TODAY,
      counts: { assigned: 0, overdue: 0, dueSoon: 0, claimed: 0 },
      assigned: [],
      overdue: [],
      dueSoon: [],
      claimed: [],
      activity: [],
      teams: [],
    });
  });

  it('counts and lists assigned, overdue and due-soon tasks', () => {
    const urgent = newTask('Urgent', { priority: 4 });
    const overdue = newTask('Overdue', { dueDate: '2026-03-01', priority: 1 });
    const today = newTask('Today', { dueDate: TODAY });
    const lastSoonDay = newTask('In six days', { dueDate: '2026-03-16' });
    const later = newTask('Next week', { dueDate: '2026-03-17' });
    for (const task of [urgent, overdue, today, lastSoonDay, later]) assignToAda(task);
    const done = web.statuses.find((status) => status.category === 'done');
    assignToAda(newTask('Finished', { statusId: done?.id, dueDate: '2026-03-02' }));
    newTask('Not mine', { dueDate: '2026-03-02' });

    const dashboard = getDashboard(ctx.deps, actor(ada), { today: TODAY });
    expect(dashboard.counts).toEqual({ assigned: 5, overdue: 1, dueSoon: 2, claimed: 0 });
    expect(dashboard.assigned.map((task) => task.title)).toEqual([
      'Urgent',
      'Overdue',
      'Today',
      'In six days',
      'Next week',
    ]);
    expect(dashboard.overdue.map((task) => task.title)).toEqual(['Overdue']);
    expect(dashboard.dueSoon.map((task) => task.title)).toEqual(['Today', 'In six days']);
  });

  it('uses the UTC date when the caller sends none', () => {
    const now = new Date('2026-03-10T23:30:00Z');
    const dashboard = getDashboard(ctx.deps, actor(ada), {}, now);
    expect(dashboard.today).toBe('2026-03-10');
  });

  it('lists the valid claims I hold on the web or through my keys, newest first', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: ada.id, name: 'Codex desktop' });
    const now = Date.now();
    const lease = (minutesAgo: number, key: string | null = null) => ({
      claimedById: ada.id,
      claimedViaKeyId: key,
      claimedAt: new Date(now - minutesAgo * 60_000),
      claimExpiresAt: new Date(now - minutesAgo * 60_000 + 30 * 60_000),
    });
    newTask('By my agent', lease(1, apiKey.id));
    newTask('On the web', lease(5));
    newTask('Expired', lease(40));
    newTask('Someone else', { ...lease(2), claimedById: owner.id });

    const dashboard = getDashboard(ctx.deps, actor(ada), { today: TODAY });
    expect(dashboard.counts.claimed).toBe(2);
    expect(dashboard.claimed.map((task) => [task.title, task.claim?.via?.keyName ?? null])).toEqual(
      [
        ['By my agent', 'Codex desktop'],
        ['On the web', null],
      ],
    );
    expect(dashboard.claimed[0]?.assignment).toEqual({ direct: false, roles: [] });
  });

  it('lists my teams with member counts and their live projects with open counts', () => {
    const api = createProject(ctx.db, { teamId, key: 'API', name: 'API', description: 'REST' });
    const gone = createProject(ctx.db, { teamId, key: 'OLD', name: 'Old' });
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, gone.project.id))
      .run();
    newTask('Open one');
    createIssue(ctx.db, { project: api.project, title: 'Question' });
    createTeam(ctx.db, { ownerId: owner.id, slug: 'elsewhere' });

    const { teams } = getDashboard(ctx.deps, actor(ada), { today: TODAY });
    expect(teams).toEqual([
      {
        id: teamId,
        slug: 'acme',
        name: 'Acme',
        icon: null,
        color: expect.any(String) as string,
        memberCount: 2,
        url: '/t/acme',
        projects: [
          expect.objectContaining({
            key: 'API',
            description: 'REST',
            openTasks: 0,
            openIssues: 1,
            url: '/t/acme/p/API',
          }),
          expect.objectContaining({ key: 'WEB', openTasks: 1, openIssues: 0 }),
        ],
      },
    ]);
  });
});

describe('recent activity', () => {
  it('shows members per-item history only, and everything to audit-log readers', () => {
    const task = newTask('Visible task');
    log(owner, 'task', task.id, 'task.created', { meta: { ref: 'WEB-1', title: 'Visible task' } });
    log(owner, 'role', 'role1', 'role.created', { meta: { name: 'Backend' } });
    log(owner, 'project', web.project.id, 'project.updated');

    const forAda = getDashboard(ctx.deps, actor(ada), { today: TODAY }).activity;
    expect(forAda.map((entry) => entry.action)).toEqual(['task.created']);
    expect(forAda[0]).toMatchObject({
      actor: { user: { username: 'owner' } },
      url: `/t/acme/p/WEB/tasks/${task.number}`,
    });

    const forOwner = getDashboard(ctx.deps, actor(owner), { today: TODAY }).activity;
    expect(forOwner.map((entry) => entry.action)).toEqual([
      'project.updated',
      'role.created',
      'task.created',
    ]);
  });

  it('hides items in Trash from members who may not restore them', () => {
    const mine = createTask(ctx.db, { project: web.project, authorId: ada.id, title: 'Mine' });
    const theirs = newTask('Theirs');
    log(ada, 'task', mine.id, 'task.created');
    log(owner, 'task', theirs.id, 'task.created');
    for (const task of [mine, theirs]) {
      ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    }
    const activity = getDashboard(ctx.deps, actor(ada), { today: TODAY }).activity;
    expect(activity.map((entry) => entry.entityId)).toEqual([mine.id]);
  });

  it('never shows other teams or account-level rows', () => {
    const other = createTeam(ctx.db, { ownerId: owner.id, slug: 'other' }).team.id;
    const task = newTask('Elsewhere');
    log(owner, 'task', task.id, 'task.created', { team: other });
    ctx.db.write((tx) =>
      recordActivity(tx, actor(ada), {
        teamId: null,
        entityType: 'user',
        entityId: ada.id,
        action: 'user.signed_in',
      }),
    );
    expect(getDashboard(ctx.deps, actor(ada), { today: TODAY }).activity).toEqual([]);
  });

  it('keeps scanning past rows the member may not see and stops at the limit', () => {
    const task = newTask('Busy');
    for (let index = 0; index < 150; index += 1) log(owner, 'role', `r${index}`, 'role.updated');
    for (let index = 0; index < 5; index += 1) log(owner, 'task', task.id, 'task.updated');
    for (let index = 0; index < 120; index += 1)
      log(owner, 'invite', `i${index}`, 'invite.created');

    const scope = workScope(ctx.db.orm, ada.id);
    const rows = recentActivity(ctx.db.orm, scope.memberships, 3);
    expect(rows.map((row) => row.action)).toEqual(['task.updated', 'task.updated', 'task.updated']);
    const ownerScope = workScope(ctx.db.orm, owner.id);
    expect(recentActivity(ctx.db.orm, ownerScope.memberships, 30)).toHaveLength(30);
  });
});
