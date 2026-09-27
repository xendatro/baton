import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { formatTaskRef } from '@shared/refs';
import type {
  ClaimNextResponse,
  ClaimNextTaskInput,
  ClaimTaskInput,
  ReleaseTaskInput,
  RenewClaimInput,
  Task,
} from '@shared/schemas/tasks';
import type { Actor, AppDeps } from '../context';
import type { Tx } from '../db';
import * as s from '../db/schema';
import type { Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { isOwnContent, requirePermission, type Membership } from './access';
import { recordActivity } from './activity';
import { isClaimValid, isHolder } from './claimLease';
import { emitAfterCommit } from './events';
import { queueLinkedIssueEvents } from './linkEvents';
import { onPoolTaskClaimed } from './pipelineHooks';
import {
  canClaimFromPool,
  enterStage,
  guardStageMove,
  moveMeta,
  poolClaimRefusal,
  recordForced,
  returnOf,
  takeFromPool,
} from './pipelines';
import { hiddenStatusIds } from './projectPipelines';
import { requireProject } from './projects';
import { insertReply, prepareReply } from './replies';
import {
  appendPosition,
  applyStatusTransition,
  canUpdateTask,
  getTask,
  releasedClaim,
  requireTask,
  statusOfProject,
  taskEvent,
  taskMeta,
  type TaskAccess,
  type TaskRow,
} from './tasks';
import { currentRoleRow } from './taskAssignees';
import { assignedTo, isBlocked, isUnassigned } from './taskViews';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Claims (SPEC §1.8): "(user, key) is actively working on this task". Agents claim the next
 * eligible task in one `BEGIN IMMEDIATE` transaction, so parallel callers never get the same
 * task. A claim is held until it is released, taken over, or the task enters a stage that
 * releases claims (`onEnter.releaseClaim`) or hands it to someone else (claims don't expire since
 * 2026-09-27; the sweeper in jobs/claims.ts only clears claims of deleted accounts). Only tasks in
 * `claimable` stages are claimed. Claiming and releasing need
 * `UPDATE_TASKS` (or being the task's author); taking over someone else's claim needs
 * `UPDATE_TASKS` and is audited as a takeover.
 */

/** "ethan via Claude on laptop" / "ethan (web)" for audit meta and messages. */
function holderLabel(tx: Tx, task: Pick<TaskRow, 'claimedById' | 'claimedViaKeyId'>): string {
  const user = task.claimedById
    ? getUserSummaries(tx, [task.claimedById]).get(task.claimedById)
    : undefined;
  const key = task.claimedViaKeyId
    ? getViaKeys(tx, [task.claimedViaKeyId]).get(task.claimedViaKeyId)
    : undefined;
  const name = user ? `@${user.username}` : 'a deleted user';
  return key ? `${name} via ${key.keyName}` : `${name} (web)`;
}

/** A claim held until it is released, taken over or the task is finished (no expiry). */
function claimColumns(actor: Actor, now: Date) {
  return {
    claimedById: actor.userId,
    claimedViaKeyId: actor.key?.id ?? null,
    claimedAt: now,
    claimExpiresAt: null,
  };
}

function requireClaimPermission(membership: Membership, task: Pick<TaskRow, 'authorId'>) {
  if (!canUpdateTask(membership, task)) {
    throw errors.forbidden("You don't have permission to claim tasks");
  }
}

interface ClaimMove {
  /** Columns to set with the claim. */
  patch: Partial<TaskRow>;
  /** Applies the target stage's entry rules; run after the task row is written. */
  enter: () => void;
}

const NO_MOVE: ClaimMove = { patch: {}, enter: () => undefined };

/**
 * Moves a claimed task to `statusId` inside the claim's write (end of the column), audited as
 * `task.moved`, after checking the stage rules (design §5). Returns the columns to set and the
 * entry rules to apply once they are written.
 */
function moveOnClaim(
  tx: Tx,
  actor: Actor,
  access: Pick<TaskAccess, 'project' | 'team' | 'membership'>,
  task: TaskRow,
  statusId: string,
  now: Date,
): ClaimMove {
  if (statusId === task.statusId) return NO_MOVE;
  const from = statusOfProject(tx, task.projectId, task.statusId);
  const to = statusOfProject(tx, task.projectId, statusId);
  const guard = guardStageMove(
    tx,
    actor,
    { task, project: access.project, membership: access.membership },
    from,
    to,
  );
  const patch: Partial<TaskRow> = {
    statusId: to.id,
    position: appendPosition(tx, to.id),
    ...applyStatusTransition(
      tx,
      actor,
      { task, projectKey: access.project.key, teamSlug: access.team.slug },
      from,
      to,
      now,
      new Set(),
    ).patch,
  };
  recordActivity(tx, actor, {
    teamId: task.teamId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    action: 'task.moved',
    changes: { status: { from: from.name, to: to.name } },
    meta: { ...taskMeta(task, access.project.key), status: to.name, ...moveMeta(guard) },
  });
  // Linked issues of other projects show the task's status.
  queueLinkedIssueEvents(tx, actor, [task.id]);
  return {
    patch,
    enter: () => {
      const moved = tx.select().from(s.task).where(eq(s.task.id, task.id)).get();
      if (!moved) return;
      recordForced(tx, actor, moved, access.project.key, from, to, guard.bypassed, undefined);
      enterStage(
        tx,
        actor,
        { task: moved, projectKey: access.project.key, teamSlug: access.team.slug },
        from,
        to,
        now,
        new Set(),
        returnOf(guard),
      );
    },
  };
}

/** The status to move claimed tasks to; it must be a claimable stage of the project. */
function requireClaimableStatus(tx: Tx, projectId: string, statusId: string) {
  const status = statusOfProject(tx, projectId, statusId);
  if (!status.claimable) {
    throw errors.validation(
      `Tasks in ${status.name} can’t be claimed; move claimed tasks to a stage where they can`,
    );
  }
  return status;
}

// ---------------------------------------------------------------------------------------------
// claim_next_task
// ---------------------------------------------------------------------------------------------

/** Candidates read per claim_next_task, in order, to skip pool tasks the caller can't claim. */
const CANDIDATES = 200;

/**
 * Claims the best eligible task of a project, atomically: in a claimable stage, not blocked, not
 * validly claimed, matching the filters. Tasks assigned to the caller (or their roles) in their
 * current stage come first, then unassigned ones, then the rest; within those, higher priority, earlier
 * due date (none last) and lower number first. Returns `{ task: null }` when none is eligible.
 */
export function claimNextTask(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ClaimNextTaskInput,
): ClaimNextResponse {
  const { orm } = deps.db;
  const { project, team, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'UPDATE_TASKS', "You don't have permission to claim tasks");
  if (input.roleId) {
    const role = orm
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.id, input.roleId), eq(s.role.teamId, team.id)))
      .get();
    if (!role) throw errors.validation('That role is not a role of this team');
  }
  if (input.labelId) {
    const label = orm
      .select({ id: s.label.id })
      .from(s.label)
      .where(and(eq(s.label.id, input.labelId), eq(s.label.projectId, projectId)))
      .get();
    if (!label) throw errors.validation('That label is not a label of this project');
  }
  const mine = assignedTo(actor.userId, membership.roleIds);

  // Tasks of pipelines the actor can't see are never handed out (BAT-25).
  const hidden = [...hiddenStatusIds(orm, actor.userId, [projectId])];

  const claimedId = deps.db.write((tx) => {
    const now = new Date();
    if (input.moveToStatusId) requireClaimableStatus(tx, projectId, input.moveToStatusId);
    const candidates = tx
      .select()
      .from(s.task)
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .where(
        and(
          eq(s.task.projectId, projectId),
          isNull(s.task.deletedAt),
          hidden.length > 0 ? notInArray(s.task.statusId, hidden) : undefined,
          eq(s.status.claimable, true),
          isNull(s.task.claimedById),
          sql`not ${isBlocked}`,
          input.roleId
            ? sql`exists (select 1 from ${s.taskAssigneeRole} where ${s.taskAssigneeRole.taskId} = ${s.task.id} and ${currentRoleRow} and ${s.taskAssigneeRole.roleId} = ${input.roleId})`
            : undefined,
          input.labelId
            ? sql`exists (select 1 from ${s.taskLabel} where ${s.taskLabel.taskId} = ${s.task.id} and ${s.taskLabel.labelId} = ${input.labelId})`
            : undefined,
          input.priority ? inArray(s.task.priority, input.priority) : undefined,
          input.assignedToMe ? mine : undefined,
        ),
      )
      .orderBy(
        asc(sql`case when ${mine} then 0 when ${isUnassigned} then 1 else 2 end`),
        desc(s.task.priority),
        asc(sql`${s.task.dueDate} is null`),
        asc(s.task.dueDate),
        asc(s.task.number),
      )
      .limit(CANDIDATES)
      .all();
    // Tasks waiting in a stage's pool (design §5) go only to the pool's members.
    const candidate = candidates.find(
      (row) => !row.task.poolRule || canClaimFromPool(tx, row.task, actor.userId),
    );
    if (!candidate) return null;
    const task = candidate.task;
    const poolChanges = task.poolRule ? takeFromPool(tx, actor, task) : null;
    const move = input.moveToStatusId
      ? moveOnClaim(tx, actor, { project, team, membership }, task, input.moveToStatusId, now)
      : NO_MOVE;
    tx.update(s.task)
      .set({ ...claimColumns(actor, now), ...move.patch, updatedAt: now })
      .where(eq(s.task.id, task.id))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.claimed',
      ...(poolChanges ? { changes: poolChanges } : {}),
      meta: {
        ...taskMeta(task, project.key),
        next: true,
        ...(poolChanges ? { fromPool: true } : {}),
      },
    });
    if (poolChanges) onPoolTaskClaimed(tx, task, actor);
    move.enter();
    emitAfterCommit(tx, taskEvent('task.claimed', task, actor));
    return task.id;
  });
  return { task: claimedId ? getTask(deps, actor, claimedId) : null };
}

// ---------------------------------------------------------------------------------------------
// claim_task / renew_claim / release_task
// ---------------------------------------------------------------------------------------------

function freshTask(tx: Tx, taskId: string): TaskRow {
  const row = tx
    .select()
    .from(s.task)
    .where(and(eq(s.task.id, taskId), isNull(s.task.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Task');
  return row;
}

function heldMessage(tx: Tx, task: TaskRow, ref: string): string {
  return `${ref} is claimed by ${holderLabel(tx, task)}. Pick another task, or take it over with force (needs the Update tasks permission).`;
}

/**
 * Claims a specific task. Claiming a task you already hold renews it. A claim held by someone
 * else fails unless `force` (needs `UPDATE_TASKS`; audited as `task.claim_taken_over`). A task in
 * a stage that isn't claimable must be moved to one that is (`moveToStatusId`) to be claimed.
 */
export function claimTask(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  input: ClaimTaskInput,
): Task {
  const { orm } = deps.db;
  const access = requireTask(orm, actor, taskId);
  const { project, membership } = access;
  const ref = formatTaskRef(project.key, access.task.number);
  // A task in a stage's pool (design §5) is claimed by the pool's members, who need no other
  // permission; claiming assigns it to them.
  if (access.task.poolRule) {
    if (!canClaimFromPool(orm, access.task, actor.userId)) {
      throw errors.forbidden(poolClaimRefusal(orm, access.task, ref));
    }
  } else {
    requireClaimPermission(membership, access.task);
  }

  deps.db.write((tx) => {
    const now = new Date();
    const task = freshTask(tx, taskId);
    const valid = isClaimValid(task, now);
    const mineAlready = valid && isHolder(task, actor);
    const takeover = valid && !mineAlready;
    if (takeover) {
      if (!input.force) throw errors.conflict(heldMessage(tx, task, ref));
      requirePermission(
        membership,
        'UPDATE_TASKS',
        "Taking over someone else's claim needs the Update tasks permission",
      );
    }
    const status = statusOfProject(tx, project.id, task.statusId);
    if (input.moveToStatusId) requireClaimableStatus(tx, project.id, input.moveToStatusId);
    else if (!status.claimable) {
      throw errors.conflict(
        `Tasks in ${status.name} can’t be claimed. To work on ${ref}, claim it together with a stage to move it to, one where tasks can be claimed.`,
      );
    }
    const previousHolder = takeover ? holderLabel(tx, task) : null;
    if (task.poolRule && !canClaimFromPool(tx, task, actor.userId)) {
      throw errors.forbidden(poolClaimRefusal(tx, task, ref));
    }
    const poolChanges: Changes | null = task.poolRule ? takeFromPool(tx, actor, task) : null;
    const move = input.moveToStatusId
      ? moveOnClaim(tx, actor, access, task, input.moveToStatusId, now)
      : NO_MOVE;
    const patch: Partial<TaskRow> = {
      ...(mineAlready ? {} : claimColumns(actor, now)),
      ...move.patch,
    };
    tx.update(s.task)
      .set({ ...patch, updatedAt: now })
      .where(eq(s.task.id, taskId))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: taskId,
      action: mineAlready
        ? 'task.claim_renewed'
        : takeover
          ? 'task.claim_taken_over'
          : 'task.claimed',
      ...(poolChanges ? { changes: poolChanges } : {}),
      meta: {
        ...taskMeta(task, project.key),
        ...(previousHolder ? { previousHolder } : {}),
        ...(poolChanges ? { fromPool: true } : {}),
      },
    });
    if (poolChanges) onPoolTaskClaimed(tx, task, actor);
    move.enter();
    emitAfterCommit(tx, taskEvent('task.claimed', task, actor));
  });
  return getTask(deps, actor, taskId);
}

/**
 * Renews the caller's claim to a full lease from now (the previous length unless `leaseMinutes`
 * is given). Only the holder (same user and key) can renew; a lease that ran out is renewed as
 * long as nobody else has claimed the task since.
 */
export function renewClaim(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  input: RenewClaimInput,
): Task {
  const { orm } = deps.db;
  const { project } = requireTask(orm, actor, taskId);
  deps.db.write((tx) => {
    const now = new Date();
    const task = freshTask(tx, taskId);
    const ref = formatTaskRef(project.key, task.number);
    if (!task.claimedById) {
      throw errors.conflict(`${ref} is not claimed. Claim it first (claim_task).`);
    }
    if (!isHolder(task, actor)) {
      throw errors.conflict(
        isClaimValid(task, now)
          ? `${ref} is claimed by ${holderLabel(tx, task)}, not by you`
          : `${ref} is not claimed by you. Claim it first (claim_task).`,
      );
    }
    // Claims don't expire (2026-09-27): renewing only confirms the caller still holds it.
    void input; // `leaseMinutes` is accepted and ignored, for older agents.
    emitAfterCommit(tx, taskEvent('task.claimed', task, actor));
  });
  return getTask(deps, actor, taskId);
}

/**
 * Releases a claim. The holder can always release; releasing someone else's claim needs
 * `UPDATE_TASKS`. The optional note is posted as a reply first (it needs `REPLY`). Releasing a
 * task nobody holds only posts the note.
 */
export function releaseTask(
  deps: AppDeps,
  actor: Actor,
  taskId: string,
  input: ReleaseTaskInput,
): Task {
  const { orm } = deps.db;
  const { task: before, project, membership } = requireTask(orm, actor, taskId);
  const now = new Date();
  const held = isClaimValid(before, now);
  // A person may release their agent member's claim, and the other way round (agents A).
  if (held && !isHolder(before, actor) && !isOwnContent(membership, before.claimedById)) {
    requirePermission(
      membership,
      'UPDATE_TASKS',
      "Releasing someone else's claim needs the Update tasks permission",
    );
  }
  const note = input.note?.trim();
  // The note and the release are one write: a failed release never leaves the note posted.
  const reply = note
    ? prepareReply(deps, actor, { parentType: 'task', parentId: taskId, body: note })
    : null;

  deps.db.write((tx) => {
    if (reply) insertReply(tx, actor, reply);
    const task = freshTask(tx, taskId);
    if (task.claimedById === null && task.claimedAt === null) return;
    const wasValid = isClaimValid(task, new Date());
    const previousHolder = isHolder(task, actor) ? null : holderLabel(tx, task);
    tx.update(s.task)
      .set({ ...releasedClaim(), updatedAt: new Date() })
      .where(eq(s.task.id, taskId))
      .run();
    if (!wasValid) return;
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'task.released',
      meta: {
        ...taskMeta(task, project.key),
        ...(previousHolder ? { previousHolder } : {}),
        ...(note ? { note: true } : {}),
      },
    });
    emitAfterCommit(tx, taskEvent('task.released', task, actor));
  });
  return getTask(deps, actor, taskId);
}

// ---------------------------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------------------------

/**
 * Clears the claims of deleted accounts (claims themselves don't expire), writing a system
 * `task.claim_expired` row per live task and a `task.released` event. Returns how many it cleared.
 */
export function expireClaims(deps: Pick<AppDeps, 'db'>, _now: Date = new Date()): number {
  return deps.db.write((tx) => {
    const rows = tx
      .select({ task: s.task, key: s.project.key })
      .from(s.task)
      .innerJoin(s.project, eq(s.project.id, s.task.projectId))
      .where(
        and(
          // Claims don't expire: only claims whose holder's account was deleted are cleared.
          isNotNull(s.task.claimedAt),
          isNull(s.task.claimedById),
        ),
      )
      .all();
    if (rows.length === 0) return 0;
    for (const { task, key } of rows) {
      if (task.deletedAt) continue;
      recordActivity(tx, null, {
        teamId: task.teamId,
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        action: 'task.claim_expired',
        meta: {
          ...taskMeta(task, key),
          holder: holderLabel(tx, task),
          expiredAt: task.claimExpiresAt?.toISOString() ?? null,
        },
      });
      emitAfterCommit(tx, taskEvent('task.released', task, null));
    }
    tx.update(s.task)
      .set({ ...releasedClaim(), updatedAt: sql`${s.task.updatedAt}` })
      .where(
        inArray(
          s.task.id,
          rows.map((row) => row.task.id),
        ),
      )
      .run();
    return rows.filter((row) => !row.task.deletedAt).length;
  });
}
