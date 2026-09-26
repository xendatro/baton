import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Actor } from '../context';
import type { Tx } from '../db';
import * as s from '../db/schema';
import { emitAfterCommit } from './events';

/**
 * Live events for the other side of issue links. Issue links are team-wide (a task may address an
 * issue of another project), and the web refreshes the issues and tasks of the event's project
 * only. So a change that shows on linked items (a task's title, status or deletion in an issue's
 * "Addressed by" list; an issue's title, resolved state or deletion in a task's linked issues)
 * also announces the linked items that live in another project. Links within one project need
 * nothing extra: that project's task and issue events refresh both lists.
 */

const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) result.push(items.slice(i, i + CHUNK));
  return result;
}

/** Queues `issue.updated` for live issues linked to `taskIds` in another project than the task. */
export function queueLinkedIssueEvents(
  tx: Tx,
  actor: Actor | null,
  taskIds: readonly string[],
): void {
  const seen = new Set<string>();
  for (const ids of chunks([...new Set(taskIds)])) {
    const rows = tx
      .select({ id: s.issue.id, teamId: s.issue.teamId, projectId: s.issue.projectId })
      .from(s.taskIssueLink)
      .innerJoin(s.task, eq(s.task.id, s.taskIssueLink.taskId))
      .innerJoin(s.issue, eq(s.issue.id, s.taskIssueLink.issueId))
      .where(
        and(
          inArray(s.taskIssueLink.taskId, ids),
          ne(s.issue.projectId, s.task.projectId),
          isNull(s.issue.deletedAt),
        ),
      )
      .all();
    for (const issue of rows) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      emitAfterCommit(tx, {
        type: 'issue.updated',
        teamId: issue.teamId,
        projectId: issue.projectId,
        entityType: 'issue',
        entityId: issue.id,
        actorId: actor?.userId ?? null,
      });
    }
  }
}

/** Queues `task.updated` for live tasks linked to `issueIds` in another project than the issue. */
export function queueLinkedTaskEvents(
  tx: Tx,
  actor: Actor | null,
  issueIds: readonly string[],
): void {
  const seen = new Set<string>();
  for (const ids of chunks([...new Set(issueIds)])) {
    const rows = tx
      .select({ id: s.task.id, teamId: s.task.teamId, projectId: s.task.projectId })
      .from(s.taskIssueLink)
      .innerJoin(s.issue, eq(s.issue.id, s.taskIssueLink.issueId))
      .innerJoin(s.task, eq(s.task.id, s.taskIssueLink.taskId))
      .where(
        and(
          inArray(s.taskIssueLink.issueId, ids),
          ne(s.task.projectId, s.issue.projectId),
          isNull(s.task.deletedAt),
        ),
      )
      .all();
    for (const task of rows) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      emitAfterCommit(tx, {
        type: 'task.updated',
        teamId: task.teamId,
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        actorId: actor?.userId ?? null,
      });
    }
  }
}
