import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal, PrincipalRule } from '@shared/principals';
import { apiErrorSchema } from '@shared/schemas/common';
import type { StageRulesPatch } from '@shared/schemas/pipelines';
import { statusListResponseSchema, statusSchema, type Status } from '@shared/schemas/projects';
import { taskSchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { claimNextTask, claimTask } from './claims';
import { copyPipeline, copyPipelinePreview } from './pipelineCopy';
import { decideApproval, saveTaskEvidence } from './pipelines';
import { createStatus, deleteStatus, reorderStatuses, updateStatus } from './statuses';
import { createTask, getBoard, getTask, moveTask, updateTask } from './tasks';

/**
 * Pipelines (design §5): hand-offs, notify, exit criteria and evidence, move rules, approvals,
 * send-back, admin force, auto-advance, pools and copying a pipeline.
 */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow; // Reviewer
let ben: UserRow;
let cal: UserRow;
let annAi: UserRow; // Ann's agent
let team: CreatedTeam;
let reviewer: RoleRow;
let project: CreatedProject;
let todo: Status;
let doing: Status;
let review: Status;
let done: Status;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });
const rule = (allow: Principal[], deny: Principal[] = []): PrincipalRule => ({ allow, deny });
const user = (u: { id: string }): Principal => ({ type: 'user', userId: u.id });
const reviewers = (scope: 'people' | 'agents' | 'both' = 'people'): Principal => ({
  type: 'role',
  roleId: reviewer.id,
  scope,
});

function agentOf(human: UserRow, username: string): UserRow {
  const agent = createUser(ctx.db, { username });
  return ctx.db.orm
    .update(s.user)
    .set({ kind: 'agent', agentOwnerId: human.id })
    .where(eq(s.user.id, agent.id))
    .returning()
    .get();
}

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive' });
  ann = createUser(ctx.db, { username: 'ann', name: 'Ann' });
  ben = createUser(ctx.db, { username: 'ben', name: 'Ben' });
  cal = createUser(ctx.db, { username: 'cal', name: 'Cal' });
  annAi = agentOf(ann, 'ann_ai');
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  reviewer = createRole(ctx.db, { teamId: team.team.id, name: 'Reviewer' });
  addMember(ctx.db, { teamId: team.team.id, userId: ann.id, roleIds: [reviewer.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id });
  addMember(ctx.db, { teamId: team.team.id, userId: cal.id });
  addMember(ctx.db, { teamId: team.team.id, userId: annAi.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  const [open, closed] = project.statuses;
  if (!open || !closed) throw new Error('statuses');
  const o = web(owner);
  const inProgress = createStatus(ctx.deps, o, project.project.id, {
    name: 'In Progress',
    category: 'open',
  });
  const inReview = createStatus(ctx.deps, o, project.project.id, {
    name: 'In Review',
    category: 'open',
  });
  const ordered = reorderStatuses(ctx.deps, o, project.project.id, {
    statusIds: [open.id, inProgress.id, inReview.id, closed.id],
  }).items;
  [todo, doing, review, done] = ordered as [Status, Status, Status, Status];
});

afterEach(() => {
  ctx.close();
});

function setRules(status: Status, rules: StageRulesPatch): Status {
  return updateStatus(ctx.deps, web(owner), status.id, { rules });
}

function newTask(options: { statusId?: string; authorId?: string; assignees?: string[] } = {}) {
  return createTask(
    ctx.deps,
    web(options.authorId ? { id: options.authorId } : owner),
    project.project.id,
    {
      title: 'Ship it',
      ...(options.statusId ? { statusId: options.statusId } : {}),
      ...(options.assignees ? { assigneeUserIds: options.assignees } : {}),
    },
  );
}

function move(actor: UserRow, taskId: string, status: Status, extra: Record<string, unknown> = {}) {
  return moveTask(ctx.deps, web(actor), taskId, { statusId: status.id, ...extra });
}

function failure(fn: () => unknown): { code: string; message: string; details: unknown } {
  try {
    fn();
  } catch (error) {
    if (isAppError(error))
      return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error('expected a failure');
}

function assigneeIds(taskId: string): string[] {
  return ctx.db.orm
    .select({ id: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(eq(s.taskAssigneeUser.taskId, taskId))
    .all()
    .map((row) => row.id)
    .sort();
}

function actions(taskId: string): string[] {
  return ctx.db.orm
    .select({ action: s.activity.action })
    .from(s.activity)
    .where(and(eq(s.activity.entityType, 'task'), eq(s.activity.entityId, taskId)))
    .all()
    .map((row) => row.action);
}

describe('a project without rules', () => {
  it('behaves as before: any move, no stage on the task', () => {
    const task = newTask();
    expect(task.stage).toBeUndefined();
    expect(move(ben, task.id, done).status.name).toBe('Done');
    expect(move(ben, task.id, todo).status.name).toBe('Open');
    expect(move(ben, task.id, review).status.name).toBe('In Review');
    const board = getBoard(ctx.deps, web(ben), project.project.id, { limit: 50 });
    expect(board.columns.flatMap((column) => column.tasks)[0]).not.toHaveProperty('pipeline');
  });

  it('still records each stage visit', () => {
    const task = newTask();
    move(ben, task.id, doing);
    const entries = ctx.db.orm
      .select()
      .from(s.taskStageEntry)
      .where(eq(s.taskStageEntry.taskId, task.id))
      .all();
    expect(entries.map((entry) => [entry.statusId, entry.leftAt !== null])).toEqual([
      [todo.id, true],
      [doing.id, false],
    ]);
  });
});

describe('status rules', () => {
  it('are validated against the project and audited in words', () => {
    const updated = setRules(review, {
      approvals: { count: 1, rule: rule([reviewers()]), dismissOnChange: true },
      nextStatusId: done.id,
    });
    expect(updated.rules?.approvals?.count).toBe(1);
    expect(updated.rules?.nextStatusId).toBe(done.id);
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, review.id), eq(s.activity.action, 'status.updated')))
      .get();
    expect(row?.changes).toMatchObject({
      approvals: { from: null, to: '1 from Reviewer (people), dismissed on change' },
      nextStage: { from: null, to: 'Done' },
    });
    expect(failure(() => setRules(review, { nextStatusId: review.id })).message).toMatch(
      /own next stage/,
    );
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'OTH' });
    expect(failure(() => setRules(review, { nextStatusId: other.statuses[0]?.id })).code).toBe(
      'validation_failed',
    );
    const outsider = createUser(ctx.db);
    expect(failure(() => setRules(review, { moveRule: rule([user(outsider)]) })).code).toBe(
      'validation_failed',
    );
    expect(failure(() => setRules(review, { handoff: { mode: 'specific' } })).code).toBe(
      'validation_failed',
    );
  });

  it('are edited over REST with MANAGE_STATUSES only', async () => {
    const { key } = createApiKey(ctx.db, { userId: ben.id });
    const denied = await ctx.app.request(
      `/api/statuses/${review.id}`,
      json('PATCH', { rules: { autoAdvance: true } }, bearer(key)),
    );
    expect(denied.status).toBe(403);
    const { key: ownerKey } = createApiKey(ctx.db, { userId: owner.id });
    const res = await ctx.app.request(
      `/api/statuses/${review.id}`,
      json(
        'PATCH',
        { rules: { exitCriteria: [{ id: 'tests', text: 'Tests pass' }], instructions: '# Hi' } },
        bearer(ownerKey),
      ),
    );
    expect(res.status).toBe(200);
    const status = statusSchema.parse(await res.json());
    expect(status.rules?.exitCriteria).toEqual([{ id: 'tests', text: 'Tests pass' }]);
    const list = statusListResponseSchema.parse(
      await (
        await ctx.app.request(`/api/projects/${project.project.id}/statuses`, {
          headers: bearer(key),
        })
      ).json(),
    );
    expect(list.items.find((item) => item.id === review.id)?.rules?.instructions).toBe('# Hi');
  });
});

describe('hand-off on enter', () => {
  it('specific: assigns the rule’s users who can see the project', () => {
    setRules(review, { handoff: { mode: 'specific', rule: rule([reviewers('both')]) } });
    const task = newTask({ assignees: [ben.id] });
    move(ben, task.id, review);
    expect(assigneeIds(task.id)).toEqual([ann.id, annAi.id].sort());
    expect(actions(task.id)).toContain('task.handed_off');
    const note = ctx.db.orm
      .select()
      .from(s.notification)
      .where(and(eq(s.notification.userId, ann.id), eq(s.notification.type, 'assigned')))
      .get();
    expect(note?.entityId).toBe(task.id);
  });

  it('releases a claim the hand-off takes away, keeps it when the holder stays', () => {
    setRules(review, { handoff: { mode: 'specific', rule: rule([user(ann)]) } });
    setRules(doing, { handoff: { mode: 'mover' } });
    const task = newTask();
    claimTask(ctx.deps, web(ben), task.id, {});
    move(ben, task.id, doing);
    expect(getTask(ctx.deps, web(ben), task.id).claim?.user.username).toBe('ben');
    move(ben, task.id, review);
    expect(getTask(ctx.deps, web(ben), task.id).claim).toBeNull();
  });

  it('keeps the assignees when nobody matches', () => {
    setRules(review, {
      handoff: { mode: 'specific', rule: rule([reviewers('people')], [user(ann)]) },
    });
    const task = newTask({ assignees: [ben.id] });
    move(ben, task.id, review);
    expect(assigneeIds(task.id)).toEqual([ben.id]);
  });

  it('round_robin rotates through the rule’s users', () => {
    setRules(doing, {
      handoff: { mode: 'round_robin', rule: rule([user(ben), user(cal), user(ann)]) },
    });
    const picked = [1, 2, 3, 4].map(() => {
      const task = newTask();
      move(owner, task.id, doing);
      return assigneeIds(task.id)[0];
    });
    const order = [ben.id, cal.id, ann.id].sort();
    expect(picked).toEqual([order[0], order[1], order[2], order[0]]);
  });

  it('least_busy picks whoever has the fewest open tasks in the project', () => {
    setRules(review, { handoff: { mode: 'least_busy', rule: rule([user(ben), user(cal)]) } });
    newTask({ assignees: [ben.id] });
    newTask({ assignees: [ben.id] });
    newTask({ assignees: [cal.id], statusId: done.id }); // done: doesn't count
    const task = newTask();
    move(owner, task.id, review);
    expect(assigneeIds(task.id)).toEqual([cal.id]);
    const second = newTask();
    move(owner, second.id, review);
    newTask({ assignees: [cal.id] });
    newTask({ assignees: [cal.id] });
    const third = newTask();
    move(owner, third.id, review);
    expect(assigneeIds(third.id)).toEqual([ben.id]);
  });

  it('author, mover and stage_holder', () => {
    setRules(doing, { handoff: { mode: 'mover' } });
    setRules(review, { handoff: { mode: 'author' } });
    setRules(done, { handoff: { mode: 'stage_holder', statusId: doing.id } });
    const task = newTask({ authorId: cal.id });
    move(ben, task.id, doing);
    expect(assigneeIds(task.id)).toEqual([ben.id]);
    move(ben, task.id, review);
    expect(assigneeIds(task.id)).toEqual([cal.id]);
    move(ann, task.id, done);
    expect(assigneeIds(task.id)).toEqual([ben.id]);
  });

  it('applies when a task is created in the stage without assignees', () => {
    setRules(todo, { handoff: { mode: 'specific', rule: rule([user(cal)]) } });
    expect(assigneeIds(newTask().id)).toEqual([cal.id]);
    expect(assigneeIds(newTask({ assignees: [ben.id] }).id)).toEqual([ben.id]);
  });

  it('applies to tasks moved by deleting their status', () => {
    setRules(review, { handoff: { mode: 'specific', rule: rule([user(ann)]) } });
    const task = newTask({ statusId: doing.id });
    deleteStatus(ctx.deps, web(owner), doing.id, { moveTo: review.id });
    expect(assigneeIds(task.id)).toEqual([ann.id]);
  });
});

describe('notify on enter', () => {
  it('notifies the rule’s users (stage_entered), never the mover', () => {
    setRules(review, { notify: rule([reviewers('people'), user(ben)]) });
    const task = newTask();
    move(ben, task.id, review);
    const notes = ctx.db.orm
      .select({ userId: s.notification.userId, snippet: s.notification.snippet })
      .from(s.notification)
      .where(eq(s.notification.type, 'stage_entered'))
      .all();
    expect(notes).toEqual([{ userId: ann.id, snippet: 'Moved to In Review' }]);
  });
});

describe('exit criteria and evidence', () => {
  beforeEach(() => {
    setRules(doing, {
      exitCriteria: [
        { id: 'tests', text: 'Tests pass' },
        { id: 'pr', text: 'PR link' },
      ],
    });
  });

  it('block leaving forward until every criterion has evidence, listing what is missing', () => {
    const task = newTask({ statusId: doing.id });
    const error = failure(() => move(ben, task.id, review));
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('evidence for “Tests pass” (criterion tests)');
    expect(error.message).toContain('evidence for “PR link” (criterion pr)');
    expect(error.details).toMatchObject({ from: 'In Progress', to: 'In Review' });

    const blocked = failure(() => move(ben, task.id, review, { evidence: { tests: 'green' } }));
    expect(blocked.message).not.toContain('Tests pass');
    // The evidence was saved although the move failed.
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.criteria.map((c) => c.evidence?.text ?? null)).toEqual(['green', null]);
    expect(stage?.missing).toEqual(['evidence for “PR link” (criterion pr)']);

    const moved = move(ben, task.id, review, { evidence: { pr: 'https://x/1' } });
    expect(moved.status.name).toBe('In Review');
    expect(actions(task.id)).toContain('task.evidence_updated');
  });

  it('is locked once the task leaves the stage and shown read-only afterwards', () => {
    const task = newTask({ statusId: doing.id });
    move(ben, task.id, review, { evidence: { tests: 'green', pr: 'link' } });
    const error = failure(() =>
      saveTaskEvidence(ctx.deps, web(ben), task.id, { tests: 'changed' }),
    );
    expect(error.message).toMatch(/In Review has no exit criteria/);
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.previousEvidence).toMatchObject([
      {
        status: { name: 'In Progress' },
        criteria: [{ id: 'tests', evidence: { text: 'green' } }, { id: 'pr' }],
      },
    ]);
  });

  it('rejects unknown criteria and lets "" remove evidence', () => {
    const task = newTask({ statusId: doing.id });
    expect(
      failure(() => saveTaskEvidence(ctx.deps, web(ben), task.id, { nope: 'x' })).message,
    ).toMatch(
      /not an exit criterion of In Progress. Its criteria: tests \(Tests pass\), pr \(PR link\)/,
    );
    saveTaskEvidence(ctx.deps, web(ben), task.id, { tests: 'ok' });
    const cleared = saveTaskEvidence(ctx.deps, web(ben), task.id, { tests: '' });
    expect(cleared.stage?.criteria[0]?.evidence).toBeNull();
  });

  it('is saved over REST (PUT /api/tasks/:id/evidence) and via update', async () => {
    const task = newTask({ statusId: doing.id });
    const { key } = createApiKey(ctx.db, { userId: ben.id });
    const res = await ctx.app.request(
      `/api/tasks/${task.id}/evidence`,
      json('PUT', { evidence: { tests: 'all green' } }, bearer(key)),
    );
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json()).stage?.criteria[0]?.evidence?.text).toBe('all green');
    const updated = updateTask(ctx.deps, web(ben), task.id, {
      evidence: { pr: 'x' },
      statusId: review.id,
    });
    expect(updated.status.name).toBe('In Review');
  });
});

describe('move rule', () => {
  it('lets only matching members move the task out, naming who may', () => {
    setRules(doing, { moveRule: rule([reviewers('people'), user(cal)]) });
    const task = newTask({ statusId: doing.id });
    const error = failure(() => move(ben, task.id, review));
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('Only Reviewer (people) or @cal can move tasks out of In Progress.');
    expect(move(ann, task.id, review).status.name).toBe('In Review');
  });

  it('answers 403 over REST with the reason', async () => {
    setRules(doing, { moveRule: rule([user(cal)]) });
    const task = newTask({ statusId: doing.id });
    const { key } = createApiKey(ctx.db, { userId: ben.id });
    const res = await ctx.app.request(
      `/api/tasks/${task.id}/move`,
      json('POST', { statusId: review.id }, bearer(key)),
    );
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json()).error.message).toMatch(/Only @cal can move/);
  });
});

describe('approvals', () => {
  beforeEach(() => {
    setRules(review, {
      approvals: { count: 2, rule: rule([reviewers('both'), user(cal)]), dismissOnChange: true },
    });
  });

  it('need enough distinct eligible approvers; each counts once', () => {
    const task = newTask({ statusId: review.id });
    expect(failure(() => move(ben, task.id, done)).message).toContain(
      '2 approvals from Reviewer or @cal',
    );
    expect(
      failure(() => decideApproval(ctx.deps, web(ben), task.id, { decision: 'approve' })).message,
    ).toBe('Only Reviewer or @cal can approve tasks in In Review');
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    const again = decideApproval(ctx.deps, web(ann), task.id, {
      decision: 'approve',
      comment: 'LGTM',
    });
    expect(again.stage?.approvals).toMatchObject({ required: 2, approved: 1 });
    expect(again.stage?.approvals?.given).toHaveLength(1);
    expect(failure(() => move(ben, task.id, done)).message).toContain('1 more approval');
    // An agent counts on its own.
    decideApproval(ctx.deps, web(annAi), task.id, { decision: 'approve' });
    expect(move(ben, task.id, done).status.name).toBe('Done');
    expect(actions(task.id)).toEqual(expect.arrayContaining(['task.approved']));
  });

  it('are dismissed by edits and evidence when dismissOnChange', () => {
    setRules(review, { exitCriteria: [{ id: 'demo', text: 'Demo recorded' }] });
    const task = newTask({ statusId: review.id });
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    decideApproval(ctx.deps, web(cal), task.id, { decision: 'approve' });
    updateTask(ctx.deps, web(owner), task.id, { description: 'changed' });
    expect(getTask(ctx.deps, web(ben), task.id).stage?.approvals?.approved).toBe(0);
    expect(actions(task.id)).toContain('task.approvals_dismissed');
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    saveTaskEvidence(ctx.deps, web(ben), task.id, { demo: 'video' });
    expect(getTask(ctx.deps, web(ben), task.id).stage?.approvals?.approved).toBe(0);
  });

  it('Request changes sends the task back to the previous stage', () => {
    const task = newTask({ statusId: review.id });
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    const back = decideApproval(ctx.deps, web(cal), task.id, {
      decision: 'request_changes',
      comment: 'Needs tests',
    });
    expect(back.status.name).toBe('In Progress');
    // Coming back starts a fresh round of approvals.
    move(ben, back.id, review);
    expect(getTask(ctx.deps, web(ben), task.id).stage?.approvals?.approved).toBe(0);
    const history = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.changes_requested')))
      .get();
    expect(history?.meta).toMatchObject({ stage: 'In Review', comment: 'Needs tests' });
  });

  it('Request changes blocks leaving when the stage can’t send back', () => {
    setRules(review, { allowSendBack: false });
    const task = newTask({ statusId: review.id });
    decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    decideApproval(ctx.deps, web(annAi), task.id, { decision: 'approve' });
    decideApproval(ctx.deps, web(cal), task.id, { decision: 'request_changes' });
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.status.name).toBe('In Review');
    expect(stage?.missing).toEqual(['changes requested by @cal']);
  });

  it('are refused where the stage takes none, and posted over REST', async () => {
    const task = newTask({ statusId: doing.id });
    expect(
      failure(() => decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' })).code,
    ).toBe('conflict');
    move(ben, task.id, review);
    const { key } = createApiKey(ctx.db, { userId: ann.id });
    const res = await ctx.app.request(
      `/api/tasks/${task.id}/approvals`,
      json('POST', { decision: 'approve', comment: 'ok' }, bearer(key)),
    );
    expect(res.status).toBe(201);
    const body = taskSchema.parse(await res.json());
    expect(body.stage?.approvals?.given[0]).toMatchObject({
      decision: 'approve',
      comment: 'ok',
      user: { username: 'ann' },
      via: { keyName: 'Test key' },
    });
    const card = getBoard(ctx.deps, web(ben), project.project.id, { limit: 50 })
      .columns.flatMap((column) => column.tasks)
      .find((item) => item.id === task.id);
    expect(card?.pipeline).toEqual({
      approvals: { approved: 1, required: 2 },
      criteria: null,
      claimable: false,
    });
  });
});

describe('moving back and skipping', () => {
  beforeEach(() => {
    setRules(review, { exitCriteria: [{ id: 'ok', text: 'Checked' }] });
  });

  it('a gated stage only sends back to the previous stage', () => {
    const task = newTask({ statusId: review.id });
    expect(failure(() => move(ben, task.id, todo)).message).toBe(
      'From In Review, tasks can only be sent back to In Progress.',
    );
    expect(move(ben, task.id, doing).status.name).toBe('In Progress');
  });

  it('allow_send_back: false refuses every backward move', () => {
    setRules(review, { allowSendBack: false });
    const task = newTask({ statusId: review.id });
    expect(failure(() => move(ben, task.id, doing)).message).toBe(
      'In Review doesn’t allow moving tasks back.',
    );
  });

  it('a gated stage can’t be skipped', () => {
    const task = newTask({ statusId: doing.id });
    const error = failure(() => move(ben, task.id, done));
    expect(error.message).toContain('going through In Review first');
    const stage = getTask(ctx.deps, web(ben), task.id).stage;
    expect(stage?.blockedMoves[done.id]).toContain('going through In Review first');
    expect(stage?.blockedMoves[review.id]).toBeUndefined();
    expect(stage?.next?.name).toBe('In Review');
    expect(stage?.canMove).toBe(true);
  });

  it('next_status_id jumps over columns as the stage’s next', () => {
    setRules(doing, { nextStatusId: done.id });
    const task = newTask({ statusId: doing.id });
    expect(move(ben, task.id, done).status.name).toBe('Done');
  });
});

describe('admin force', () => {
  it('lets the owner or an administrator move past every rule with a reason', () => {
    setRules(review, { moveRule: rule([user(cal)]), exitCriteria: [{ id: 'x', text: 'X' }] });
    const task = newTask({ statusId: review.id });
    expect(
      failure(() => move(ben, task.id, done, { force: true, reason: 'hotfix' })).message,
    ).toMatch(/Only the team owner or an administrator/);
    expect(failure(() => move(owner, task.id, done, { force: true })).code).toBe(
      'validation_failed',
    );
    expect(move(owner, task.id, done, { force: true, reason: 'hotfix' }).status.name).toBe('Done');
    const forced = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.forced')))
      .get();
    expect(forced?.meta).toMatchObject({ reason: 'hotfix' });
    expect((forced?.meta as { bypassed: string[] }).bypassed).toHaveLength(2);
    expect(forced?.changes).toEqual({ status: { from: 'In Review', to: 'Done' } });

    // Administrators too.
    addMember(ctx.db, { teamId: team.team.id, userId: createUser(ctx.db, { username: 'adm' }).id });
    const adm = ctx.db.orm.select().from(s.user).where(eq(s.user.username, 'adm')).get();
    if (!adm) throw new Error('adm');
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: adm.id, roleId: team.adminRole.id })
      .run();
    const other = newTask({ statusId: review.id });
    expect(
      updateTask(ctx.deps, web(adm), other.id, { statusId: done.id, force: true, reason: 'x' })
        .status.name,
    ).toBe('Done');
  });
});

describe('auto-advance', () => {
  it('moves the task on once satisfied, one step at most', () => {
    setRules(review, {
      approvals: { count: 1, rule: rule([user(ann)]), dismissOnChange: false },
      autoAdvance: true,
    });
    // The next stage auto-advances too and has nothing to wait for: no chain.
    setRules(done, { autoAdvance: true });
    const task = newTask({ statusId: review.id });
    const after = decideApproval(ctx.deps, web(ann), task.id, { decision: 'approve' });
    expect(after.status.name).toBe('Done');
    const moved = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.moved')))
      .all();
    expect(moved.map((row) => row.meta.autoAdvance)).toEqual([true]);
    expect(moved[0]?.actorId).toBe(ann.id);
  });

  it('after evidence completes the criteria', () => {
    setRules(doing, { exitCriteria: [{ id: 'a', text: 'A' }], autoAdvance: true });
    const task = newTask({ statusId: doing.id });
    const after = saveTaskEvidence(ctx.deps, web(ben), task.id, { a: 'done' });
    expect(after.status.name).toBe('In Review');
  });

  it('does not fire when the move itself carries the evidence', () => {
    setRules(doing, { exitCriteria: [{ id: 'a', text: 'A' }], autoAdvance: true });
    const task = newTask({ statusId: doing.id });
    const after = move(ben, task.id, review, { evidence: { a: 'done' } });
    expect(after.status.name).toBe('In Review');
  });
});

describe('pools', () => {
  beforeEach(() => {
    setRules(review, { handoff: { mode: 'pool', rule: rule([reviewers('both')]) } });
  });

  it('unassign the task; only pool members claim it, which assigns them', () => {
    const task = newTask({ assignees: [ben.id] });
    move(ben, task.id, review);
    expect(assigneeIds(task.id)).toEqual([]);
    const pooled = getTask(ctx.deps, web(ann), task.id);
    expect(pooled.stage?.pool).toEqual({ rule: 'Reviewer', canClaim: true });
    expect(getTask(ctx.deps, web(ben), task.id).stage?.pool?.canClaim).toBe(false);
    const card = getBoard(ctx.deps, web(ben), project.project.id, { limit: 50 })
      .columns.flatMap((column) => column.tasks)
      .find((item) => item.id === task.id);
    expect(card?.pipeline?.claimable).toBe(true);

    expect(failure(() => claimTask(ctx.deps, web(ben), task.id, {})).message).toBe(
      'API-1 waits in a pool: only Reviewer can claim it',
    );
    const claimed = claimTask(ctx.deps, web(annAi), task.id, {});
    expect(claimed.claim?.user.username).toBe('ann_ai');
    expect(assigneeIds(task.id)).toEqual([annAi.id]);
    expect(claimed.stage?.pool).toBeNull();
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.claimed')))
      .get();
    expect(row?.meta).toMatchObject({ fromPool: true });
  });

  it('free a claim when the task enters the pool', () => {
    const task = newTask();
    claimTask(ctx.deps, web(ben), task.id, {});
    move(ben, task.id, review);
    expect(getTask(ctx.deps, web(ann), task.id).claim).toBeNull();
    expect(claimTask(ctx.deps, web(ann), task.id, {}).claim?.user.username).toBe('ann');
  });

  it('claim_next_task skips pools the caller isn’t in', () => {
    const task = newTask();
    move(ben, task.id, review);
    // Everything else is claimed.
    expect(claimNextTask(ctx.deps, web(ben), project.project.id, {}).task).toBeNull();
    expect(claimNextTask(ctx.deps, web(ann), project.project.id, {}).task?.id).toBe(task.id);
    expect(assigneeIds(task.id)).toEqual([ann.id]);
  });

  it('assigning someone takes the task out of the pool', () => {
    const task = newTask();
    move(ben, task.id, review);
    updateTask(ctx.deps, web(owner), task.id, { assigneeUsers: { set: [cal.id] } });
    expect(getTask(ctx.deps, web(ben), task.id).stage?.pool).toBeNull();
  });
});

describe('copy pipeline', () => {
  function rulesFor(projectId: string, name: string) {
    return ctx.db.orm
      .select()
      .from(s.status)
      .where(and(eq(s.status.projectId, projectId), eq(s.status.name, name)))
      .get();
  }

  beforeEach(() => {
    setRules(doing, { nextStatusId: done.id, exitCriteria: [{ id: 't', text: 'Tested' }] });
    setRules(review, {
      approvals: { count: 1, rule: rule([reviewers('people'), user(ann)]), dismissOnChange: false },
      handoff: { mode: 'stage_holder', statusId: doing.id },
    });
  });

  it('copies statuses and rules within a team', () => {
    const target = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const preview = copyPipelinePreview(
      ctx.deps,
      web(owner),
      target.project.id,
      project.project.id,
    );
    expect(preview.unresolved).toEqual([]);
    expect(preview.statuses.map((row) => [row.name, row.action])).toEqual([
      ['Open', 'update'],
      ['In Progress', 'create'],
      ['In Review', 'create'],
      ['Done', 'update'],
    ]);
    const { items } = copyPipeline(ctx.deps, web(owner), target.project.id, {
      fromProjectId: project.project.id,
    });
    expect(items.map((row) => row.name)).toEqual(['Open', 'In Progress', 'In Review', 'Done']);
    const copiedDoing = items.find((row) => row.name === 'In Progress');
    const copiedReview = items.find((row) => row.name === 'In Review');
    expect(copiedDoing?.rules?.nextStatusId).toBe(items.find((row) => row.name === 'Done')?.id);
    expect(copiedReview?.rules?.handoff).toEqual({
      mode: 'stage_holder',
      statusId: copiedDoing?.id,
    });
    expect(copiedReview?.rules?.approvals?.rule.allow).toEqual([reviewers('people'), user(ann)]);
  });

  it('flags principals the target team lacks; they must be re-picked or dropped', () => {
    const other = createTeam(ctx.db, { ownerId: owner.id, slug: 'other' });
    createRole(ctx.db, { teamId: other.team.id, name: 'reviewer' });
    addMember(ctx.db, { teamId: other.team.id, userId: cal.id });
    const target = createProject(ctx.db, { teamId: other.team.id, key: 'OTH' });
    const preview = copyPipelinePreview(
      ctx.deps,
      web(owner),
      target.project.id,
      project.project.id,
    );
    // Reviewer maps by name; Ann isn't a member of the other team.
    expect(preview.unresolved).toEqual([
      {
        key: `user:${ann.id}`,
        principal: user(ann),
        label: '@ann',
        usedIn: ['In Review: approvers'],
      },
    ]);
    expect(
      failure(() =>
        copyPipeline(ctx.deps, web(owner), target.project.id, {
          fromProjectId: project.project.id,
        }),
      ).message,
    ).toMatch(/Re-pick or drop these before copying .*@ann/);
    copyPipeline(ctx.deps, web(owner), target.project.id, {
      fromProjectId: project.project.id,
      replacements: { [`user:${ann.id}`]: user(cal) },
    });
    const copied = rulesFor(target.project.id, 'In Review');
    const otherReviewer = ctx.db.orm
      .select()
      .from(s.role)
      .where(and(eq(s.role.teamId, other.team.id), eq(s.role.name, 'reviewer')))
      .get();
    expect(copied?.approvals?.rule.allow).toEqual([
      { type: 'role', roleId: otherReviewer?.id, scope: 'people' },
      user(cal),
    ]);
  });

  it('needs MANAGE_STATUSES on both projects', () => {
    const target = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    expect(
      failure(() => copyPipelinePreview(ctx.deps, web(ben), target.project.id, project.project.id))
        .code,
    ).toBe('forbidden');
  });

  it('works over REST', async () => {
    const target = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const preview = await ctx.app.request(
      `/api/projects/${target.project.id}/pipeline/copy-preview?from=${project.project.id}`,
      { headers: bearer(key) },
    );
    expect(preview.status).toBe(200);
    const res = await ctx.app.request(
      `/api/projects/${target.project.id}/pipeline/copy`,
      json('POST', { fromProjectId: project.project.id }, bearer(key)),
    );
    expect(res.status).toBe(200);
    expect(statusListResponseSchema.parse(await res.json()).items).toHaveLength(4);
  });
});
