import type { PrincipalRule } from '@shared/principals';
import type { StageRules } from '@shared/schemas/pipelines';
import type { Actor } from '../context';
import type { Tx } from '../db';
import type * as s from '../db/schema';

/**
 * Extension points of the pipelines (docs/design/agents-and-pipelines.md §5) for the agent jobs of
 * §4 (Wave 2C). Every function runs **inside** the caller's write transaction, after the change it
 * reports has been written (and audited), so anything it inserts commits or rolls back with it. Do
 * no I/O here and don't emit live events directly: use `emitAfterCommit(tx, …)`.
 *
 * They are deliberately no-ops today: fill in the bodies (e.g. create `pool` jobs for agents
 * matching `details.pool`, `approval` jobs for agents matching `details.rules.approvals.rule`).
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
}

/**
 * A task entered a stage: created there, moved (board, status change, claim with a move, send
 * back, auto-advance) or carried along when its status was deleted. `task` is the row after the
 * move and the hand-off. `actor` is null for system moves.
 */
export function onTaskEnteredStage(
  _tx: Tx,
  _task: TaskRow,
  _status: StatusRow,
  _actor: Actor | null,
  _details: StageEntryDetails,
): void {
  // Wave 2C: create `pool` / `approval` agent jobs here.
}

/**
 * Someone claimed a task out of its stage's pool: it is now assigned to them. Wave 2C cancels the
 * other agents' `pool` jobs for the task here.
 */
export function onPoolTaskClaimed(_tx: Tx, _task: TaskRow, _actor: Actor): void {
  // Wave 2C: cancel the task's other `pool` jobs.
}

/**
 * The approvals of the task's current stage were dismissed because its title, description or
 * evidence changed (`dismissOnChange`): approvers need to look again. Wave 2C can re-create
 * `approval` jobs here.
 */
export function onStageApprovalsReset(
  _tx: Tx,
  _task: TaskRow,
  _status: StatusRow,
  _actor: Actor | null,
): void {
  // Wave 2C: re-create `approval` jobs.
}
