import { addDays, format } from 'date-fns';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { formatTaskRef, parseTaskRef } from '@shared/refs';
import type { RoleSummary, UserSummary } from '@shared/schemas/core';
import type {
  BoardQuery,
  BoardResponse,
  ListTasksQuery,
  Task,
  TaskCard,
  TaskFilters,
  TaskLabelSummary,
  TaskListResponse,
  TaskSummary,
} from '@shared/schemas/tasks';
import { z } from 'zod';
import type { Actor } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { errors } from '../lib/errors';
import { likeContains } from '../lib/sql';
import { appPaths } from '../lib/urls';
import type { Membership } from './access';
import { attachmentsByParent } from './attachments';
import { isClaimValid } from './claimLease';
import { latestRepliesByItem } from './latestReplies';
import { unreadCountsByItem } from './notifications';
import { pipelineSummaries, stageOf } from './pipelines';
import { hiddenStatusIds } from './projectPipelines';
import { reactionsOf } from './reactions';
import { statusesOf } from './statuses';
import { currentRoleRow, currentUserRow } from './taskAssignees';
import { blockersOf, blockingOf, linkedIssuesOf, openBlockerRefs } from './taskLinks';
import { getUserSummaries, getViaKeys, toUserSummaries, userSummaryColumns } from './users';

/**
 * Read models of the tasks module: task cards (board and list), the full task (task page,
 * `get_task`), and the filters of SPEC §1.9 as SQL. Hydration is batched: one query per related
 * table, whatever the number of tasks.
 */

export type TaskRow = typeof s.task.$inferSelect;

interface ProjectInfo {
  key: string;
  slug: string;
}

/** Keys and team slugs of the projects the rows belong to. */
function projectInfos(db: DbExecutor, rows: readonly TaskRow[]): Map<string, ProjectInfo> {
  const ids = [...new Set(rows.map((row) => row.projectId))];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: s.project.id, key: s.project.key, slug: s.team.slug })
      .from(s.project)
      .innerJoin(s.team, eq(s.team.id, s.project.teamId))
      .where(inArray(s.project.id, ids))
      .all()
      .map((row) => [row.id, { key: row.key, slug: row.slug }]),
  );
}

function groupBy<T, V>(items: readonly T[], key: (item: T) => string, value: (item: T) => V) {
  const groups = new Map<string, V[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(value(item));
    else groups.set(key(item), [value(item)]);
  }
  return groups;
}

/** Board/list cards for task rows (any projects), in the order given. */
export function toTaskCards(
  db: DbExecutor,
  rows: readonly TaskRow[],
  now: Date = new Date(),
): TaskCard[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const projects = projectInfos(db, rows);

  const statuses = new Map(
    db
      .select({
        id: s.status.id,
        name: s.status.name,
        color: s.status.color,
        icon: s.status.icon,
        pipelineId: s.pipeline.id,
        pipelineName: s.pipeline.name,
        pipelineIsDefault: s.pipeline.isDefault,
      })
      .from(s.status)
      .innerJoin(s.pipeline, eq(s.pipeline.id, s.status.pipelineId))
      .where(inArray(s.status.id, [...new Set(rows.map((row) => row.statusId))]))
      .all()
      .map(({ pipelineId, pipelineName, pipelineIsDefault, ...status }) => [
        status.id,
        {
          ...status,
          pipeline: { id: pipelineId, name: pipelineName, isDefault: pipelineIsDefault },
        },
      ]),
  );

  const labels = groupBy(
    db
      .select({
        taskId: s.taskLabel.taskId,
        id: s.label.id,
        name: s.label.name,
        color: s.label.color,
      })
      .from(s.taskLabel)
      .innerJoin(s.label, eq(s.label.id, s.taskLabel.labelId))
      .where(inArray(s.taskLabel.taskId, ids))
      .orderBy(asc(sql`lower(${s.label.name})`))
      .all(),
    (row) => row.taskId,
    ({ id, name, color }): TaskLabelSummary => ({ id, name, color }),
  );

  const assigneeRows = db
    .select({ taskId: s.taskAssigneeUser.taskId, ...userSummaryColumns })
    .from(s.taskAssigneeUser)
    .innerJoin(s.user, eq(s.user.id, s.taskAssigneeUser.userId))
    .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
    .where(and(inArray(s.taskAssigneeUser.taskId, ids), currentUserRow))
    .orderBy(asc(sql`lower(${s.user.name})`))
    .all();
  const assigneeSummaries = toUserSummaries(db, assigneeRows);
  const users = groupBy(
    assigneeRows.flatMap((row, index) => {
      const summary = assigneeSummaries[index];
      return summary ? [{ taskId: row.taskId, summary }] : [];
    }),
    (row) => row.taskId,
    (row): UserSummary => row.summary,
  );

  const roles = groupBy(
    db
      .select({
        taskId: s.taskAssigneeRole.taskId,
        id: s.role.id,
        slug: s.role.slug,
        name: s.role.name,
        color: s.role.color,
        position: s.role.position,
      })
      .from(s.taskAssigneeRole)
      .innerJoin(s.role, eq(s.role.id, s.taskAssigneeRole.roleId))
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeRole.taskId))
      .where(and(inArray(s.taskAssigneeRole.taskId, ids), currentRoleRow))
      .orderBy(desc(s.role.position))
      .all(),
    (row) => row.taskId,
    ({ id, slug, name, color }): RoleSummary => ({ id, slug, name, color }),
  );

  const claimed = rows.filter((row) => isClaimValid(row, now));
  const holders = getUserSummaries(
    db,
    claimed.map((row) => row.claimedById),
  );
  const keys = getViaKeys(
    db,
    claimed.map((row) => row.claimedViaKeyId),
  );
  const blockers = openBlockerRefs(db, ids);
  const pipelines = pipelineSummaries(db, rows);

  return rows.flatMap((row): TaskCard[] => {
    const project = projects.get(row.projectId);
    const status = statuses.get(row.statusId);
    if (!project || !status) return [];
    const holder = row.claimedById ? holders.get(row.claimedById) : undefined;
    const claim =
      holder && row.claimedAt && isClaimValid(row, now)
        ? {
            user: holder,
            via: row.claimedViaKeyId ? (keys.get(row.claimedViaKeyId) ?? null) : null,
            claimedAt: row.claimedAt.toISOString(),
            // Claims don't expire (2026-09-27); kept for older clients.
            expiresAt: null,
          }
        : null;
    const openBlockers = blockers.get(row.id) ?? [];
    return [
      {
        id: row.id,
        ref: formatTaskRef(project.key, row.number),
        number: row.number,
        title: row.title,
        projectId: row.projectId,
        teamId: row.teamId,
        status,
        priority: row.priority,
        dueDate: row.dueDate,
        labels: labels.get(row.id) ?? [],
        assignees: { users: users.get(row.id) ?? [], roles: roles.get(row.id) ?? [] },
        claim,
        blocked: openBlockers.length > 0,
        replyCount: row.replyCount,
        updatedAt: row.updatedAt.toISOString(),
        position: row.position,
        blockers: openBlockers,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        path: appPaths.task(project.slug, project.key, row.number),
        ...(pipelines.has(row.id) ? { pipeline: pipelines.get(row.id) } : {}),
      },
    ];
  });
}

/** The contract shape other modules show (dashboard, my tasks). */
export function toTaskSummary(card: TaskCard): TaskSummary {
  return {
    id: card.id,
    ref: card.ref,
    number: card.number,
    title: card.title,
    projectId: card.projectId,
    teamId: card.teamId,
    status: card.status,
    priority: card.priority,
    dueDate: card.dueDate,
    labels: card.labels,
    assignees: card.assignees,
    claim: card.claim,
    blocked: card.blocked,
    replyCount: card.replyCount,
    updatedAt: card.updatedAt,
    completedAt: card.completedAt,
  };
}

/** Whether `userId` is subscribed to reply notifications of the task. */
function isSubscribed(db: DbExecutor, userId: string, taskId: string): boolean {
  return (
    db
      .select({ subscribed: s.subscription.subscribed })
      .from(s.subscription)
      .where(
        and(
          eq(s.subscription.userId, userId),
          eq(s.subscription.entityType, 'task'),
          eq(s.subscription.entityId, taskId),
        ),
      )
      .get()?.subscribed ?? false
  );
}

/** The full task as the viewer sees it. */
export function toTask(db: DbExecutor, viewer: Actor, row: TaskRow, now: Date = new Date()): Task {
  const [card] = toTaskCards(db, [row], now);
  if (!card) throw errors.notFound('Task');
  const project = projectInfos(db, [row]).get(row.projectId);
  if (!project) throw errors.notFound('Task');
  const author = row.authorId
    ? (getUserSummaries(db, [row.authorId]).get(row.authorId) ?? null)
    : null;
  const via = row.viaKeyId ? (getViaKeys(db, [row.viaKeyId]).get(row.viaKeyId) ?? null) : null;
  const stage = stageOf(db, viewer, row);
  return {
    ...card,
    description: row.description,
    teamSlug: project.slug,
    projectKey: project.key,
    author,
    via,
    editedAt: row.editedAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    blockedBy: blockersOf(db, row.id),
    blocking: blockingOf(db, row.id),
    issues: linkedIssuesOf(db, row.id),
    attachments: attachmentsByParent(db, 'task', [row.id]).get(row.id) ?? [],
    reactions: reactionsOf(db, 'task', row.id, viewer.userId),
    subscribed: isSubscribed(db, viewer.userId, row.id),
    ...(stage ? { stage } : {}),
    conversationMode: row.conversationMode,
  };
}

// ---------------------------------------------------------------------------------------------
// Filters (SPEC §1.9)
// ---------------------------------------------------------------------------------------------

/** Today's date (UTC) as `YYYY-MM-DD`: the default "today" of the due filters. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function plusDays(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return format(addDays(new Date(year, month - 1, day), days), 'yyyy-MM-dd');
}

/** Tasks not completed (in a stage that blocks its dependents). */
const notCompleted = sql`${s.task.completedAt} is null`;

/** Tasks with a live blocker sitting in a stage that blocks its dependents. */
export const isBlocked = sql`exists (
  select 1 from ${s.taskDependency}
  join ${s.task} as blocker on blocker.id = ${s.taskDependency.blockedByTaskId}
  join ${s.status} as blocker_status on blocker_status.id = blocker.status_id
  where ${s.taskDependency.taskId} = ${s.task.id}
    and blocker.deleted_at is null
    and blocker_status.blocks_dependents = 1)`;

/** Tasks assigned (in their current stage) directly to `userId` or to one of `roleIds`. */
export function assignedTo(userId: string, roleIds: readonly string[]): SQL {
  const direct = sql`exists (select 1 from ${s.taskAssigneeUser} where ${s.taskAssigneeUser.taskId} = ${s.task.id} and ${currentUserRow} and ${s.taskAssigneeUser.userId} = ${userId})`;
  if (roleIds.length === 0) return direct;
  return sql`(${direct} or exists (select 1 from ${s.taskAssigneeRole} where ${s.taskAssigneeRole.taskId} = ${s.task.id} and ${currentRoleRow} and ${inArray(s.taskAssigneeRole.roleId, [...roleIds])}))`;
}

/** Tasks someone (a member or a role) is assigned to in their current stage. */
export const isAssigned = sql`(exists (select 1 from ${s.taskAssigneeUser} where ${s.taskAssigneeUser.taskId} = ${s.task.id} and ${currentUserRow})
  or exists (select 1 from ${s.taskAssigneeRole} where ${s.taskAssigneeRole.taskId} = ${s.task.id} and ${currentRoleRow}))`;

/** Tasks nobody (no member, no role) is assigned to in their current stage. */
export const isUnassigned = sql`(not ${isAssigned})`;

export interface ProjectTaskCounts {
  /** Live tasks. */
  tasks: number;
  /** …someone is assigned to in their current stage. */
  assigned: number;
  /** …in a stage that doesn't block its dependents. */
  completed: number;
}

/** Task counts of each project (live tasks only), keyed by project id (every id present). */
export function taskCountsByProject(
  db: DbExecutor,
  projectIds: readonly string[],
): Map<string, ProjectTaskCounts> {
  const counts = new Map<string, ProjectTaskCounts>(
    projectIds.map((id) => [id, { tasks: 0, assigned: 0, completed: 0 }]),
  );
  if (projectIds.length === 0) return counts;
  const rows = db
    .select({
      projectId: s.task.projectId,
      tasks: count(),
      assigned: sql<number>`coalesce(sum(case when ${isAssigned} then 1 else 0 end), 0)`,
      completed: sql<number>`coalesce(sum(case when ${s.task.completedAt} is not null then 1 else 0 end), 0)`,
    })
    .from(s.task)
    .where(and(inArray(s.task.projectId, [...projectIds]), isNull(s.task.deletedAt)))
    .groupBy(s.task.projectId)
    .all();
  for (const row of rows) {
    counts.set(row.projectId, {
      tasks: row.tasks,
      assigned: Number(row.assigned),
      completed: Number(row.completed),
    });
  }
  return counts;
}

/** Claimed tasks (claims don't expire; `now` is kept for callers). */
export function claimValidAt(_now: Date): SQL {
  return sql`(${s.task.claimedById} is not null)`;
}

function assigneeCondition(value: string, viewer: Membership): SQL {
  if (value === 'me') return assignedTo(viewer.userId, viewer.roleIds);
  if (value === 'unassigned') return isUnassigned;
  const [kind, id = ''] = value.split(':');
  if (kind === 'user') {
    return sql`exists (select 1 from ${s.taskAssigneeUser} where ${s.taskAssigneeUser.taskId} = ${s.task.id} and ${currentUserRow} and ${s.taskAssigneeUser.userId} = ${id})`;
  }
  return sql`exists (select 1 from ${s.taskAssigneeRole} where ${s.taskAssigneeRole.taskId} = ${s.task.id} and ${currentRoleRow} and ${s.taskAssigneeRole.roleId} = ${id})`;
}

function textCondition(q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const ref = parseTaskRef(text);
  const number = /^#?\d{1,9}$/.test(text) ? Number(text.replace('#', '')) : ref?.number;
  return or(
    likeContains(s.task.title, text),
    likeContains(s.task.description, text),
    number !== undefined ? eq(s.task.number, number) : undefined,
  );
}

/** SQL conditions for the filters (the caller adds the project and liveness conditions). */
export function filterConditions(
  filters: TaskFilters,
  viewer: Membership,
  now: Date = new Date(),
): SQL[] {
  const conditions: Array<SQL | undefined> = [];
  if (filters.q) conditions.push(textCondition(filters.q));
  if (filters.status?.length) conditions.push(inArray(s.task.statusId, filters.status));
  if (filters.label?.length) {
    conditions.push(
      sql`exists (select 1 from ${s.taskLabel} where ${s.taskLabel.taskId} = ${s.task.id} and ${inArray(s.taskLabel.labelId, filters.label)})`,
    );
  }
  if (filters.priority?.length) conditions.push(inArray(s.task.priority, filters.priority));
  if (filters.assignee?.length) {
    conditions.push(or(...filters.assignee.map((value) => assigneeCondition(value, viewer))));
  }
  if (filters.due) {
    const today = filters.today ?? utcToday(now);
    switch (filters.due) {
      case 'overdue':
        conditions.push(sql`${s.task.dueDate} < ${today}`, notCompleted);
        break;
      case 'today':
        conditions.push(eq(s.task.dueDate, today));
        break;
      case 'week':
        conditions.push(sql`${s.task.dueDate} between ${today} and ${plusDays(today, 6)}`);
        break;
      case 'none':
        conditions.push(isNull(s.task.dueDate));
        break;
    }
  }
  if (filters.claimed === 'yes') conditions.push(claimValidAt(now));
  if (filters.claimed === 'no') conditions.push(not(claimValidAt(now)));
  if (filters.claimed === 'mine') {
    conditions.push(claimValidAt(now), eq(s.task.claimedById, viewer.userId));
  }
  if (filters.blocked === 'yes') conditions.push(isBlocked);
  if (filters.blocked === 'no') conditions.push(not(isBlocked));
  if (filters.completed === 'no') conditions.push(notCompleted);
  if (filters.completed === 'yes') conditions.push(not(notCompleted));
  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

function projectTasks(
  db: DbExecutor,
  projectId: string,
  filters: TaskFilters,
  viewer: Membership,
  now: Date,
) {
  const hidden = hiddenStatusIds(db, viewer.userId, [projectId]);
  return and(
    eq(s.task.projectId, projectId),
    isNull(s.task.deletedAt),
    hidden.size > 0 ? notInArray(s.task.statusId, [...hidden]) : undefined,
    filters.pipeline
      ? sql`${s.task.statusId} in (select ${s.status.id} from ${s.status} where ${s.status.pipelineId} = ${filters.pipeline})`
      : undefined,
    ...filterConditions(filters, viewer, now),
  );
}

/** Board order within a column: fractional position, then number for ties. */
const boardOrder = [asc(sql`${s.task.position} collate binary`), asc(s.task.number)];

/** Adds the viewer's unread notification count to each card (BAT-16), in one query. */
function withUnreadCounts(db: DbExecutor, userId: string, cards: TaskCard[]): TaskCard[] {
  const unread = unreadCountsByItem(
    db,
    userId,
    'task',
    cards.map((card) => card.id),
  );
  return cards.map((card) => ({ ...card, unreadCount: unread.get(card.id) ?? 0 }));
}

/** The board: every status of the project as a column, with its matching tasks in order. */
export function boardOf(
  db: DbExecutor,
  projectId: string,
  viewer: Membership,
  query: BoardQuery,
  now: Date = new Date(),
): BoardResponse {
  // Columns of the pipelines the viewer can see (BAT-25), or of the one asked for.
  const hidden = hiddenStatusIds(db, viewer.userId, [projectId]);
  const statuses = statusesOf(db, projectId).filter(
    (status) => !hidden.has(status.id) && (!query.pipeline || status.pipelineId === query.pipeline),
  );
  const rows = db
    .select()
    .from(s.task)
    .where(projectTasks(db, projectId, query, viewer, now))
    .orderBy(...boardOrder)
    .all();
  const byStatus = groupBy(
    rows,
    (row) => row.statusId,
    (row) => row,
  );
  const shown = statuses.flatMap((status) => (byStatus.get(status.id) ?? []).slice(0, query.limit));
  const cards = new Map(
    withUnreadCounts(db, viewer.userId, toTaskCards(db, shown, now)).map((card) => [card.id, card]),
  );
  return {
    columns: statuses.map((status) => {
      const matching = byStatus.get(status.id) ?? [];
      return {
        status,
        count: matching.length,
        tasks: matching.slice(0, query.limit).flatMap((row) => cards.get(row.id) ?? []),
      };
    }),
    total: rows.length,
  };
}

const offsetCursorSchema = z.tuple([z.number().int().nonnegative()]);

function listOrder(query: ListTasksQuery): SQL[] {
  const direction = query.order === 'desc' ? desc : asc;
  switch (query.sort) {
    case 'status':
      return [
        direction(
          sql`(select ${s.pipeline.position} from ${s.status} join ${s.pipeline} on ${s.pipeline.id} = ${s.status.pipelineId} where ${s.status.id} = ${s.task.statusId})`,
        ),
        direction(
          sql`(select ${s.status.position} from ${s.status} where ${s.status.id} = ${s.task.statusId})`,
        ),
        ...boardOrder,
      ];
    case 'number':
      return [direction(s.task.number)];
    case 'title':
      return [direction(sql`lower(${s.task.title})`), asc(s.task.number)];
    case 'priority':
      return [direction(s.task.priority), asc(s.task.number)];
    case 'dueDate':
      // Tasks without a due date come last in both directions.
      return [asc(sql`${s.task.dueDate} is null`), direction(s.task.dueDate), asc(s.task.number)];
    case 'createdAt':
      return [direction(s.task.createdAt), direction(s.task.number)];
    case 'updatedAt':
      return [direction(s.task.updatedAt), asc(s.task.number)];
    case 'lastActivityAt':
      return [direction(s.task.lastActivityAt), direction(s.task.number)];
  }
}

/** A page of the list view (sorted, filtered). */
export function listOf(
  db: DbExecutor,
  projectId: string,
  viewer: Membership,
  query: ListTasksQuery,
  now: Date = new Date(),
): TaskListResponse {
  const where = projectTasks(db, projectId, query, viewer, now);
  const [offset = 0] = query.cursor ? decodeCursor(query.cursor, offsetCursorSchema) : [0];
  const total = db.select({ n: count() }).from(s.task).where(where).get()?.n ?? 0;
  const rows = db
    .select()
    .from(s.task)
    .where(where)
    .orderBy(...listOrder(query))
    .limit(query.limit)
    .offset(offset)
    .all();
  const next = offset + rows.length;
  const activity = new Map(rows.map((row) => [row.id, row.lastActivityAt.toISOString()]));
  const latest = query.latestReply
    ? latestRepliesByItem(
        db,
        'task',
        rows.map((row) => row.id),
      )
    : null;
  return {
    items: withUnreadCounts(db, viewer.userId, toTaskCards(db, rows, now)).map((card) => ({
      ...card,
      lastActivityAt: activity.get(card.id),
      ...(latest ? { latestReply: latest.get(card.id) ?? null } : {}),
    })),
    total,
    nextCursor: next < total && rows.length > 0 ? encodeCursor([next]) : null,
  };
}
