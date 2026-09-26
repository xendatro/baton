import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { CLAIM_LEASE } from '@shared/constants';
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
import { errors } from '../lib/errors';
import { formatDistanceStrict } from 'date-fns';
import { requirePermission, type Membership } from './access';
import { recordActivity } from './activity';
import { isClaimValid, isHolder, leaseEnd, leaseMinutesOf } from './claimLease';
import { emitAfterCommit } from './events';
import { queueLinkedIssueEvents } from './linkEvents';
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
import { assignedTo, isBlocked, isUnassigned } from './taskViews';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Claims (SPEC §1.8): "(user, key) is actively working on this task". Agents claim the next
 * eligible task in one `BEGIN IMMEDIATE` transaction, so parallel callers never get the same
 * task. Leases last 5–240 minutes (30 by default); any write by the holder renews them, and the
 * sweeper (jobs/claims.ts) clears expired ones every minute. Claiming and releasing need
 * `UPDATE_TASKS` (or being the task's author); taking over someone else's claim needs
 * `UPDATE_TASKS` and is audited as a takeover.
 */

const DEFAULT_LEASE = CLAIM_LEASE.defaultMinutes;

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

function claimColumns(actor: Actor, now: Date, minutes: number) {
  return {
    claimedById: actor.userId,
    claimedViaKeyId: actor.key?.id ?? null,
    claimedAt: now,
    claimExpiresAt: leaseEnd(now, minutes),
  };
}

function requireClaimPermission(membership: Membership, task: Pick<TaskRow, 'authorId'>) {
  if (!canUpdateTask(membership, task)) {
    throw errors.forbidden("You don't have permission to claim tasks");
  }
}

/**
 * Moves a claimed task to `statusId` inside the claim's write (end of the column), audited as
 * `task.moved`. Returns the columns to set.
 */
function moveOnClaim(
  tx: Tx,
  actor: Actor,
  access: Pick<TaskAccess, 'project' | 'team'>,
  task: TaskRow,
  statusId: string,
  now: Date,
): Partial<TaskRow> {
  if (statusId === task.statusId) return {};
  const from = statusOfProject(tx, task.projectId, task.statusId);
  const to = statusOfProject(tx, task.projectId, statusId);
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
    meta: { ...taskMeta(task, access.project.key), status: to.name },
  });
  // Linked issues of other projects show the task's status.
  queueLinkedIssueEvents(tx, actor, [task.id]);
  return patch;
}

/** The status to move claimed tasks to; it must be an open-category status of the project. */
function requireOpenStatus(tx: Tx, projectId: string, statusId: string) {
  const status = statusOfProject(tx, projectId, statusId);
  if (status.category !== 'open') {
    throw errors.validation(
      `${status.name} is a done status; claimed tasks can only move to an open status`,
    );
  }
  return status;
}

// ---------------------------------------------------------------------------------------------
// claim_next_task
// ---------------------------------------------------------------------------------------------

/**
 * Claims the best eligible task of a project, atomically: in an open-category status, not
 * blocked, not validly claimed, matching the filters. Tasks assigned to the caller (or their
 * roles) come first, then unassigned ones, then the rest; within those, higher priority, earlier
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
  const minutes = input.leaseMinutes ?? DEFAULT_LEASE;
  const mine = assignedTo(actor.userId, membership.roleIds);

  const claimedId = deps.db.write((tx) => {
    const now = new Date();
    if (input.moveToStatusId) requireOpenStatus(tx, projectId, input.moveToStatusId);
    const candidate = tx
      .select()
      .from(s.task)
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .where(
        and(
          eq(s.task.projectId, projectId),
          isNull(s.task.deletedAt),
          eq(s.status.category, 'open'),
          or(
            isNull(s.task.claimedById),
            isNull(s.task.claimExpiresAt),
            lte(s.task.claimExpiresAt, now),
          ),
          sql`not ${isBlocked}`,
          input.roleId
            ? sql`exists (select 1 from ${s.taskAssigneeRole} where ${s.taskAssigneeRole.taskId} = ${s.task.id} and ${s.taskAssigneeRole.roleId} = ${input.roleId})`
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
      .limit(1)
      .get();
    if (!candidate) return null;
    const task = candidate.task;
    const patch: Partial<TaskRow> = {
      ...claimColumns(actor, now, minutes),
      ...(input.moveToStatusId
        ? moveOnClaim(tx, actor, { project, team }, task, input.moveToStatusId, now)
        : {}),
    };
    const updated = tx
      .update(s.task)
      .set({ ...patch, updatedAt: now })
      .where(eq(s.task.id, task.id))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.claimed',
      meta: {
        ...taskMeta(task, project.key),
        leaseMinutes: minutes,
        expiresAt: updated.claimExpiresAt?.toISOString() ?? null,
        next: true,
      },
    });
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

function heldMessage(tx: Tx, task: TaskRow, ref: string, now: Date): string {
  const left = task.claimExpiresAt
    ? formatDistanceStrict(task.claimExpiresAt, now, { roundingMethod: 'ceil' })
    : 'a while';
  return `${ref} is claimed by ${holderLabel(tx, task)} for another ${left}. Pick another task, or take it over with force (needs the Update tasks permission).`;
}

/**
 * Claims a specific task. Claiming a task you already hold renews it. A claim held by someone
 * else fails unless `force` (needs `UPDATE_TASKS`; audited as `task.claim_taken_over`). A task in
 * a done status must be moved to an open status (`moveToStatusId`) to be claimed.
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
  requireClaimPermission(membership, access.task);
  const minutes = input.leaseMinutes ?? DEFAULT_LEASE;
  const ref = formatTaskRef(project.key, access.task.number);

  deps.db.write((tx) => {
    const now = new Date();
    const task = freshTask(tx, taskId);
    const valid = isClaimValid(task, now);
    const mineAlready = valid && isHolder(task, actor);
    const takeover = valid && !mineAlready;
    if (takeover) {
      if (!input.force) throw errors.conflict(heldMessage(tx, task, ref, now));
      requirePermission(
        membership,
        'UPDATE_TASKS',
        "Taking over someone else's claim needs the Update tasks permission",
      );
    }
    const status = statusOfProject(tx, project.id, task.statusId);
    if (input.moveToStatusId) requireOpenStatus(tx, project.id, input.moveToStatusId);
    else if (status.category === 'done') {
      throw errors.conflict(
        `${ref} is ${status.name} (done). Move it to an open status to work on it (moveToStatusId).`,
      );
    }
    const previousHolder = takeover ? holderLabel(tx, task) : null;
    const patch: Partial<TaskRow> = {
      ...(mineAlready
        ? { claimExpiresAt: leaseEnd(now, minutes) }
        : claimColumns(actor, now, minutes)),
      ...(input.moveToStatusId
        ? moveOnClaim(tx, actor, access, task, input.moveToStatusId, now)
        : {}),
    };
    const updated = tx
      .update(s.task)
      .set({ ...patch, updatedAt: now })
      .where(eq(s.task.id, taskId))
      .returning()
      .get();
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
      meta: {
        ...taskMeta(task, project.key),
        leaseMinutes: minutes,
        expiresAt: updated.claimExpiresAt?.toISOString() ?? null,
        ...(previousHolder ? { previousHolder } : {}),
      },
    });
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
    const minutes = input.leaseMinutes ?? leaseMinutesOf(tx, taskId);
    const expiresAt = leaseEnd(now, minutes);
    tx.update(s.task)
      .set({ claimExpiresAt: expiresAt, updatedAt: sql`${s.task.updatedAt}` })
      .where(eq(s.task.id, taskId))
      .run();
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: taskId,
      action: 'task.claim_renewed',
      meta: {
        ...taskMeta(task, project.key),
        leaseMinutes: minutes,
        expiresAt: expiresAt.toISOString(),
      },
    });
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
  if (held && !isHolder(before, actor)) {
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
 * Clears every claim whose lease ended by `now` (and claims of deleted accounts), writing a
 * system `task.claim_expired` row per live task and a `task.released` event. Returns how many
 * claims expired.
 */
export function expireClaims(deps: Pick<AppDeps, 'db'>, now: Date = new Date()): number {
  return deps.db.write((tx) => {
    const rows = tx
      .select({ task: s.task, key: s.project.key })
      .from(s.task)
      .innerJoin(s.project, eq(s.project.id, s.task.projectId))
      .where(
        and(
          or(isNotNull(s.task.claimedAt), isNotNull(s.task.claimedById)),
          or(
            isNull(s.task.claimedById),
            isNull(s.task.claimExpiresAt),
            lte(s.task.claimExpiresAt, now),
          ),
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
