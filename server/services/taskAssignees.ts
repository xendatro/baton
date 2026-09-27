import { and, eq, inArray, sql } from 'drizzle-orm';
import { formatTaskRef } from '@shared/refs';
import type { Actor } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change } from '../lib/diff';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';

/**
 * Assignees that leave a task because of something outside the task: a member removed from the
 * team (or leaving it, or deleting their account) loses their direct assignments, and a deleted
 * role stops being an assignee. Each affected task records the change in its own history, like an
 * edit of its assignees (`task.updated`, `changes.assignees` with the same labels as the tasks
 * service: `@username` for people, "Name (role)" for roles; `meta.reason` says why), and gets a
 * `task.updated` event so open boards, task pages and work lists drop the assignee.
 */

// ---------------------------------------------------------------------------------------------
// Assignments per stage
// ---------------------------------------------------------------------------------------------

/**
 * Assignments belong to a task and a stage (`task_assignee_*.status_id`). A task's current
 * assignees are its rows for its current status; rows of other statuses record who held it there.
 * Inside a subquery on `task`, these conditions keep only the current stage's rows.
 */
export const currentUserRow = sql`${s.taskAssigneeUser.statusId} = ${s.task.statusId}`;
export const currentRoleRow = sql`${s.taskAssigneeRole.statusId} = ${s.task.statusId}`;

/** Users assigned to the task in `statusId` (directly). */
export function stageUserIds(db: DbExecutor, taskId: string, statusId: string): string[] {
  return db
    .select({ id: s.taskAssigneeUser.userId })
    .from(s.taskAssigneeUser)
    .where(and(eq(s.taskAssigneeUser.taskId, taskId), eq(s.taskAssigneeUser.statusId, statusId)))
    .all()
    .map((row) => row.id);
}

/** Roles assigned to the task in `statusId`. */
export function stageRoleIds(db: DbExecutor, taskId: string, statusId: string): string[] {
  return db
    .select({ id: s.taskAssigneeRole.roleId })
    .from(s.taskAssigneeRole)
    .where(and(eq(s.taskAssigneeRole.taskId, taskId), eq(s.taskAssigneeRole.statusId, statusId)))
    .all()
    .map((row) => row.id);
}

/** Replaces the task's assignees in `statusId` (inside the caller's write). */
export function setStageAssignees(
  tx: Tx,
  taskId: string,
  statusId: string,
  userIds: readonly string[],
  roleIds: readonly string[],
): void {
  tx.delete(s.taskAssigneeUser)
    .where(and(eq(s.taskAssigneeUser.taskId, taskId), eq(s.taskAssigneeUser.statusId, statusId)))
    .run();
  tx.delete(s.taskAssigneeRole)
    .where(and(eq(s.taskAssigneeRole.taskId, taskId), eq(s.taskAssigneeRole.statusId, statusId)))
    .run();
  if (userIds.length > 0) {
    tx.insert(s.taskAssigneeUser)
      .values([...new Set(userIds)].map((userId) => ({ taskId, statusId, userId })))
      .run();
  }
  if (roleIds.length > 0) {
    tx.insert(s.taskAssigneeRole)
      .values([...new Set(roleIds)].map((roleId) => ({ taskId, statusId, roleId })))
      .run();
  }
}

// ---------------------------------------------------------------------------------------------
// Unassigning because of something outside the task
// ---------------------------------------------------------------------------------------------

export type UnassignReason = 'member_removed' | 'member_left' | 'account_deleted' | 'role_deleted';

export type UnassignTarget = { userId: string } | { roleId: string };

const CHUNK = 500;

/**
 * Current-stage assignee labels of each task, people then roles, each sorted (as `updateTask`
 * records them).
 */
function assigneeLabels(tx: Tx, taskIds: readonly string[]): Map<string, string[]> {
  const users = new Map<string, string[]>();
  const roles = new Map<string, string[]>();
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const ids = taskIds.slice(i, i + CHUNK);
    for (const row of tx
      .select({ taskId: s.taskAssigneeUser.taskId, id: s.user.id, username: s.user.username })
      .from(s.taskAssigneeUser)
      .innerJoin(s.user, eq(s.user.id, s.taskAssigneeUser.userId))
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
      .where(and(inArray(s.taskAssigneeUser.taskId, ids), currentUserRow))
      .all()) {
      users.set(row.taskId, [...(users.get(row.taskId) ?? []), `@${row.username ?? row.id}`]);
    }
    for (const row of tx
      .select({ taskId: s.taskAssigneeRole.taskId, name: s.role.name })
      .from(s.taskAssigneeRole)
      .innerJoin(s.role, eq(s.role.id, s.taskAssigneeRole.roleId))
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeRole.taskId))
      .where(and(inArray(s.taskAssigneeRole.taskId, ids), currentRoleRow))
      .all()) {
      roles.set(row.taskId, [...(roles.get(row.taskId) ?? []), `${row.name} (role)`]);
    }
  }
  const sorted = (labels: readonly string[] = []) => [...labels].sort((a, b) => a.localeCompare(b));
  return new Map(
    taskIds.map((id) => [id, [...sorted(users.get(id)), ...sorted(roles.get(id))]] as const),
  );
}

/**
 * Removes the user's direct assignments on the team's tasks, or every assignment of the role, in
 * every stage, inside the caller's write (before the user's membership or the role itself goes).
 * Tasks in Trash are included, so their history stays true if they are restored. Tasks whose
 * current assignees change get the audit row and event. Returns how many tasks lost the assignee
 * in their current stage.
 */
export function unassignFromTasks(
  tx: Tx,
  actor: Actor,
  teamId: string,
  target: UnassignTarget,
  reason: UnassignReason,
): number {
  const tasks =
    'userId' in target
      ? tx
          .selectDistinct({ task: s.task, key: s.project.key })
          .from(s.taskAssigneeUser)
          .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
          .innerJoin(s.project, eq(s.project.id, s.task.projectId))
          .where(and(eq(s.task.teamId, teamId), eq(s.taskAssigneeUser.userId, target.userId)))
          .all()
      : tx
          .selectDistinct({ task: s.task, key: s.project.key })
          .from(s.taskAssigneeRole)
          .innerJoin(s.task, eq(s.task.id, s.taskAssigneeRole.taskId))
          .innerJoin(s.project, eq(s.project.id, s.task.projectId))
          .where(and(eq(s.task.teamId, teamId), eq(s.taskAssigneeRole.roleId, target.roleId)))
          .all();
  if (tasks.length === 0) return 0;
  const ids = tasks.map((row) => row.task.id);
  const before = assigneeLabels(tx, ids);

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if ('userId' in target) {
      tx.delete(s.taskAssigneeUser)
        .where(
          and(
            eq(s.taskAssigneeUser.userId, target.userId),
            inArray(s.taskAssigneeUser.taskId, chunk),
          ),
        )
        .run();
    } else {
      tx.delete(s.taskAssigneeRole)
        .where(
          and(
            eq(s.taskAssigneeRole.roleId, target.roleId),
            inArray(s.taskAssigneeRole.taskId, chunk),
          ),
        )
        .run();
    }
    tx.update(s.task).set({ updatedAt: new Date() }).where(inArray(s.task.id, chunk)).run();
  }
  const after = assigneeLabels(tx, ids);

  let changed = 0;
  for (const { task, key } of tasks) {
    const from = before.get(task.id) ?? [];
    const to = after.get(task.id) ?? [];
    if (from.length === to.length) continue; // Only an earlier stage's assignment went.
    changed += 1;
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.updated',
      changes: { assignees: change(from, to) },
      meta: { ref: formatTaskRef(key, task.number), title: task.title, reason },
    });
    emitAfterCommit(tx, {
      type: 'task.updated',
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      actorId: actor.userId,
    });
  }
  return changed;
}
