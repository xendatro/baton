import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StageRulesPatch } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import type { CreateTaskData, Task } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  createIssue,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { claimNextTask, claimTask } from './claims';
import { getDashboard } from './dashboard';
import { listMyTasks } from './myWork';
import { getProject } from './projects';
import { createStatus, reorderStatuses, updateStatus } from './statuses';
import { createTask, getTask, moveTask, updateTask } from './tasks';
import { getTeamOverview } from './teams';

/**
 * Stages (2026-09-27): statuses have no hidden open/done category. What used to happen on "done"
 * is explicit per-stage rules (onEnter, blocksDependents, claimable, hand-off `nobody`), and
 * assignments belong to a task and a stage.
 */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow;
let ben: UserRow;
let team: CreatedTeam;
let backend: RoleRow;
let project: CreatedProject;
let todo: Status;
let doing: Status;
let review: Status;
let done: Status;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive' });
  ann = createUser(ctx.db, { username: 'ann', name: 'Ann' });
  ben = createUser(ctx.db, { username: 'ben', name: 'Ben' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend' });
  addMember(ctx.db, { teamId: team.team.id, userId: ann.id, roleIds: [backend.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  const [open, closed] = project.statuses;
  if (!open || !closed) throw new Error('statuses');
  const o = web(owner);
  const inProgress = createStatus(ctx.deps, o, project.project.id, { name: 'Doing' });
  const inReview = createStatus(ctx.deps, o, project.project.id, { name: 'Review' });
  [todo, doing, review, done] = reorderStatuses(ctx.deps, o, project.project.id, {
    statusIds: [open.id, inProgress.id, inReview.id, closed.id],
  }).items as [Status, Status, Status, Status];
});

afterEach(() => {
  ctx.close();
});

function setRules(status: Status, rules: StageRulesPatch): Status {
  return updateStatus(ctx.deps, web(owner), status.id, { rules });
}

function newTask(extra: Partial<CreateTaskData> = {}, actor: Actor = web(owner)): Task {
  return createTask(ctx.deps, actor, project.project.id, { title: 'Ship it', ...extra });
}

function move(taskId: string, status: Status, actor: Actor = web(owner)): Task {
  return moveTask(ctx.deps, actor, taskId, { statusId: status.id });
}

/** The task's rows of one stage: usernames and role names. */
function rowsOf(taskId: string, status: Status): string[] {
  const users = ctx.db.orm
    .select({ name: s.user.username })
    .from(s.taskAssigneeUser)
    .innerJoin(s.user, eq(s.user.id, s.taskAssigneeUser.userId))
    .where(and(eq(s.taskAssigneeUser.taskId, taskId), eq(s.taskAssigneeUser.statusId, status.id)))
    .all()
    .map((row) => `@${row.name ?? ''}`);
  const roles = ctx.db.orm
    .select({ name: s.role.name })
    .from(s.taskAssigneeRole)
    .innerJoin(s.role, eq(s.role.id, s.taskAssigneeRole.roleId))
    .where(and(eq(s.taskAssigneeRole.taskId, taskId), eq(s.taskAssigneeRole.statusId, status.id)))
    .all()
    .map((row) => row.name);
  return [...users, ...roles].sort();
}

/** The task's current assignees as the API shows them. */
function current(taskId: string): string[] {
  const task = getTask(ctx.deps, web(owner), taskId);
  return [
    ...task.assignees.users.map((user) => `@${user.username}`),
    ...task.assignees.roles.map((role) => role.name),
  ].sort();
}

function notificationsOf(user: { id: string }) {
  return ctx.db.orm.select().from(s.notification).where(eq(s.notification.userId, user.id)).all();
}

function actions(taskId: string): string[] {
  return ctx.db.orm
    .select({ action: s.activity.action })
    .from(s.activity)
    .where(and(eq(s.activity.entityType, 'task'), eq(s.activity.entityId, taskId)))
    .all()
    .map((row) => row.action);
}

describe('assignments per (task, stage)', () => {
  it('keep copies the previous stage’s assignees; earlier stages keep theirs as history', () => {
    const task = newTask({ assigneeUserIds: [ann.id], assigneeRoleIds: [backend.id] });
    move(task.id, doing);
    expect(current(task.id)).toEqual(['@ann', 'Backend']);
    expect(rowsOf(task.id, todo)).toEqual(['@ann', 'Backend']);
    // Assigning edits the current stage only.
    updateTask(ctx.deps, web(owner), task.id, {
      assigneeUsers: { set: [ben.id] },
      assigneeRoles: { set: [] },
    });
    expect(current(task.id)).toEqual(['@ben']);
    expect(rowsOf(task.id, todo)).toEqual(['@ann', 'Backend']);
    expect(rowsOf(task.id, doing)).toEqual(['@ben']);
  });

  it('keep restores the assignees a stage had when the task returns to it', () => {
    const task = newTask({ assigneeUserIds: [ann.id] });
    move(task.id, doing); // Ann copied into Doing
    updateTask(ctx.deps, web(owner), task.id, { assigneeUsers: { set: [ben.id] } });
    move(task.id, review); // Ben copied into Review
    move(task.id, doing); // back to Doing: Ben held it there
    expect(current(task.id)).toEqual(['@ben']);
    move(task.id, todo); // back to Open: Ann held it there, not Ben (the previous stage's)
    expect(current(task.id)).toEqual(['@ann']);
    const restored = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.handed_off')))
      .all()
      .at(-1);
    expect(restored).toMatchObject({
      changes: { assignees: { from: ['@ben'], to: ['@ann'] } },
      meta: { stage: 'Open', mode: 'keep', restored: true },
    });
    // Ann is told she has it again.
    expect(notificationsOf(ann).map((n) => n.type)).toContain('assigned');
  });

  it('keep copies the previous stage’s assignees when nobody held the stage before', () => {
    const task = newTask();
    move(task.id, doing);
    updateTask(ctx.deps, web(owner), task.id, { assigneeUsers: { set: [ann.id] } });
    // Open had nobody: the task comes back with Ann rather than with nobody.
    move(task.id, todo);
    expect(current(task.id)).toEqual(['@ann']);
  });

  it('nobody clears the stage’s assignees; the earlier holders stay as history', () => {
    const task = newTask({ assigneeUserIds: [ann.id] });
    move(task.id, done); // the seeded Done assigns nobody
    expect(current(task.id)).toEqual([]);
    expect(rowsOf(task.id, todo)).toEqual(['@ann']);
    expect(actions(task.id)).toContain('task.handed_off');
    // A custom stage can assign nobody too.
    setRules(review, { handoff: { mode: 'nobody' } });
    const other = newTask({ assigneeUserIds: [ben.id] });
    move(other.id, review);
    expect(current(other.id)).toEqual([]);
    // Reopening restores who had it.
    move(task.id, todo);
    expect(current(task.id)).toEqual(['@ann']);
  });

  it('assignees set together with a move become the new stage’s, whatever its hand-off', () => {
    const task = newTask({ assigneeUserIds: [ann.id] });
    const moved = updateTask(ctx.deps, web(owner), task.id, {
      statusId: done.id,
      assigneeUsers: { set: [ben.id] },
    });
    expect(moved.assignees.users.map((user) => user.username)).toEqual(['ben']);
    expect(rowsOf(task.id, todo)).toEqual(['@ann']);
    expect(rowsOf(task.id, done)).toEqual(['@ben']);
  });

  it('stage_holder gives the task to whoever held it in that stage (people and roles)', () => {
    setRules(review, { handoff: { mode: 'stage_holder', statusId: doing.id } });
    const task = newTask();
    move(task.id, doing);
    updateTask(ctx.deps, web(owner), task.id, {
      assigneeUsers: { set: [ann.id] },
      assigneeRoles: { set: [backend.id] },
    });
    move(task.id, todo);
    updateTask(ctx.deps, web(owner), task.id, {
      assigneeUsers: { set: [ben.id] },
      assigneeRoles: { set: [] },
    });
    move(task.id, review);
    expect(current(task.id)).toEqual(['@ann', 'Backend']);
  });

  it('pool claims assign the claimer in the current stage only', () => {
    setRules(review, {
      handoff: { mode: 'pool', rule: { allow: [{ type: 'user', userId: ann.id }], deny: [] } },
    });
    const task = newTask({ assigneeUserIds: [ben.id] });
    move(task.id, review);
    expect(current(task.id)).toEqual([]);
    claimTask(ctx.deps, web(ann), task.id, {});
    expect(current(task.id)).toEqual(['@ann']);
    expect(rowsOf(task.id, todo)).toEqual(['@ben']);
  });

  it('least_busy counts only current-stage assignments', () => {
    setRules(review, {
      handoff: {
        mode: 'least_busy',
        rule: {
          allow: [
            { type: 'user', userId: ann.id },
            { type: 'user', userId: ben.id },
          ],
          deny: [],
        },
      },
    });
    // Ben held two tasks earlier (history only); Ann holds one now.
    for (let i = 0; i < 2; i += 1) {
      const old = newTask({ assigneeUserIds: [ben.id] });
      move(old.id, done);
    }
    newTask({ assigneeUserIds: [ann.id] });
    const task = newTask();
    move(task.id, review);
    expect(current(task.id)).toEqual(['@ben']);
  });
});

describe('your work', () => {
  it('is the tasks whose current-stage assignees include you or your roles, in any stage', () => {
    const mine = newTask({ assigneeUserIds: [ann.id] });
    const viaRole = newTask({ assigneeRoleIds: [backend.id] });
    const finished = newTask({ assigneeUserIds: [ann.id] });
    move(finished.id, done); // Done assigns nobody: off her list
    // A finishing stage that keeps its assignees keeps the task on their list.
    setRules(review, { handoff: { mode: 'keep' }, blocksDependents: false });
    const inReview = newTask({ assigneeUserIds: [ann.id] });
    move(inReview.id, review);

    const list = listMyTasks(ctx.deps, web(ann), { sort: 'priority' });
    expect(list.items.map((task) => task.id).sort()).toEqual(
      [mine.id, viaRole.id, inReview.id].sort(),
    );
    expect(getDashboard(ctx.deps, web(ann), {}).counts.assigned).toBe(3);
    expect(listMyTasks(ctx.deps, web(ben), { sort: 'priority' }).total).toBe(0);
  });

  it('counts assigned tasks per project instead of open ones', () => {
    newTask({ assigneeUserIds: [ann.id] });
    newTask();
    const finished = newTask({ assigneeUserIds: [ann.id] });
    move(finished.id, done);
    expect(getProject(ctx.deps, web(owner), project.project.id).counts).toMatchObject({
      tasks: 3,
      assignedTasks: 1,
      completedTasks: 1,
      openTasks: 2,
      doneTasks: 1,
    });
    const overview = getTeamOverview(ctx.deps, web(owner), team.team.id);
    expect(overview.projects[0]).toMatchObject({ assignedTasks: 1, openTasks: 2 });
  });
});

describe('on-enter rules', () => {
  function fixedIssue(taskAuthor: UserRow = owner) {
    const issue = createIssue(ctx.db, {
      project: project.project,
      authorId: ben.id,
      title: 'Broken',
    });
    const task = newTask({ issueLinks: [{ issueId: issue.id, kind: 'fixes' }] }, web(taskAuthor));
    const resolved = () =>
      ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get()?.resolved;
    return { task, resolved };
  }

  it('resolveIssues: entering such a stage resolves the fixed issues; other stages don’t', () => {
    const { task, resolved } = fixedIssue();
    move(task.id, review);
    expect(resolved()).toBe(false);
    setRules(review, { onEnter: { resolveIssues: true } });
    move(task.id, doing);
    move(task.id, review);
    expect(resolved()).toBe(true);
  });

  it('resolveIssues off on Done: finishing no longer resolves anything', () => {
    setRules(done, { onEnter: { resolveIssues: false } });
    const { task, resolved } = fixedIssue();
    move(task.id, done);
    expect(resolved()).toBe(false);
  });

  it('notifyAuthor tells the author, notifyPreviousHolder the previous holders', () => {
    const task = newTask({ assigneeUserIds: [ann.id] }, web(ben));
    move(task.id, review);
    expect(notificationsOf(ben).map((n) => n.type)).not.toContain('task_done');
    setRules(review, { onEnter: { notifyAuthor: true } });
    move(task.id, doing);
    move(task.id, review, web(owner));
    const note = notificationsOf(ben).find((n) => n.type === 'task_done');
    expect(note?.snippet).toBe('Reached Review');
    expect(notificationsOf(ann).map((n) => n.type)).not.toContain('task_done');
    setRules(review, { onEnter: { notifyPreviousHolder: true } });
    move(task.id, doing);
    move(task.id, review, web(owner));
    expect(notificationsOf(ann).map((n) => n.type)).toContain('task_done');
  });

  it('releaseClaim: entering such a stage releases the claim; other stages keep it', () => {
    const task = newTask();
    claimTask(ctx.deps, web(ann), task.id, {});
    expect(move(task.id, review).claim?.user.username).toBe('ann');
    setRules(doing, { onEnter: { releaseClaim: true } });
    expect(move(task.id, doing).claim).toBeNull();
  });

  it('a stage that assigns nobody also drops the claim', () => {
    const task = newTask();
    claimTask(ctx.deps, web(ann), task.id, {});
    setRules(review, { handoff: { mode: 'nobody' } });
    expect(move(task.id, review).claim).toBeNull();
  });

  it('notifyAssignees off: the hand-off assigns without notifying', () => {
    setRules(review, {
      handoff: { mode: 'specific', rule: { allow: [{ type: 'user', userId: ann.id }], deny: [] } },
      onEnter: { notifyAssignees: false },
    });
    const task = newTask();
    move(task.id, review);
    expect(current(task.id)).toEqual(['@ann']);
    expect(notificationsOf(ann).map((n) => n.type)).not.toContain('assigned');
  });
});

describe('blocksDependents', () => {
  it('decides whether a blocker still blocks, and sets completedAt', () => {
    const blocker = newTask();
    const waiting = newTask({ blockedByTaskIds: [blocker.id] });
    expect(getTask(ctx.deps, web(owner), waiting.id).blocked).toBe(true);
    // A custom stage that doesn't block: the blocker counts as completed there.
    setRules(review, { blocksDependents: false });
    const inReview = move(blocker.id, review);
    expect(inReview.completedAt).not.toBeNull();
    expect(getTask(ctx.deps, web(owner), waiting.id).blocked).toBe(false);
    // Done made blocking: its tasks block again and aren't completed.
    setRules(done, { blocksDependents: true });
    const finished = move(blocker.id, done);
    expect(finished.completedAt).toBeNull();
    expect(getTask(ctx.deps, web(owner), waiting.id).blocked).toBe(true);
    // Nothing to pick: the waiting task is blocked and Done isn't claimable.
    expect(claimNextTask(ctx.deps, web(ann), project.project.id, {}).task).toBeNull();
  });
});
