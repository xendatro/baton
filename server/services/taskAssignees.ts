import { and, eq, inArray } from 'drizzle-orm';
import { formatTaskRef } from '@shared/refs';
import type { Actor } from '../context';
import type { Tx } from '../db';
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

export type UnassignReason = 'member_removed' | 'member_left' | 'account_deleted' | 'role_deleted';

export type UnassignTarget = { userId: string } | { roleId: string };

const CHUNK = 500;

/** Assignee labels of each task, people then roles, each sorted (as `updateTask` records them). */
function assigneeLabels(tx: Tx, taskIds: readonly string[]): Map<string, string[]> {
  const users = new Map<string, string[]>();
  const roles = new Map<string, string[]>();
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const ids = taskIds.slice(i, i + CHUNK);
    for (const row of tx
      .select({ taskId: s.taskAssigneeUser.taskId, id: s.user.id, username: s.user.username })
      .from(s.taskAssigneeUser)
      .innerJoin(s.user, eq(s.user.id, s.taskAssigneeUser.userId))
      .where(inArray(s.taskAssigneeUser.taskId, ids))
      .all()) {
      users.set(row.taskId, [...(users.get(row.taskId) ?? []), `@${row.username ?? row.id}`]);
    }
    for (const row of tx
      .select({ taskId: s.taskAssigneeRole.taskId, name: s.role.name })
      .from(s.taskAssigneeRole)
      .innerJoin(s.role, eq(s.role.id, s.taskAssigneeRole.roleId))
      .where(inArray(s.taskAssigneeRole.taskId, ids))
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
 * Removes the user's direct assignments on the team's tasks, or every assignment of the role,
 * inside the caller's write (before the user's membership or the role itself goes). Tasks in Trash
 * are included, so their history stays true if they are restored. Returns how many tasks lost the
 * assignee.
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
          .select({ task: s.task, key: s.project.key })
          .from(s.taskAssigneeUser)
          .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
          .innerJoin(s.project, eq(s.project.id, s.task.projectId))
          .where(and(eq(s.task.teamId, teamId), eq(s.taskAssigneeUser.userId, target.userId)))
          .all()
      : tx
          .select({ task: s.task, key: s.project.key })
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

  for (const { task, key } of tasks) {
    recordActivity(tx, actor, {
      teamId: task.teamId,
      projectId: task.projectId,
      entityType: 'task',
      entityId: task.id,
      action: 'task.updated',
      changes: { assignees: change(before.get(task.id) ?? [], after.get(task.id) ?? []) },
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
  return tasks.length;
}
