import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { IssueLinkKind } from '@shared/constants';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type {
  IdListChange,
  IssueLinksChange,
  LinkedIssue,
  RelatedTask,
} from '@shared/schemas/tasks';
import type { Actor } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { appPaths } from '../lib/urls';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { notifyUsers, type NotifiedSet } from './notifications';
import { subscriberIds } from './subscriptions';

/**
 * Task links (SPEC §1.8): "blocked by" dependencies between tasks of one project (cycles are
 * rejected; a task is blocked while any blocker is in an open-category status) and links to the
 * issues a task addresses (`fixes` resolves the issue when the task is done, `relates` doesn't).
 * The helpers here run inside the tasks service's transactions; link changes are audited on the
 * task (by the caller) and on every issue whose links changed (here).
 */

/** The task whose links change, as the helpers need it. */
export interface LinkSubject {
  id: string;
  projectId: string;
  teamId: string;
  /** `KEY-12`. */
  ref: string;
  title: string;
}

/** Applies a set/add/remove change to a list of ids, keeping the current order. */
export function applyIdChange(current: readonly string[], changeSet: IdListChange): string[] {
  if (changeSet.set) return [...new Set(changeSet.set)];
  const removed = new Set(changeSet.remove ?? []);
  const next = current.filter((id) => !removed.has(id));
  for (const id of changeSet.add ?? []) if (!next.includes(id)) next.push(id);
  return next;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

interface ProjectPath {
  key: string;
  slug: string;
}

function projectPaths(db: DbExecutor, projectIds: readonly string[]): Map<string, ProjectPath> {
  if (projectIds.length === 0) return new Map();
  return new Map(
    db
      .select({ id: s.project.id, key: s.project.key, slug: s.team.slug })
      .from(s.project)
      .innerJoin(s.team, eq(s.team.id, s.project.teamId))
      .where(inArray(s.project.id, [...new Set(projectIds)]))
      .all()
      .map((row) => [row.id, { key: row.key, slug: row.slug }]),
  );
}

/**
 * Refs of the open-category, live blockers of each task (a task is blocked while this is not
 * empty), in number order.
 */
export function openBlockerRefs(db: DbExecutor, taskIds: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (taskIds.length === 0) return result;
  const rows = db
    .select({
      taskId: s.taskDependency.taskId,
      number: s.task.number,
      key: s.project.key,
    })
    .from(s.taskDependency)
    .innerJoin(s.task, eq(s.task.id, s.taskDependency.blockedByTaskId))
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .where(
      and(
        inArray(s.taskDependency.taskId, [...taskIds]),
        isNull(s.task.deletedAt),
        eq(s.status.category, 'open'),
      ),
    )
    .orderBy(asc(s.task.number))
    .all();
  for (const row of rows) {
    const refs = result.get(row.taskId) ?? [];
    refs.push(formatTaskRef(row.key, row.number));
    result.set(row.taskId, refs);
  }
  return result;
}

/** Live tasks on one side of the dependencies of `taskId`, in number order. */
function relatedTasks(db: DbExecutor, taskId: string, side: 'blockedBy' | 'blocking') {
  const [own, other] =
    side === 'blockedBy'
      ? [s.taskDependency.taskId, s.taskDependency.blockedByTaskId]
      : [s.taskDependency.blockedByTaskId, s.taskDependency.taskId];
  const rows = db
    .select({ task: s.task, status: s.status })
    .from(s.taskDependency)
    .innerJoin(s.task, eq(s.task.id, other))
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .where(and(eq(own, taskId), isNull(s.task.deletedAt)))
    .orderBy(asc(s.task.number))
    .all();
  const paths = projectPaths(
    db,
    rows.map((row) => row.task.projectId),
  );
  return rows.flatMap(({ task, status }): RelatedTask[] => {
    const project = paths.get(task.projectId);
    if (!project) return [];
    return [
      {
        id: task.id,
        ref: formatTaskRef(project.key, task.number),
        number: task.number,
        title: task.title,
        status: {
          id: status.id,
          name: status.name,
          color: status.color,
          category: status.category,
        },
        path: appPaths.task(project.slug, project.key, task.number),
      },
    ];
  });
}

/** Tasks `taskId` waits for. */
export function blockersOf(db: DbExecutor, taskId: string): RelatedTask[] {
  return relatedTasks(db, taskId, 'blockedBy');
}

/** Tasks waiting for `taskId`. */
export function blockingOf(db: DbExecutor, taskId: string): RelatedTask[] {
  return relatedTasks(db, taskId, 'blocking');
}

/** Live issues the task addresses (in live projects), in ref order. */
export function linkedIssuesOf(db: DbExecutor, taskId: string): LinkedIssue[] {
  const rows = db
    .select({ issue: s.issue, kind: s.taskIssueLink.kind })
    .from(s.taskIssueLink)
    .innerJoin(s.issue, eq(s.issue.id, s.taskIssueLink.issueId))
    .innerJoin(s.project, eq(s.project.id, s.issue.projectId))
    .where(
      and(
        eq(s.taskIssueLink.taskId, taskId),
        isNull(s.issue.deletedAt),
        isNull(s.project.deletedAt),
      ),
    )
    .all();
  const paths = projectPaths(
    db,
    rows.map((row) => row.issue.projectId),
  );
  return rows
    .flatMap(({ issue, kind }): LinkedIssue[] => {
      const project = paths.get(issue.projectId);
      if (!project) return [];
      return [
        {
          id: issue.id,
          ref: formatIssueRef(project.key, issue.number),
          number: issue.number,
          title: issue.title,
          resolved: issue.resolved,
          kind,
          projectId: issue.projectId,
          path: appPaths.issue(project.slug, project.key, issue.number),
        },
      ];
    })
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------------------------

/** Refs of the given tasks (any state), keyed by id. */
function taskRefs(db: DbExecutor, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: s.task.id, number: s.task.number, key: s.project.key })
    .from(s.task)
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .where(inArray(s.task.id, [...ids]))
    .all();
  return new Map(rows.map((row) => [row.id, formatTaskRef(row.key, row.number)]));
}

function refList(refs: Map<string, string>, ids: readonly string[]): string[] {
  return ids
    .map((id) => refs.get(id) ?? id)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Whether making `taskId` wait for `blockerId` would close a loop: `blockerId` already waits for
 * `taskId`, directly or through other tasks of the project.
 */
function wouldCycle(
  edges: ReadonlyMap<string, readonly string[]>,
  taskId: string,
  blockerId: string,
): boolean {
  const seen = new Set<string>();
  const queue = [blockerId];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(edges.get(current) ?? []));
  }
  return false;
}

/**
 * Changes the tasks `subject` waits for. New blockers must be live tasks of the same project and
 * must not make a cycle. Returns the audit change (refs before and after), or null.
 */
export function applyBlockersChange(
  tx: Tx,
  subject: LinkSubject,
  changeSet: IdListChange,
): Changes {
  const current = tx
    .select({ id: s.taskDependency.blockedByTaskId })
    .from(s.taskDependency)
    .where(eq(s.taskDependency.taskId, subject.id))
    .all()
    .map((row) => row.id);
  const next = applyIdChange(current, changeSet);
  const added = next.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !next.includes(id));
  if (added.length === 0 && removed.length === 0) return {};

  if (added.includes(subject.id)) throw errors.validation("A task can't block itself");
  if (added.length > 0) {
    const found = tx
      .select({ id: s.task.id })
      .from(s.task)
      .where(
        and(
          inArray(s.task.id, added),
          eq(s.task.projectId, subject.projectId),
          isNull(s.task.deletedAt),
        ),
      )
      .all()
      .map((row) => row.id);
    const missing = added.filter((id) => !found.includes(id));
    if (missing.length > 0) {
      throw errors.validation('Blockers must be tasks of the same project', {
        taskIds: missing,
      });
    }
    const edges = new Map<string, string[]>();
    for (const edge of tx
      .select({ taskId: s.taskDependency.taskId, blockerId: s.taskDependency.blockedByTaskId })
      .from(s.taskDependency)
      .innerJoin(s.task, eq(s.task.id, s.taskDependency.taskId))
      .where(eq(s.task.projectId, subject.projectId))
      .all()) {
      edges.set(edge.taskId, [...(edges.get(edge.taskId) ?? []), edge.blockerId]);
    }
    for (const blockerId of added) {
      if (wouldCycle(edges, subject.id, blockerId)) {
        const ref = taskRefs(tx, [blockerId]).get(blockerId) ?? blockerId;
        throw errors.validation(
          `${ref} already waits for ${subject.ref}, so it can't block it (that would be a cycle)`,
        );
      }
      edges.set(subject.id, [...(edges.get(subject.id) ?? []), blockerId]);
    }
  }

  if (removed.length > 0) {
    tx.delete(s.taskDependency)
      .where(
        and(
          eq(s.taskDependency.taskId, subject.id),
          inArray(s.taskDependency.blockedByTaskId, removed),
        ),
      )
      .run();
  }
  if (added.length > 0) {
    tx.insert(s.taskDependency)
      .values(added.map((blockedByTaskId) => ({ taskId: subject.id, blockedByTaskId })))
      .run();
  }
  const refs = taskRefs(tx, [...current, ...added]);
  const before = refList(refs, current);
  const after = refList(refs, next);
  return sameMembers(before, after) ? {} : { blockedBy: change(before, after) };
}

// ---------------------------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------------------------

interface IssueInfo {
  id: string;
  number: number;
  title: string;
  projectId: string;
  teamId: string;
  resolved: boolean;
  authorId: string | null;
  key: string;
  slug: string;
}

/** Live issues (in live projects) by id. */
function issueInfos(db: DbExecutor, ids: readonly string[]): Map<string, IssueInfo> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      id: s.issue.id,
      number: s.issue.number,
      title: s.issue.title,
      projectId: s.issue.projectId,
      teamId: s.issue.teamId,
      resolved: s.issue.resolved,
      authorId: s.issue.authorId,
      key: s.project.key,
      slug: s.team.slug,
    })
    .from(s.issue)
    .innerJoin(s.project, eq(s.project.id, s.issue.projectId))
    .innerJoin(s.team, eq(s.team.id, s.issue.teamId))
    .where(
      and(inArray(s.issue.id, [...ids]), isNull(s.issue.deletedAt), isNull(s.project.deletedAt)),
    )
    .all();
  return new Map(rows.map((row) => [row.id, row]));
}

function issueRef(issue: Pick<IssueInfo, 'key' | 'number'>): string {
  return formatIssueRef(issue.key, issue.number);
}

function linkLabel(ref: string, kind: IssueLinkKind): string {
  return `${ref} (${kind})`;
}

/** "API-12 (fixes)" for every live task linked to the issue. */
function issueTaskLabels(tx: Tx, issueId: string): string[] {
  return tx
    .select({ number: s.task.number, key: s.project.key, kind: s.taskIssueLink.kind })
    .from(s.taskIssueLink)
    .innerJoin(s.task, eq(s.task.id, s.taskIssueLink.taskId))
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .where(and(eq(s.taskIssueLink.issueId, issueId), isNull(s.task.deletedAt)))
    .all()
    .map((row) => linkLabel(formatTaskRef(row.key, row.number), row.kind))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Changes the issues `subject` addresses. New issues must be live issues of the same team; an
 * issue already linked takes the new kind. Every issue whose link changed gets an
 * `issue.links_changed` audit row (`changes.linkedTasks`) and an `issue.updated` event. Returns
 * the task's audit change (`links`, as "API#3 (fixes)"), or {}.
 */
export function applyIssueLinksChange(
  tx: Tx,
  actor: Actor,
  subject: LinkSubject,
  changeSet: IssueLinksChange,
): Changes {
  const current = new Map(
    tx
      .select({ issueId: s.taskIssueLink.issueId, kind: s.taskIssueLink.kind })
      .from(s.taskIssueLink)
      .where(eq(s.taskIssueLink.taskId, subject.id))
      .all()
      .map((row) => [row.issueId, row.kind]),
  );
  const next = new Map(changeSet.set ? [] : current);
  if (changeSet.set) for (const link of changeSet.set) next.set(link.issueId, link.kind);
  for (const id of changeSet.remove ?? []) next.delete(id);
  for (const link of changeSet.add ?? []) next.set(link.issueId, link.kind);

  const touched = [...new Set([...current.keys(), ...next.keys()])].filter(
    (id) => current.get(id) !== next.get(id),
  );
  if (touched.length === 0) return {};
  const issues = issueInfos(tx, [...current.keys(), ...next.keys()]);
  const invalid = [...next.keys()].filter(
    (id) => !current.has(id) && issues.get(id)?.teamId !== subject.teamId,
  );
  if (invalid.length > 0) {
    throw errors.validation('Linked issues must be issues of the same team', {
      issueIds: invalid,
    });
  }

  const labelsOf = (links: ReadonlyMap<string, IssueLinkKind>) =>
    [...links.entries()]
      .flatMap(([id, kind]) => {
        const issue = issues.get(id);
        return issue ? [linkLabel(issueRef(issue), kind)] : [];
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const before = labelsOf(current);
  const issueBefore = new Map(touched.map((id) => [id, issueTaskLabels(tx, id)]));

  for (const id of touched) {
    const kind = next.get(id);
    if (kind === undefined) {
      tx.delete(s.taskIssueLink)
        .where(and(eq(s.taskIssueLink.taskId, subject.id), eq(s.taskIssueLink.issueId, id)))
        .run();
    } else if (current.has(id)) {
      tx.update(s.taskIssueLink)
        .set({ kind })
        .where(and(eq(s.taskIssueLink.taskId, subject.id), eq(s.taskIssueLink.issueId, id)))
        .run();
    } else {
      tx.insert(s.taskIssueLink).values({ taskId: subject.id, issueId: id, kind }).run();
    }
  }

  for (const id of touched) {
    const issue = issues.get(id);
    if (!issue) continue;
    recordActivity(tx, actor, {
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      action: 'issue.links_changed',
      changes: { linkedTasks: change(issueBefore.get(id) ?? [], issueTaskLabels(tx, id)) },
      meta: { ref: issueRef(issue), title: issue.title, task: subject.ref },
    });
    emitAfterCommit(tx, {
      type: 'issue.updated',
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      actorId: actor.userId,
    });
  }
  const after = labelsOf(next);
  return sameMembers(before, after) ? {} : { links: change(before, after) };
}

/**
 * The task entered a done status: resolves the open issues it `fixes` (GitHub "fixes #51"), each
 * audited as `issue.resolved` (with the task in `meta.byTask`), announced with `issue.updated`
 * and notified to the issue's author. Returns the refs of the issues it resolved.
 */
export function resolveFixedIssues(
  tx: Tx,
  actor: Actor,
  subject: LinkSubject,
  notified: NotifiedSet,
  now: Date,
): string[] {
  const ids = tx
    .select({ issueId: s.taskIssueLink.issueId })
    .from(s.taskIssueLink)
    .where(and(eq(s.taskIssueLink.taskId, subject.id), eq(s.taskIssueLink.kind, 'fixes')))
    .all()
    .map((row) => row.issueId);
  const resolved: string[] = [];
  for (const issue of issueInfos(tx, ids).values()) {
    if (issue.resolved) continue;
    tx.update(s.issue)
      .set({ resolved: true, resolvedAt: now, resolvedById: actor.userId, lastActivityAt: now })
      .where(eq(s.issue.id, issue.id))
      .run();
    const ref = issueRef(issue);
    const path = appPaths.issue(issue.slug, issue.key, issue.number);
    recordActivity(tx, actor, {
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      action: 'issue.resolved',
      meta: { ref, title: issue.title, byTask: subject.ref },
    });
    notifyUsers(
      tx,
      actor,
      'issue_resolved',
      // Like resolving on the issue page: its author and everyone subscribed to it.
      [...(issue.authorId ? [issue.authorId] : []), ...subscriberIds(tx, 'issue', issue.id)],
      {
        teamId: issue.teamId,
        entityType: 'issue',
        entityId: issue.id,
        title: `${ref}: ${issue.title}`,
        snippet: `Resolved by ${subject.ref}: ${subject.title}`,
        url: path,
      },
      notified,
    );
    emitAfterCommit(tx, {
      type: 'issue.updated',
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      actorId: actor.userId,
    });
    resolved.push(ref);
  }
  return resolved;
}
