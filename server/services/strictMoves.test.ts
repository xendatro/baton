import { and, desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRule } from '@shared/principals';
import type { StageRulesPatch } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { EVERYONE_DEFAULTS } from '@shared/permissions';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { decideApproval, saveTaskEvidence } from './pipelines';
import { createStatus, reorderStatuses, updateStatus } from './statuses';
import { createTask, getTask, moveTask, updateTask } from './tasks';

/**
 * Strict moves (BAT-27): forward only to the next stage through its leave rules, back only to the
 * checked earlier stages with a reason, a fresh review on every return.
 */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow; // approver
let ben: UserRow; // developer
let annAi: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let todo: Status;
let doing: Status;
let review: Status;
let done: Status;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });
const only = (user: { id: string }): PrincipalRule => ({
  allow: [{ type: 'user', userId: user.id }],
  deny: [],
});

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ann = createUser(ctx.db, { username: 'ann' });
  ben = createUser(ctx.db, { username: 'ben' });
  annAi = createUser(ctx.db, { username: 'ann-ai' });
  ctx.db.orm
    .update(s.user)
    .set({ kind: 'agent', agentOwnerId: ann.id })
    .where(eq(s.user.id, annAi.id))
    .run();
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  for (const user of [ann, ben, annAi])
    addMember(ctx.db, { teamId: team.team.id, userId: user.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  const [open, closed] = project.statuses;
  if (!open || !closed) throw new Error('statuses');
  const o = web(owner);
  const inProgress = createStatus(ctx.deps, o, project.project.id, {
    name: 'Implementation',
    rules: { allowCreate: true },
  });
  const inReview = createStatus(ctx.deps, o, project.project.id, {
    name: 'Human Review',
    rules: { allowCreate: true },
  });
  [todo, doing, review, done] = reorderStatuses(ctx.deps, o, project.project.id, {
    statusIds: [open.id, inProgress.id, inReview.id, closed.id],
  }).items as [Status, Status, Status, Status];
  setRules(review, {
    sendBackTo: [doing.id],
    exitCriteria: [{ id: 'demo', text: 'Demo recorded' }],
    approvals: { count: 1, rule: only(ann), dismissOnChange: false },
  });
});

afterEach(() => {
  ctx.close();
});

function setRules(status: Status, rules: StageRulesPatch): Status {
  return updateStatus(ctx.deps, web(owner), status.id, { rules });
}

function newTask(statusId?: string) {
  return createTask(ctx.deps, web(owner), project.project.id, {
    title: 'Ship it',
    ...(statusId ? { statusId } : {}),
  });
}

function move(actor: UserRow, taskId: string, status: Status, extra: Record<string, unknown> = {}) {
  return moveTask(ctx.deps, web(actor), taskId, { statusId: status.id, ...extra });
}

function failure(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a failure');
}

/** Gives evidence and Ann's approval for Human Review, then moves the task on to Done. */
function passReview(taskId: string) {
  saveTaskEvidence(ctx.deps, web(ben), taskId, { demo: 'video.mp4' });
  decideApproval(ctx.deps, web(ann), taskId, { decision: 'approve' });
  return move(ben, taskId, done);
}

describe('forward', () => {
  it('goes only to the next stage, through its leave rules; no skipping', () => {
    const task = newTask();
    expect(failure(() => move(ben, task.id, review)).message).toBe(
      'From Open, tasks only move on to Implementation.',
    );
    move(ben, task.id, doing);
    expect(failure(() => move(ben, task.id, done)).message).toBe(
      'From Implementation, tasks only move on to Human Review.',
    );
    move(ben, task.id, review);
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.canMoveTo?.forward).toMatchObject({ id: done.id, name: 'Done' });
    expect(stage?.canMoveTo?.forward?.missing).toEqual([
      'evidence for “Demo recorded” (criterion demo)',
      '1 approval from @ann',
    ]);
    expect(failure(() => move(ben, task.id, done)).code).toBe('conflict');
    expect(passReview(task.id).status.name).toBe('Done');
  });

  it('follows nextStatusId, and the last stage has no forward move', () => {
    setRules(todo, { nextStatusId: doing.id });
    setRules(doing, { nextStatusId: done.id });
    const task = newTask(doing.id);
    expect(getTask(ctx.deps, web(ben), task.id).stage?.canMoveTo?.forward?.name).toBe('Done');
    expect(failure(() => move(ben, task.id, review)).message).toBe(
      'From Implementation, tasks only move on to Done.',
    );
    move(ben, task.id, done);
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.next).toBeNull();
    expect(stage?.canMoveTo?.forward).toBeNull();
  });
});

describe('back', () => {
  it('only to the checked stages, always with a reason', () => {
    const task = newTask(review.id);
    expect(getTask(ctx.deps, web(ben), task.id).stage?.canMoveTo?.back).toEqual([
      { id: doing.id, name: 'Implementation', difficultyId: null },
    ]);
    expect(failure(() => move(ben, task.id, todo, { reason: 'x' })).message).toBe(
      'From Human Review, tasks can only be sent back to Implementation.',
    );
    expect(failure(() => move(ben, task.id, doing)).code).toBe('validation_failed');
    expect(failure(() => move(ben, task.id, doing, { reason: '   ' })).code).toBe(
      'validation_failed',
    );
    // No approvals or evidence needed to go back.
    expect(move(ben, task.id, doing, { reason: 'Crashes on start' }).status.name).toBe(
      'Implementation',
    );
    // An empty list: it can't be sent back.
    setRules(doing, { sendBackTo: [] });
    expect(failure(() => move(ben, task.id, todo, { reason: 'x' })).message).toBe(
      'Implementation doesn’t send tasks back.',
    );
  });

  it('stores the reason on the new visit, posts it in the thread and audits it', () => {
    const task = newTask(review.id);
    move(ben, task.id, doing, { reason: 'Crashes on start' });
    const entry = ctx.db.orm
      .select()
      .from(s.taskStageEntry)
      .where(eq(s.taskStageEntry.taskId, task.id))
      .orderBy(desc(s.taskStageEntry.enteredAt), desc(s.taskStageEntry.id))
      .get();
    expect(entry).toMatchObject({
      statusId: doing.id,
      returnReason: 'Crashes on start',
      returnedById: ben.id,
      returnedFromStatusId: review.id,
    });
    const reply = ctx.db.orm
      .select()
      .from(s.reply)
      .where(and(eq(s.reply.parentType, 'task'), eq(s.reply.parentId, task.id)))
      .get();
    expect(reply).toMatchObject({
      authorId: ben.id,
      body: 'Sent back from Human Review: Crashes on start',
    });
    const moved = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.moved')))
      .get();
    expect(moved?.meta).toMatchObject({ direction: 'back', reason: 'Crashes on start' });
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.returnReason).toMatchObject({
      reason: 'Crashes on start',
      by: { username: 'ben' },
      from: { name: 'Human Review' },
    });
    // It applies while the task is in that visit only.
    move(ben, task.id, review);
    expect(getTask(ctx.deps, web(ben), task.id).stage?.returnReason).toBeNull();
    expect(
      getTask(ctx.deps, web(ben), task.id).stage?.visits?.map((visit) => visit.status.name),
    ).toEqual(['Human Review', 'Implementation', 'Human Review']);
  });

  it('may be done by whoever may move it on, or approve the stage', () => {
    setRules(review, { moveRule: only(owner) });
    // Ben may neither move it on nor approve.
    const task = newTask(review.id);
    expect(failure(() => move(ben, task.id, doing, { reason: 'x' })).message).toMatch(
      /^Only @owner or its approvers \(@ann\) can send tasks back from Human Review/,
    );
    // Ann may approve, so she may send it back even without UPDATE_TASKS.
    const everyone = ctx.db.orm
      .select()
      .from(s.role)
      .where(and(eq(s.role.teamId, team.team.id), eq(s.role.isEveryone, true)))
      .get();
    ctx.db.orm
      .update(s.role)
      .set({ permissions: EVERYONE_DEFAULTS.filter((p) => p !== 'UPDATE_TASKS') })
      .where(eq(s.role.id, everyone?.id ?? ''))
      .run();
    expect(getTask(ctx.deps, web(ann), task.id).stage?.canMoveTo?.back).toHaveLength(1);
    expect(move(ann, task.id, doing, { reason: 'Not what we asked' }).status.name).toBe(
      'Implementation',
    );
    // …but not move it anywhere else.
    expect(failure(() => move(ann, task.id, review)).code).toBe('forbidden');
  });

  it('only accepts earlier stages of the same pipeline in sendBackTo', () => {
    expect(failure(() => setRules(doing, { sendBackTo: [review.id] })).message).toBe(
      'A stage can only send tasks back to earlier stages of its own pipeline',
    );
    expect(failure(() => setRules(doing, { sendBackTo: [doing.id] })).code).toBe(
      'validation_failed',
    );
    expect(setRules(done, { sendBackTo: [todo.id, review.id] }).rules?.sendBackTo).toEqual([
      todo.id,
      review.id,
    ]);
  });

  it('a new stage can send back to every earlier stage; seeded Done to Open', () => {
    expect(done.rules?.sendBackTo).toEqual([todo.id]);
    const extra = createStatus(ctx.deps, web(owner), project.project.id, { name: 'Shipped' });
    expect(extra.rules?.sendBackTo).toEqual([todo.id, doing.id, review.id, done.id]);
  });
});

describe('coming back to a stage', () => {
  it('clears its approvals and needs new evidence; the old ones stay as a previous visit', () => {
    const task = newTask(review.id);
    saveTaskEvidence(ctx.deps, web(ben), task.id, { demo: 'first.mp4' });
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve', comment: 'Fine' });
    move(ben, task.id, doing, { reason: 'Found a bug' });
    const back = move(ben, task.id, review);
    const stage = back.stage;
    expect(stage?.criteria).toEqual([{ id: 'demo', text: 'Demo recorded', evidence: null }]);
    expect(stage?.approvals).toMatchObject({ approved: 0, given: [] });
    expect(stage?.canMoveTo?.forward?.missing).toHaveLength(2);
    expect(stage?.previousEvidence).toMatchObject([
      {
        status: { name: 'Human Review' },
        visit: { leftAt: expect.any(String) as string },
        criteria: [{ id: 'demo', evidence: { text: 'first.mp4' } }],
      },
    ]);
    expect(stage?.previousApprovals).toMatchObject([
      { status: { name: 'Human Review' }, decisions: [{ decision: 'approve', comment: 'Fine' }] },
    ]);
    // New evidence for the new visit; the old row stays archived.
    saveTaskEvidence(ctx.deps, web(ben), task.id, { demo: 'second.mp4' });
    const rows = ctx.db.orm
      .select()
      .from(s.taskStageEvidence)
      .where(eq(s.taskStageEvidence.taskId, task.id))
      .all();
    expect(rows.map((row) => [row.text, row.archivedAt !== null]).sort()).toEqual([
      ['first.mp4', true],
      ['second.mp4', false],
    ]);
  });
});

describe('Request changes', () => {
  beforeEach(() => {
    setRules(review, { sendBackTo: [todo.id, doing.id] });
  });

  it('sends it back to the nearest checked stage with the comment as the reason', () => {
    const task = newTask(review.id);
    expect(
      failure(() => decideApproval(ctx.deps, web(ann), task.id, { decision: 'request_changes' }))
        .code,
    ).toBe('validation_failed');
    const back = decideApproval(ctx.deps, web(ann), task.id, {
      decision: 'request_changes',
      comment: 'Add tests',
    });
    expect(back.status.name).toBe('Implementation');
    expect(back.stage?.returnReason).toMatchObject({
      reason: 'Add tests',
      by: { username: 'ann' },
    });
    const moved = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.moved')))
      .get();
    expect(moved?.meta).toMatchObject({ direction: 'back', reason: 'Add tests' });
  });

  it('lets the reviewer pick the stage among the checked ones', () => {
    const task = newTask(review.id);
    expect(
      failure(() =>
        decideApproval(ctx.deps, web(ann), task.id, {
          decision: 'request_changes',
          comment: 'x',
          sendBackTo: done.id,
        }),
      ).message,
    ).toBe('From Human Review, tasks can only be sent back to Implementation or Open');
    const back = decideApproval(ctx.deps, web(ann), task.id, {
      decision: 'request_changes',
      comment: 'Start over',
      sendBackTo: todo.id,
    });
    expect(back.status.name).toBe('Open');
  });
});

describe('agent jobs', () => {
  it('carry the reason to the returned stage’s agents, even when the hand-off kept them', () => {
    const task = newTask(doing.id);
    updateTask(ctx.deps, web(owner), task.id, { assigneeUsers: { set: [annAi.id] } });
    move(owner, task.id, review);
    // Human Review keeps the agent: going back changes no assignee.
    move(ann, task.id, doing, { reason: 'The build is red' });
    const jobs = ctx.db.orm
      .select()
      .from(s.agentJob)
      .where(and(eq(s.agentJob.agentUserId, annAi.id), eq(s.agentJob.kind, 'assigned')))
      .all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      stage: 'Implementation',
      statusId: doing.id,
      returnReason: 'The build is red',
      returnedFrom: 'Human Review',
    });
  });
});

describe('force', () => {
  it('lets the owner make any move with a reason; a forced move back is a return', () => {
    const task = newTask();
    expect(move(owner, task.id, done, { force: true, reason: 'Duplicate' }).status.name).toBe(
      'Done',
    );
    const back = move(owner, task.id, todo, { force: true, reason: 'Not a duplicate' });
    expect(back.stage?.returnReason?.reason).toBe('Not a duplicate');
    expect(
      ctx.db.orm
        .select()
        .from(s.activity)
        .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.forced')))
        .all(),
    ).toHaveLength(1);
  });
});
