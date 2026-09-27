import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Status } from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { listDifficulties } from './difficulties';
import { decideApproval } from './pipelines';
import { createStatus, reorderStatuses, updateStatus } from './statuses';
import { createTask, getTask, moveTask, updateTask } from './tasks';

/**
 * Difficulty per stage (BAT-28): each stage has a default for a task's first visit, a return
 * keeps the stage's last value, any move can set it for the stage it goes to, and the task page
 * changes the current stage's only.
 */

let ctx: TestContext;
let owner: UserRow;
let project: CreatedProject;
let planning: Status;
let implementation: Status;
let review: Status;
let done: Status;
let level: Record<'Easy' | 'Normal' | 'Hard', string>;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  const team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  const levels = listDifficulties(ctx.deps, web(owner), project.project.id).items;
  level = Object.fromEntries(levels.map((item) => [item.name, item.id])) as typeof level;
  const [open, closed] = project.statuses;
  if (!open || !closed) throw new Error('statuses');
  const o = web(owner);
  const impl = createStatus(ctx.deps, o, project.project.id, {
    name: 'Implementation',
    defaultDifficultyId: level.Normal,
  });
  const rev = createStatus(ctx.deps, o, project.project.id, { name: 'Review' });
  [planning, implementation, review, done] = reorderStatuses(ctx.deps, o, project.project.id, {
    statusIds: [open.id, impl.id, rev.id, closed.id],
  }).items as [Status, Status, Status, Status];
  planning = updateStatus(ctx.deps, o, planning.id, {
    name: 'Planning',
    defaultDifficultyId: level.Hard,
  });
  updateStatus(ctx.deps, o, review.id, {
    rules: {
      sendBackTo: [implementation.id],
      approvals: {
        count: 1,
        rule: { allow: [{ type: 'user', userId: owner.id }], deny: [] },
        dismissOnChange: false,
      },
    },
  });
});

afterEach(() => {
  ctx.close();
});

function newTask(difficultyId?: string) {
  return createTask(ctx.deps, web(owner), project.project.id, {
    title: 'Ship it',
    ...(difficultyId ? { difficultyId } : {}),
  });
}

function move(taskId: string, status: Status, extra: Record<string, unknown> = {}) {
  return moveTask(ctx.deps, web(owner), taskId, { statusId: status.id, ...extra });
}

/** The task's difficulty in a stage (null: none; undefined: never been there). */
function inStage(taskId: string, status: Status): string | null | undefined {
  const row = ctx.db.orm
    .select({ id: s.taskStageDifficulty.difficultyId })
    .from(s.taskStageDifficulty)
    .where(
      and(eq(s.taskStageDifficulty.taskId, taskId), eq(s.taskStageDifficulty.statusId, status.id)),
    )
    .get();
  return row ? row.id : undefined;
}

const nameOf = (id: string | null | undefined) =>
  Object.entries(level).find(([, value]) => value === id)?.[0] ?? null;

describe('difficulty per stage', () => {
  it('a first visit takes the stage’s default, else keeps the one it came with', () => {
    const task = newTask();
    expect(task.difficulty?.name).toBe('Hard');
    expect(move(task.id, implementation).difficulty?.name).toBe('Normal');
    // Review has no default: it keeps Implementation's.
    expect(move(task.id, review).difficulty?.name).toBe('Normal');
    expect(nameOf(inStage(task.id, planning))).toBe('Hard');
  });

  it('the creator’s choice sets the first stage’s difficulty', () => {
    expect(newTask(level.Easy).difficulty?.name).toBe('Easy');
    expect(getTask(ctx.deps, web(owner), newTask(level.Easy).id).stage?.visits?.[0]).toMatchObject({
      difficulty: { name: 'Easy' },
    });
  });

  it('a return keeps the difficulty the stage had last time', () => {
    const task = newTask();
    move(task.id, implementation);
    updateTask(ctx.deps, web(owner), task.id, { difficultyId: level.Easy });
    move(task.id, review);
    const back = move(task.id, implementation, { reason: 'Failing tests' });
    expect(back.difficulty?.name).toBe('Easy');
    expect(back.stage?.visits?.map((visit) => visit.difficulty?.name ?? null)).toEqual([
      'Hard',
      'Easy',
      'Easy',
      'Easy',
    ]);
  });

  it('a move can set the difficulty for the stage it goes to, forward and back', () => {
    const task = newTask();
    const inImpl = move(task.id, implementation);
    expect(inImpl.stage?.canMoveTo?.forward).toMatchObject({
      name: 'Review',
      difficultyId: level.Normal,
    });
    expect(move(task.id, review, { difficultyId: level.Easy }).difficulty?.name).toBe('Easy');
    expect(inStage(task.id, implementation)).toBe(level.Normal);
    // Sent back after a failed review, at Hard.
    const back = move(task.id, implementation, { reason: 'Too slow', difficultyId: level.Hard });
    expect(back.difficulty?.name).toBe('Hard');
    expect(inStage(task.id, review)).toBe(level.Easy);
    // Request changes too.
    move(task.id, review);
    expect(inStage(task.id, review)).toBe(level.Easy);
    const again = decideApproval(ctx.deps, web(owner), task.id, {
      decision: 'request_changes',
      comment: 'Still slow',
      difficultyId: null,
    });
    expect(again.status.name).toBe('Implementation');
    expect(again.difficulty).toBeNull();
    const history = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.updated')))
      .all()
      .map((row) => row.changes.difficulty);
    expect(history).toContainEqual({ from: 'Easy', to: 'Hard' });
  });

  it('the task page changes the current stage’s difficulty only', () => {
    const task = newTask();
    move(task.id, implementation);
    const changed = updateTask(ctx.deps, web(owner), task.id, { difficultyId: level.Easy });
    expect(changed.difficulty?.name).toBe('Easy');
    expect(inStage(task.id, implementation)).toBe(level.Easy);
    expect(inStage(task.id, planning)).toBe(level.Hard);
    // With a status, it is the new stage's.
    const moved = updateTask(ctx.deps, web(owner), task.id, {
      statusId: review.id,
      difficultyId: level.Hard,
    });
    expect(moved.difficulty?.name).toBe('Hard');
    expect(inStage(task.id, implementation)).toBe(level.Easy);
  });

  it('a move within its own column refuses a difficulty', () => {
    const task = newTask();
    let code = '';
    try {
      moveTask(ctx.deps, web(owner), task.id, { difficultyId: level.Easy });
    } catch (error) {
      if (isAppError(error)) code = error.code;
    }
    expect(code).toBe('validation_failed');
  });
});

describe('stage defaults', () => {
  it('are levels of the project, set on create and update and audited by name', () => {
    expect(planning.defaultDifficultyId).toBe(level.Hard);
    const cleared = updateStatus(ctx.deps, web(owner), planning.id, { defaultDifficultyId: null });
    expect(cleared.defaultDifficultyId).toBeNull();
    const audit = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, planning.id), eq(s.activity.action, 'status.updated')))
      .all()
      .at(-1);
    expect(audit?.changes).toMatchObject({ defaultDifficulty: { from: 'Hard', to: null } });
    let code = '';
    try {
      updateStatus(ctx.deps, web(owner), planning.id, { defaultDifficultyId: 'not-a-level' });
    } catch (error) {
      if (isAppError(error)) code = error.code;
    }
    expect(code).toBe('validation_failed');
    // Without defaults, a task keeps what it has (as before BAT-28).
    updateStatus(ctx.deps, web(owner), implementation.id, { defaultDifficultyId: null });
    const task = newTask(level.Easy);
    expect(move(task.id, implementation).difficulty?.name).toBe('Easy');
    expect(done.defaultDifficultyId).toBeNull();
  });
});
