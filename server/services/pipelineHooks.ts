import { and, eq, inArray } from 'drizzle-orm';
import type { PrincipalRule } from '@shared/principals';
import type { StageRules } from '@shared/schemas/pipelines';
import type { Actor } from '../context';
import type { Tx } from '../db';
import * as s from '../db/schema';
import { cancelJobs, queueJobs, type QueueJobInput } from './agentJobs';
import { expandRule } from './principals';

/**
 * Extension points of the pipelines (docs/design/agents-and-pipelines.md §5) for the agent jobs of
 * §4 (Wave 2C). Every function runs **inside** the caller's write transaction, after the change it
 * reports has been written (and audited), so anything it inserts commits or rolls back with it. Do
 * no I/O here and don't emit live events directly: use `emitAfterCommit(tx, …)`.
 *
 * They turn stage entries into agent jobs (§4): `pool` jobs for the agents who may claim a pooled
 * task, `approval` jobs for the agents who may approve the stage. `queueJobs` skips agents that
 * are paused or can't see the project, and merges duplicates.
 */

type TaskRow = typeof s.task.$inferSelect;
type StatusRow = typeof s.status.$inferSelect;

export interface StageEntryDetails {
  /** The stage it left (null when the task was created in `status`). */
  from: StatusRow | null;
  /** The rules of `status` as they are now. */
  rules: StageRules;
  /** Set when the stage's hand-off put the task in a pool: who may claim it. */
  pool: PrincipalRule | null;
  /** Users the hand-off assigned (empty for `keep`, `pool` or when nobody matched). */
  assignedUserIds: string[];
  /** The stage takes approvals (`rules.approvals`): approvals given earlier were dismissed. */
  needsApprovals: boolean;
  /**
   * BAT-27: the task was sent back into the stage: why, and from which stage. Its jobs carry the
   * reason (`payload.returnReason`), and its agent assignees get an `assigned` job even when the
   * hand-off kept them.
   */
  returned?: { reason: string; from: string | null } | null;
}

/**
 * A task entered a stage: created there, moved (board, status change, claim with a move, send
 * back, auto-advance) or carried along when its status was deleted. `task` is the row after the
 * move and the hand-off. `actor` is null for system moves.
 */
export function onTaskEnteredStage(
  tx: Tx,
  task: TaskRow,
  status: StatusRow,
  actor: Actor | null,
  details: StageEntryDetails,
): void {
  const instructions = details.rules.instructions || undefined;
  const returned = details.returned ?? null;
  const jobs: QueueJobInput[] = [];
  if (details.pool) {
    for (const agentUserId of agentsOf(tx, task, details.pool, actor)) {
      jobs.push(stageJob(task, status, agentUserId, 'pool', instructions, returned));
    }
  }
  if (details.needsApprovals && details.rules.approvals) {
    for (const agentUserId of agentsOf(tx, task, details.rules.approvals.rule, actor)) {
      jobs.push(stageJob(task, status, agentUserId, 'approval', instructions, returned));
    }
  }
  if (returned) {
    // Sent back: its agent assignees in this stage pick it up again, with the reason.
    const assignees = tx
      .select({ id: s.user.id })
      .from(s.taskAssigneeUser)
      .innerJoin(s.user, eq(s.user.id, s.taskAssigneeUser.userId))
      .where(
        and(
          eq(s.taskAssigneeUser.taskId, task.id),
          eq(s.taskAssigneeUser.statusId, status.id),
          eq(s.user.kind, 'agent'),
        ),
      )
      .all()
      .map((row) => row.id)
      .filter((id) => id !== actor?.userId);
    for (const agentUserId of assignees) {
      jobs.push(stageJob(task, status, agentUserId, 'assigned', instructions, returned));
    }
  }
  if (jobs.length > 0) {
    queueJobs(
      tx,
      jobs.map((job) => ({ ...job, triggeredById: actor?.userId ?? null })),
    );
  }
}

/**
 * Someone claimed a task out of its stage's pool: it is now assigned to them. Wave 2C cancels the
 * other agents' `pool` jobs for the task here.
 */
export function onPoolTaskClaimed(tx: Tx, task: TaskRow, actor: Actor): void {
  cancelJobs(tx, {
    targetType: 'task',
    targetId: task.id,
    kinds: ['pool'],
    exceptAgentUserId: actor.userId,
  });
}

/**
 * The approvals of the task's current stage were dismissed because its title, description or
 * evidence changed (`dismissOnChange`): approvers need to look again. Wave 2C can re-create
 * `approval` jobs here.
 */
export function onStageApprovalsReset(
  tx: Tx,
  task: TaskRow,
  status: StatusRow,
  actor: Actor | null,
): void {
  const approvals = status.approvals;
  if (!approvals) return;
  const instructions = status.instructions || undefined;
  const jobs = agentsOf(tx, task, approvals.rule, actor).map((agentUserId) =>
    stageJob(task, status, agentUserId, 'approval', instructions),
  );
  if (jobs.length > 0) {
    queueJobs(
      tx,
      jobs.map((job) => ({ ...job, triggeredById: actor?.userId ?? null })),
    );
  }
}

/** The agent members `rule` matches in the task's project, except the actor itself. */
function agentsOf(tx: Tx, task: TaskRow, rule: PrincipalRule, actor: Actor | null): string[] {
  const ids = expandRule(tx, { teamId: task.teamId, projectId: task.projectId }, rule).filter(
    (id) => id !== actor?.userId,
  );
  if (ids.length === 0) return [];
  return tx
    .select({ id: s.user.id })
    .from(s.user)
    .where(and(inArray(s.user.id, ids), eq(s.user.kind, 'agent')))
    .all()
    .map((row) => row.id);
}

function stageJob(
  task: TaskRow,
  status: StatusRow,
  agentUserId: string,
  kind: 'pool' | 'approval' | 'assigned',
  instructions: string | undefined,
  returned: StageEntryDetails['returned'] = null,
): QueueJobInput {
  return {
    agentUserId,
    teamId: task.teamId,
    projectId: task.projectId,
    kind,
    targetType: 'task',
    targetId: task.id,
    payload: {
      stage: status.name,
      statusId: status.id,
      ...(instructions ? { instructions } : {}),
      ...(returned
        ? {
            returnReason: returned.reason,
            ...(returned.from ? { returnedFrom: returned.from } : {}),
          }
        : {}),
    },
  };
}
