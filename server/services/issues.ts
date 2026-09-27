import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type {
  CreateIssueInput,
  Issue,
  IssueCounts,
  IssueLabel,
  IssueLabelsChange,
  IssueListResponse,
  IssueSort,
  IssueSummary,
  LinkedTask,
  ListIssuesQuery,
  UpdateIssueInput,
} from '@shared/schemas/issues';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { change, hasChanges, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt, markdownToPlainText } from '../lib/markdown';
import { likeContains } from '../lib/sql';
import { appPaths } from '../lib/urls';
import {
  canRestoreContent,
  hasPermission,
  requireCanDeleteContent,
  requireCanEditContent,
  requireProjectAccess,
  requirePermission,
  type Membership,
} from './access';
import { recordActivity } from './activity';
import { attachmentsByParent, attachToParent, referencedPendingUploads } from './attachments';
import { emitAfterCommit } from './events';
import { queueLinkedTaskEvents } from './linkEvents';
import { trashedProject } from './items';
import {
  notifyMentions,
  notifyUsers,
  refreshNotificationText,
  unreadCountsByItem,
  type NotificationTarget,
} from './notifications';
import { requireProject } from './projects';
import { reactionsOf } from './reactions';
import { buildFtsQuery, indexSearch } from './search';
import { autoSubscribe, subscriberIds } from './subscriptions';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Issues (SPEC §1.7): forum-style posts per project, numbered `#1, #2…` (`KEY#51`). Anyone with
 * `CREATE_ISSUES` opens them; authors edit, label, resolve and delete their own, and others need
 * `EDIT_ANY_CONTENT` (title and body), `RESOLVE_ISSUES` (labels, resolve/reopen) or
 * `DELETE_ANY_CONTENT`. Replies, attachments and subscriptions are core services keyed by the
 * issue (see ./items).
 */

export type IssueRow = typeof s.issue.$inferSelect;
type ProjectRow = typeof s.project.$inferSelect;
type TeamRow = typeof s.team.$inferSelect;

/** A live issue with its (live) project and team, and the actor's membership there. */
export interface IssueAccess {
  issue: IssueRow;
  project: ProjectRow;
  team: TeamRow;
  membership: Membership;
}

/**
 * The live issue `issueId` (its project and team live too) and the actor's membership. Missing,
 * deleted and other teams' issues are all `not_found`.
 */
export function requireIssue(db: DbExecutor, actor: Actor, issueId: string): IssueAccess {
  const row = db
    .select({ issue: s.issue, project: s.project, team: s.team })
    .from(s.issue)
    .innerJoin(s.project, eq(s.project.id, s.issue.projectId))
    .innerJoin(s.team, eq(s.team.id, s.issue.teamId))
    .where(
      and(
        eq(s.issue.id, issueId),
        isNull(s.issue.deletedAt),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .get();
  if (!row) throw errors.notFound('Issue');
  return { ...row, membership: requireProjectAccess(db, actor, row.project.id, 'Issue') };
}

/** May the member resolve, reopen and label this issue? Authors always may. */
export function canTriageIssue(membership: Membership, authorId: string | null): boolean {
  return authorId === membership.userId || hasPermission(membership, 'RESOLVE_ISSUES');
}

function requireCanTriage(membership: Membership, authorId: string | null, what: string): void {
  if (!canTriageIssue(membership, authorId)) {
    throw errors.forbidden(`You can only ${what} your own issues`);
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

/** Labels of several issues, alphabetical, keyed by issue id. */
function labelsByIssue(db: DbExecutor, issueIds: readonly string[]): Map<string, IssueLabel[]> {
  const grouped = new Map<string, IssueLabel[]>();
  if (issueIds.length === 0) return grouped;
  const rows = db
    .select({
      issueId: s.issueLabel.issueId,
      id: s.label.id,
      name: s.label.name,
      color: s.label.color,
      description: s.label.description,
    })
    .from(s.issueLabel)
    .innerJoin(s.label, eq(s.label.id, s.issueLabel.labelId))
    .where(inArray(s.issueLabel.issueId, [...issueIds]))
    .orderBy(asc(sql`lower(${s.label.name})`), asc(s.label.id))
    .all();
  for (const { issueId, ...label } of rows) {
    grouped.set(issueId, [...(grouped.get(issueId) ?? []), label]);
  }
  return grouped;
}

interface ProjectContext {
  key: string;
  teamSlug: string;
}

function toSummaries(
  db: DbExecutor,
  rows: readonly IssueRow[],
  context: ProjectContext,
): IssueSummary[] {
  const labels = labelsByIssue(
    db,
    rows.map((row) => row.id),
  );
  const authors = getUserSummaries(
    db,
    rows.map((row) => row.authorId),
  );
  const keys = getViaKeys(
    db,
    rows.map((row) => row.viaKeyId),
  );
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    number: row.number,
    ref: formatIssueRef(context.key, row.number),
    title: row.title,
    resolved: row.resolved,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    labels: labels.get(row.id) ?? [],
    author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
    via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
    replyCount: row.replyCount,
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    path: appPaths.issue(context.teamSlug, context.key, row.number),
  }));
}

/** Live tasks linked to the issue (any project of the team that is live), by project and number. */
export function linkedTasksOf(db: DbExecutor, issueId: string): LinkedTask[] {
  const rows = db
    .select({
      kind: s.taskIssueLink.kind,
      id: s.task.id,
      number: s.task.number,
      title: s.task.title,
      projectKey: s.project.key,
      teamSlug: s.team.slug,
      statusId: s.status.id,
      statusName: s.status.name,
      statusColor: s.status.color,
      statusCategory: s.status.category,
    })
    .from(s.taskIssueLink)
    .innerJoin(s.task, eq(s.task.id, s.taskIssueLink.taskId))
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .innerJoin(s.team, eq(s.team.id, s.task.teamId))
    .where(
      and(
        eq(s.taskIssueLink.issueId, issueId),
        isNull(s.task.deletedAt),
        isNull(s.project.deletedAt),
      ),
    )
    .orderBy(asc(s.project.key), asc(s.task.number))
    .all();
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    ref: formatTaskRef(row.projectKey, row.number),
    title: row.title,
    kind: row.kind,
    status: {
      id: row.statusId,
      name: row.statusName,
      color: row.statusColor,
      category: row.statusCategory,
    },
    path: appPaths.task(row.teamSlug, row.projectKey, row.number),
  }));
}

function isSubscribed(db: DbExecutor, userId: string, issueId: string): boolean {
  const row = db
    .select({ subscribed: s.subscription.subscribed })
    .from(s.subscription)
    .where(
      and(
        eq(s.subscription.userId, userId),
        eq(s.subscription.entityType, 'issue'),
        eq(s.subscription.entityId, issueId),
      ),
    )
    .get();
  return row?.subscribed ?? false;
}

function toIssue(db: DbExecutor, actor: Actor, row: IssueRow, context: ProjectContext): Issue {
  const [summary] = toSummaries(db, [row], context);
  if (!summary) throw errors.internal();
  const resolver = row.resolvedById ? getUserSummaries(db, [row.resolvedById]) : null;
  return {
    ...summary,
    body: row.body,
    attachments: attachmentsByParent(db, 'issue', [row.id]).get(row.id) ?? [],
    resolvedBy: row.resolvedById ? (resolver?.get(row.resolvedById) ?? null) : null,
    linkedTasks: linkedTasksOf(db, row.id),
    reactions: reactionsOf(db, 'issue', row.id, actor.userId),
    subscribed: isSubscribed(db, actor.userId, row.id),
  };
}

function contextOf(access: { project: ProjectRow; team: TeamRow }): ProjectContext {
  return { key: access.project.key, teamSlug: access.team.slug };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** `GET /api/issues/:issueId` (any member). */
export function getIssue(deps: AppDeps, actor: Actor, issueId: string): Issue {
  const { orm } = deps.db;
  const access = requireIssue(orm, actor, issueId);
  return toIssue(orm, actor, access.issue, contextOf(access));
}

/** `GET /api/projects/:projectId/issues/:number` (the issue page's URL). */
export function getIssueByNumber(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  number: number,
): Issue {
  const { orm } = deps.db;
  const access = requireProject(orm, actor, projectId, 'Issue');
  const row = orm
    .select()
    .from(s.issue)
    .where(
      and(eq(s.issue.projectId, projectId), eq(s.issue.number, number), isNull(s.issue.deletedAt)),
    )
    .get();
  if (!row) throw errors.notFound('Issue');
  return toIssue(orm, actor, row, contextOf(access));
}

/** `[primary sort value, issue number]` of the last row of a page. */
const issueCursorSchema = z.tuple([z.number().int().nonnegative(), z.number().int().positive()]);

/** The sort column and direction, and the cursor value a row holds for it. */
function sortSpec(sort: IssueSort) {
  switch (sort) {
    case 'latest-activity':
      return {
        order: [desc(s.issue.lastActivityAt), desc(s.issue.number)],
        value: (row: IssueRow) => row.lastActivityAt.getTime(),
        after: (value: number, number: number) =>
          or(
            lt(s.issue.lastActivityAt, new Date(value)),
            and(eq(s.issue.lastActivityAt, new Date(value)), lt(s.issue.number, number)),
          ),
      };
    case 'most-replies':
      return {
        order: [desc(s.issue.replyCount), desc(s.issue.number)],
        value: (row: IssueRow) => row.replyCount,
        after: (value: number, number: number) =>
          or(
            lt(s.issue.replyCount, value),
            and(eq(s.issue.replyCount, value), lt(s.issue.number, number)),
          ),
      };
    case 'newest':
      return {
        order: [desc(s.issue.number)],
        value: (row: IssueRow) => row.number,
        after: (_value: number, number: number) => lt(s.issue.number, number),
      };
    case 'oldest':
      return {
        order: [asc(s.issue.number)],
        value: (row: IssueRow) => row.number,
        after: (_value: number, number: number) => gt(s.issue.number, number),
      };
  }
}

/**
 * Text search: issues whose title or body match (FTS5, prefix matching every word), issues with a
 * matching reply, and `#12` / `12` as an issue number. Input without searchable words falls back
 * to a substring match on the title.
 */
function textCondition(projectId: string, q: string): SQL | undefined {
  const conditions: Array<SQL | undefined> = [];
  const number = /^#?(\d{1,9})$/.exec(q)?.[1];
  if (number) conditions.push(eq(s.issue.number, Number(number)));
  const match = buildFtsQuery(q);
  if (match) {
    conditions.push(sql`${s.issue.id} in (
      select search_index.entity_id from search_index
      where search_index match ${match} and search_index.entity_type = 'issue'
        and search_index.project_id = ${projectId}
      union
      select reply.parent_id from search_index
      join reply on reply.id = search_index.entity_id
      where search_index match ${match} and search_index.entity_type = 'reply'
        and search_index.project_id = ${projectId}
        and reply.parent_type = 'issue' and reply.deleted_at is null
    )`);
  } else {
    conditions.push(likeContains(s.issue.title, q));
  }
  return or(...conditions);
}

/** Conditions of every filter except the state (the tab counts share them). */
function filterConditions(db: DbExecutor, projectId: string, query: ListIssuesQuery): SQL[] {
  const conditions: SQL[] = [eq(s.issue.projectId, projectId)];
  const deleted = isNull(s.issue.deletedAt);
  conditions.push(deleted);
  if (query.author) conditions.push(eq(s.issue.authorId, query.author));
  const labelIds = query.labels ?? [];
  if (labelIds.length > 0) {
    const carrying = db
      .select({ issueId: s.issueLabel.issueId })
      .from(s.issueLabel)
      .where(inArray(s.issueLabel.labelId, labelIds));
    conditions.push(
      inArray(
        s.issue.id,
        query.labelMatch === 'all'
          ? carrying
              .groupBy(s.issueLabel.issueId)
              .having(sql`count(distinct ${s.issueLabel.labelId}) = ${labelIds.length}`)
          : carrying,
      ),
    );
  }
  const q = query.q?.trim();
  if (q) {
    const text = textCondition(projectId, q);
    if (text) conditions.push(text);
  }
  return conditions;
}

function countsOf(db: DbExecutor, conditions: readonly SQL[]): IssueCounts {
  const rows = db
    .select({ resolved: s.issue.resolved, n: count() })
    .from(s.issue)
    .where(and(...conditions))
    .groupBy(s.issue.resolved)
    .all();
  const open = rows.find((row) => !row.resolved)?.n ?? 0;
  const resolved = rows.find((row) => row.resolved)?.n ?? 0;
  return { open, resolved, all: open + resolved };
}

/**
 * `GET /api/projects/:projectId/issues`: a page of the project's issues (deleted ones excluded)
 * with the per-state counts for the same filters.
 */
export function listIssues(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  query: ListIssuesQuery,
): IssueListResponse {
  const { orm } = deps.db;
  const access = requireProject(orm, actor, projectId);
  const filters = filterConditions(orm, projectId, query);
  const spec = sortSpec(query.sort);
  const cursor = query.cursor ? decodeCursor(query.cursor, issueCursorSchema) : null;
  const rows = orm
    .select()
    .from(s.issue)
    .where(
      and(
        ...filters,
        query.state === 'open' ? eq(s.issue.resolved, false) : undefined,
        query.state === 'resolved' ? eq(s.issue.resolved, true) : undefined,
        cursor ? spec.after(cursor[0], cursor[1]) : undefined,
      ),
    )
    .orderBy(...spec.order)
    .limit(query.limit + 1)
    .all();
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  const unread = unreadCountsByItem(
    orm,
    actor.userId,
    'issue',
    page.map((row) => row.id),
  );
  return {
    items: toSummaries(orm, page, contextOf(access)).map((item) => ({
      ...item,
      unreadCount: unread.get(item.id) ?? 0,
    })),
    nextCursor: hasMore && last ? encodeCursor([spec.value(last), last.number]) : null,
    counts: countsOf(orm, filters),
  };
}

// ---------------------------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------------------------

const EXCERPT_LENGTH = 140;

/** Labels of the project by id; unknown ids are a validation error. */
function projectLabels(db: DbExecutor, projectId: string, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = db
    .select({ id: s.label.id, name: s.label.name })
    .from(s.label)
    .where(and(eq(s.label.projectId, projectId), inArray(s.label.id, unique)))
    .all();
  if (rows.length !== unique.length) {
    const found = new Set(rows.map((row) => row.id));
    throw errors.validation('Some labels don’t belong to this project', {
      labelIds: unique.filter((id) => !found.has(id)),
    });
  }
  return rows;
}

function sortedNames(labels: ReadonlyArray<{ name: string }>): string[] {
  return labels
    .map((label) => label.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** The issue's label ids after `change`. */
function nextLabelIds(current: readonly string[], labels: IssueLabelsChange): string[] {
  if (labels.set) return [...new Set(labels.set)];
  const remove = new Set(labels.remove ?? []);
  return [...new Set([...current, ...(labels.add ?? [])])].filter((id) => !remove.has(id));
}

function attachmentNames(db: DbExecutor, issueId: string): string[] {
  return (attachmentsByParent(db, 'issue', [issueId]).get(issueId) ?? []).map(
    (attachment) => attachment.filename,
  );
}

function notificationTarget(
  issue: Pick<IssueRow, 'id' | 'teamId' | 'number' | 'title' | 'body'>,
  context: ProjectContext,
): NotificationTarget {
  return {
    teamId: issue.teamId,
    entityType: 'issue',
    entityId: issue.id,
    title: `${formatIssueRef(context.key, issue.number)}: ${issue.title}`,
    snippet: issue.body,
    url: appPaths.issue(context.teamSlug, context.key, issue.number),
  };
}

function meta(issue: Pick<IssueRow, 'number' | 'title'>, context: ProjectContext) {
  return { ref: formatIssueRef(context.key, issue.number), title: issue.title };
}

function issueEvent(
  type: 'issue.created' | 'issue.updated' | 'issue.deleted' | 'issue.restored',
  issue: Pick<IssueRow, 'id' | 'teamId' | 'projectId'>,
  actor: Actor,
) {
  return {
    type,
    teamId: issue.teamId,
    projectId: issue.projectId,
    entityType: 'issue' as const,
    entityId: issue.id,
    actorId: actor.userId,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

/**
 * Opens an issue (`CREATE_ISSUES`): takes the project's next number, sets labels, attaches
 * uploads (explicit ids and images linked from the body), subscribes the author, indexes it for
 * search and notifies mentioned members.
 */
export function createIssue(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateIssueInput,
): Issue {
  const { orm } = deps.db;
  const access = requireProject(orm, actor, projectId);
  requirePermission(
    access.membership,
    'CREATE_ISSUES',
    "You don't have permission to open issues here",
  );
  const labels = projectLabels(orm, projectId, input.labelIds ?? []);
  const body = input.body ?? '';
  const text = markdownToPlainText(body);
  const context = contextOf(access);

  const row = deps.db.write((tx) => {
    const seq = tx
      .update(s.project)
      .set({ issueSeq: sql`${s.project.issueSeq} + 1` })
      .where(eq(s.project.id, projectId))
      .returning({ issueSeq: s.project.issueSeq })
      .get();
    if (!seq) throw errors.notFound('Project');
    const now = new Date();
    const issue = tx
      .insert(s.issue)
      .values({
        id: newId(),
        projectId,
        teamId: access.team.id,
        number: seq.issueSeq,
        title: input.title,
        body,
        authorId: actor.userId,
        viaKeyId: actor.key?.id ?? null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (labels.length > 0) {
      // Re-checked under the write lock: a label may have been deleted meanwhile.
      projectLabels(tx, projectId, input.labelIds ?? []);
      tx.insert(s.issueLabel)
        .values(labels.map((label) => ({ issueId: issue.id, labelId: label.id })))
        .run();
    }
    attachToParent(
      tx,
      actor,
      [...(input.attachmentIds ?? []), ...referencedPendingUploads(tx, actor, issue.teamId, body)],
      { type: 'issue', id: issue.id, teamId: issue.teamId, projectId },
    );
    autoSubscribe(tx, [actor.userId], 'issue', issue.id);
    recordActivity(tx, actor, {
      teamId: issue.teamId,
      projectId,
      entityType: 'issue',
      entityId: issue.id,
      action: 'issue.created',
      meta: { ...meta(issue, context), labels: sortedNames(labels) },
    });
    indexSearch(tx, {
      entityType: 'issue',
      entityId: issue.id,
      teamId: issue.teamId,
      projectId,
      title: issue.title,
      text,
    });
    notifyMentions(tx, actor, notificationTarget(issue, context), body);
    emitAfterCommit(tx, issueEvent('issue.created', issue, actor));
    return issue;
  });
  return toIssue(orm, actor, row, context);
}

/**
 * Edits an issue. Title and body: the author or `EDIT_ANY_CONTENT` (sets `editedAt`; only newly
 * added mentions notify). Labels (`set`, or `add`/`remove`): the author or `RESOLVE_ISSUES`.
 * Attachments: whoever may edit the body.
 */
export function updateIssue(
  deps: AppDeps,
  actor: Actor,
  issueId: string,
  input: UpdateIssueInput,
): Issue {
  const { orm } = deps.db;
  const access = requireIssue(orm, actor, issueId);
  const { issue, membership } = access;
  const context = contextOf(access);

  const titleChanged = input.title !== undefined && input.title !== issue.title;
  const bodyChanged = input.body !== undefined && input.body !== issue.body;
  if (titleChanged || bodyChanged || input.attachmentIds?.length) {
    requireCanEditContent(membership, issue.authorId);
  }

  let labelChange: { before: string[]; after: string[]; ids: string[] } | null = null;
  if (input.labels) {
    requireCanTriage(membership, issue.authorId, 'label');
    const current = labelsByIssue(orm, [issue.id]).get(issue.id) ?? [];
    const requested = [
      ...(input.labels.set ?? []),
      ...(input.labels.add ?? []),
      ...(input.labels.remove ?? []),
    ];
    projectLabels(orm, issue.projectId, requested);
    const ids = nextLabelIds(
      current.map((label) => label.id),
      input.labels,
    );
    const before = sortedNames(current);
    const after = sortedNames(projectLabels(orm, issue.projectId, ids));
    if (before.join('\u0000') !== after.join('\u0000')) labelChange = { before, after, ids };
  }

  const title = titleChanged && input.title !== undefined ? input.title : issue.title;
  const body = bodyChanged && input.body !== undefined ? input.body : issue.body;
  const edits: Changes = {};
  if (titleChanged) edits.title = change(issue.title, title);
  if (bodyChanged) {
    edits.description = change(excerpt(issue.body, EXCERPT_LENGTH), excerpt(body, EXCERPT_LENGTH));
  }
  const text = bodyChanged || titleChanged ? markdownToPlainText(body) : null;
  const uploads = input.attachmentIds ?? [];
  if (!hasChanges(edits) && !labelChange && uploads.length === 0) {
    return toIssue(orm, actor, issue, context);
  }

  const updated = deps.db.write((tx) => {
    const now = new Date();
    const next = tx
      .update(s.issue)
      .set({
        title,
        body,
        ...(hasChanges(edits) ? { editedAt: now } : {}),
        updatedAt: now,
        lastActivityAt: now,
      })
      .where(eq(s.issue.id, issue.id))
      .returning()
      .get();
    if (labelChange) {
      // Re-checked under the write lock: a label may have been deleted meanwhile.
      projectLabels(tx, issue.projectId, labelChange.ids);
      tx.delete(s.issueLabel).where(eq(s.issueLabel.issueId, issue.id)).run();
      if (labelChange.ids.length > 0) {
        tx.insert(s.issueLabel)
          .values(labelChange.ids.map((labelId) => ({ issueId: issue.id, labelId })))
          .run();
      }
    }
    const beforeFiles = uploads.length > 0 ? attachmentNames(tx, issue.id) : [];
    const attached = attachToParent(
      tx,
      actor,
      [...uploads, ...(bodyChanged ? referencedPendingUploads(tx, actor, issue.teamId, body) : [])],
      { type: 'issue', id: issue.id, teamId: issue.teamId, projectId: issue.projectId },
    );
    if (uploads.length > 0) {
      edits.attachments = change(
        beforeFiles,
        attached.length > 0 ? attachmentNames(tx, issue.id) : beforeFiles,
      );
    }
    if (hasChanges(edits)) {
      recordActivity(tx, actor, {
        teamId: issue.teamId,
        projectId: issue.projectId,
        entityType: 'issue',
        entityId: issue.id,
        action: 'issue.updated',
        changes: edits,
        meta: meta(next, context),
      });
    }
    if (labelChange) {
      recordActivity(tx, actor, {
        teamId: issue.teamId,
        projectId: issue.projectId,
        entityType: 'issue',
        entityId: issue.id,
        action: 'issue.labels_changed',
        changes: { labels: change(labelChange.before, labelChange.after) },
        meta: meta(next, context),
      });
    }
    if (text !== null) {
      indexSearch(tx, {
        entityType: 'issue',
        entityId: issue.id,
        teamId: issue.teamId,
        projectId: issue.projectId,
        title,
        text,
      });
    }
    if (titleChanged || bodyChanged) refreshNotificationText(tx, notificationTarget(next, context));
    if (bodyChanged) {
      notifyMentions(tx, actor, notificationTarget(next, context), body, {
        previousBody: issue.body,
      });
    }
    emitAfterCommit(tx, issueEvent('issue.updated', next, actor));
    queueLinkedTaskEvents(tx, actor, [issue.id]);
    return next;
  });
  return toIssue(orm, actor, updated, context);
}

/**
 * Resolves (`resolved = true`) or reopens an issue: the author or `RESOLVE_ISSUES`. Notifies the
 * author and the issue's subscribers. A no-op when the issue is already in that state.
 */
function setResolved(deps: AppDeps, actor: Actor, issueId: string, resolved: boolean): Issue {
  const { orm } = deps.db;
  const access = requireIssue(orm, actor, issueId);
  const { issue, membership } = access;
  const context = contextOf(access);
  requireCanTriage(membership, issue.authorId, resolved ? 'resolve' : 'reopen');
  if (issue.resolved === resolved) return toIssue(orm, actor, issue, context);

  const updated = deps.db.write((tx) => {
    const now = new Date();
    const next = tx
      .update(s.issue)
      .set({
        resolved,
        resolvedAt: resolved ? now : null,
        resolvedById: resolved ? actor.userId : null,
        updatedAt: now,
        lastActivityAt: now,
      })
      .where(eq(s.issue.id, issue.id))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      action: resolved ? 'issue.resolved' : 'issue.reopened',
      meta: meta(next, context),
    });
    notifyUsers(
      tx,
      actor,
      resolved ? 'issue_resolved' : 'issue_reopened',
      [...(issue.authorId ? [issue.authorId] : []), ...subscriberIds(tx, 'issue', issue.id)],
      { ...notificationTarget(next, context), snippet: '' },
    );
    emitAfterCommit(tx, issueEvent('issue.updated', next, actor));
    queueLinkedTaskEvents(tx, actor, [issue.id]);
    return next;
  });
  return toIssue(orm, actor, updated, context);
}

export function resolveIssue(deps: AppDeps, actor: Actor, issueId: string): Issue {
  return setResolved(deps, actor, issueId, true);
}

export function reopenIssue(deps: AppDeps, actor: Actor, issueId: string): Issue {
  return setResolved(deps, actor, issueId, false);
}

/**
 * Moves an issue to Trash (the author or `DELETE_ANY_CONTENT`). It disappears from lists, search
 * and MCP results until restored; the daily purge removes it after 30 days.
 */
export function deleteIssue(deps: AppDeps, actor: Actor, issueId: string): { ok: true } {
  const { orm } = deps.db;
  const access = requireIssue(orm, actor, issueId);
  const { issue, membership } = access;
  requireCanDeleteContent(membership, issue.authorId);
  deps.db.write((tx) => {
    tx.update(s.issue)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.issue.id, issue.id))
      .run();
    recordActivity(tx, actor, {
      teamId: issue.teamId,
      projectId: issue.projectId,
      entityType: 'issue',
      entityId: issue.id,
      action: 'issue.deleted',
      meta: meta(issue, contextOf(access)),
    });
    emitAfterCommit(tx, issueEvent('issue.deleted', issue, actor));
    queueLinkedTaskEvents(tx, actor, [issue.id]);
  });
  return { ok: true };
}

/** Restores an issue from Trash (the author or `MANAGE_TRASH`); its project must be live. */
export function restoreIssue(deps: AppDeps, actor: Actor, issueId: string): Issue {
  const { orm } = deps.db;
  const row = orm.select().from(s.issue).where(eq(s.issue.id, issueId)).get();
  if (!row?.deletedAt) throw errors.notFound('Deleted issue');
  const membership = requireProjectAccess(orm, actor, row.projectId, 'Deleted issue');
  if (!canRestoreContent(membership, row.authorId)) {
    throw errors.forbidden('You can only restore your own issues');
  }
  if (trashedProject(orm, row.projectId)) {
    throw errors.conflict('This issue’s project is in Trash. Restore the project instead');
  }
  const found = orm
    .select({ project: s.project, team: s.team })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(eq(s.project.id, row.projectId))
    .get();
  if (!found) throw errors.notFound('Deleted issue');
  const context = contextOf(found);

  const restored = deps.db.write((tx) => {
    const next = tx
      .update(s.issue)
      .set({ deletedAt: null, deletedById: null, deletedViaKeyId: null })
      .where(eq(s.issue.id, row.id))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: row.teamId,
      projectId: row.projectId,
      entityType: 'issue',
      entityId: row.id,
      action: 'issue.restored',
      meta: meta(row, context),
    });
    emitAfterCommit(tx, issueEvent('issue.restored', next, actor));
    queueLinkedTaskEvents(tx, actor, [row.id]);
    return next;
  });
  return toIssue(orm, actor, restored, context);
}
