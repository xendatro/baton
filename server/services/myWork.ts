import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { priorityByKey, type PriorityValue } from '@shared/constants';
import { formatTaskRef, parseTaskRef } from '@shared/refs';
import type { RoleSummary } from '@shared/schemas/core';
import {
  DUE_SOON_DAYS,
  MY_TASKS_MAX,
  type DueFilter,
  type MyTask,
  type MyTasksQuery,
  type MyTasksResponse,
  type MyTasksSort,
} from '@shared/schemas/work';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { likeContains } from '../lib/sql';
import { appPaths } from '../lib/urls';
import { listMemberships, requireMember, type Membership } from './access';
import { getUserSummaries, getViaKeys } from './users';

/**
 * My tasks (SPEC §1.9): every open task assigned to the caller, directly or through a role they
 * have (`@everyone` included), across all their live teams and projects. The dashboard service
 * builds its lists from the same helpers.
 */

// ---------------------------------------------------------------------------------------------
// Dates (due dates are calendar dates without a time zone)
// ---------------------------------------------------------------------------------------------

/** Today's date as `YYYY-MM-DD` in UTC, the fallback when the caller doesn't say. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The last day that still counts as "due soon" (today included, `DUE_SOON_DAYS` days). */
export function dueSoonUntil(today: string): string {
  return addDays(today, DUE_SOON_DAYS - 1);
}

/** SQL condition on `task.due_date` for a due filter. Dates compare as `YYYY-MM-DD` strings. */
export function dueCondition(due: DueFilter, today: string): SQL | undefined {
  switch (due) {
    case 'overdue':
      return lt(s.task.dueDate, today);
    case 'today':
      return eq(s.task.dueDate, today);
    case 'week':
      return and(gte(s.task.dueDate, today), lte(s.task.dueDate, dueSoonUntil(today)));
    case 'none':
      return isNull(s.task.dueDate);
  }
}

// ---------------------------------------------------------------------------------------------
// Scope: the caller's teams and roles
// ---------------------------------------------------------------------------------------------

export interface WorkScope {
  userId: string;
  memberships: Membership[];
  teamIds: string[];
  /** The caller's explicit roles plus the `@everyone` role of each of their teams. */
  roleIds: string[];
}

export function workScope(db: DbExecutor, userId: string): WorkScope {
  const memberships = listMemberships(db, userId);
  const teamIds = memberships.map((membership) => membership.teamId);
  const everyoneRoles =
    teamIds.length === 0
      ? []
      : db
          .select({ id: s.role.id })
          .from(s.role)
          .where(and(inArray(s.role.teamId, teamIds), eq(s.role.isEveryone, true)))
          .all()
          .map((role) => role.id);
  return {
    userId,
    memberships,
    teamIds,
    roleIds: [...memberships.flatMap((membership) => membership.roleIds), ...everyoneRoles],
  };
}

/** Tasks (of live projects in the caller's live teams) that are live themselves. */
function liveTaskCondition(scope: WorkScope): SQL | undefined {
  return and(
    inArray(s.task.teamId, scope.teamIds),
    isNull(s.task.deletedAt),
    isNull(s.project.deletedAt),
    isNull(s.team.deletedAt),
  );
}

/** Tasks assigned to the caller directly or through one of their roles. */
function assignedToCondition(db: DbExecutor, scope: WorkScope): SQL | undefined {
  const direct = inArray(
    s.task.id,
    db
      .select({ id: s.taskAssigneeUser.taskId })
      .from(s.taskAssigneeUser)
      .where(eq(s.taskAssigneeUser.userId, scope.userId)),
  );
  if (scope.roleIds.length === 0) return direct;
  return or(
    direct,
    inArray(
      s.task.id,
      db
        .select({ id: s.taskAssigneeRole.taskId })
        .from(s.taskAssigneeRole)
        .where(inArray(s.taskAssigneeRole.roleId, scope.roleIds)),
    ),
  );
}

/** Open tasks assigned to the caller: the base of My tasks and of the dashboard's lists. */
export function assignedOpenCondition(db: DbExecutor, scope: WorkScope): SQL | undefined {
  return and(
    liveTaskCondition(scope),
    eq(s.status.category, 'open'),
    assignedToCondition(db, scope),
  );
}

/** Tasks with a valid claim held by the caller (on the web or through any of their keys). */
export function claimedByCondition(scope: WorkScope, now: Date): SQL | undefined {
  return and(
    liveTaskCondition(scope),
    eq(s.task.claimedById, scope.userId),
    gt(s.task.claimExpiresAt, now),
  );
}

// ---------------------------------------------------------------------------------------------
// Queries and hydration
// ---------------------------------------------------------------------------------------------

const taskColumns = {
  task: s.task,
  status: {
    id: s.status.id,
    name: s.status.name,
    color: s.status.color,
    category: s.status.category,
  },
  project: {
    id: s.project.id,
    key: s.project.key,
    name: s.project.name,
    icon: s.project.icon,
    color: s.project.color,
  },
  team: {
    id: s.team.id,
    slug: s.team.slug,
    name: s.team.name,
    icon: s.team.icon,
    color: s.team.color,
  },
};

/** `select … from task` joined with its status, project and team. */
export function selectTasks(db: DbExecutor) {
  return db
    .select(taskColumns)
    .from(s.task)
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .innerJoin(s.team, eq(s.team.id, s.task.teamId));
}

/** Number of tasks matching `where` (same joins as `selectTasks`). */
export function countTasks(db: DbExecutor, where: SQL | undefined): number {
  return (
    db
      .select({ value: count() })
      .from(s.task)
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .innerJoin(s.project, eq(s.project.id, s.task.projectId))
      .innerJoin(s.team, eq(s.team.id, s.task.teamId))
      .where(where)
      .get()?.value ?? 0
  );
}

export type TaskContextRow = ReturnType<ReturnType<typeof selectTasks>['all']>[number];

/** `ORDER BY` for each sort of My tasks. Undated tasks come after dated ones. */
export function taskOrder(sort: MyTasksSort): SQL[] {
  const dueLast = sql`${s.task.dueDate} is null`;
  switch (sort) {
    case 'priority':
      return [
        desc(s.task.priority),
        asc(dueLast),
        asc(s.task.dueDate),
        desc(s.task.updatedAt),
        asc(s.task.id),
      ];
    case 'due':
      return [
        asc(dueLast),
        asc(s.task.dueDate),
        desc(s.task.priority),
        desc(s.task.updatedAt),
        asc(s.task.id),
      ];
    case 'updated':
      return [desc(s.task.updatedAt), asc(s.task.id)];
    case 'created':
      return [desc(s.task.createdAt), asc(s.task.id)];
  }
}

/** Groups `[taskId, value]` rows by task id. */
function groupByTask<T>(rows: ReadonlyArray<{ taskId: string } & T>): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const { taskId, ...rest } of rows) {
    const list = map.get(taskId) ?? [];
    list.push(rest as unknown as T);
    map.set(taskId, list);
  }
  return map;
}

/**
 * Wire shapes of the given rows: labels, assignees, the valid claim, blocked state and why each
 * task is the caller's. A handful of batched queries, whatever the number of rows.
 */
export function toMyTasks(
  db: DbExecutor,
  rows: readonly TaskContextRow[],
  scope: WorkScope,
  now: Date = new Date(),
): MyTask[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.task.id);

  const labels = groupByTask(
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
      .orderBy(asc(s.label.name))
      .all(),
  );

  const userAssignees = groupByTask(
    db
      .select({ taskId: s.taskAssigneeUser.taskId, userId: s.taskAssigneeUser.userId })
      .from(s.taskAssigneeUser)
      .where(inArray(s.taskAssigneeUser.taskId, ids))
      .all(),
  );
  const roleAssignees = groupByTask<RoleSummary>(
    db
      .select({
        taskId: s.taskAssigneeRole.taskId,
        id: s.role.id,
        slug: s.role.slug,
        name: s.role.name,
        color: s.role.color,
      })
      .from(s.taskAssigneeRole)
      .innerJoin(s.role, eq(s.role.id, s.taskAssigneeRole.roleId))
      .where(inArray(s.taskAssigneeRole.taskId, ids))
      .orderBy(desc(s.role.position), asc(s.role.name))
      .all(),
  );

  // A task is blocked while a live task it depends on is in an open-category status.
  const blocker = db
    .select({ id: s.task.id, statusId: s.task.statusId, deletedAt: s.task.deletedAt })
    .from(s.task)
    .as('blocker');
  const blocked = new Set(
    db
      .select({ taskId: s.taskDependency.taskId })
      .from(s.taskDependency)
      .innerJoin(blocker, eq(blocker.id, s.taskDependency.blockedByTaskId))
      .innerJoin(s.status, eq(s.status.id, blocker.statusId))
      .where(
        and(
          inArray(s.taskDependency.taskId, ids),
          isNull(blocker.deletedAt),
          eq(s.status.category, 'open'),
        ),
      )
      .all()
      .map((row) => row.taskId),
  );

  const isClaimed = (task: TaskContextRow['task']) =>
    task.claimedById !== null &&
    task.claimedAt !== null &&
    task.claimExpiresAt !== null &&
    task.claimExpiresAt.getTime() > now.getTime();

  const users = getUserSummaries(db, [
    ...[...userAssignees.values()].flat().map((entry) => entry.userId),
    ...rows.filter((row) => isClaimed(row.task)).map((row) => row.task.claimedById),
  ]);
  const keys = getViaKeys(
    db,
    rows.filter((row) => isClaimed(row.task)).map((row) => row.task.claimedViaKeyId),
  );
  const myRoles = new Set(scope.roleIds);

  return rows.map(({ task, status, project, team }) => {
    const assignedUsers = (userAssignees.get(task.id) ?? [])
      .map((entry) => users.get(entry.userId))
      .filter((user) => user !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    const assignedRoles = roleAssignees.get(task.id) ?? [];
    const claimant = isClaimed(task) && task.claimedById ? users.get(task.claimedById) : undefined;
    return {
      id: task.id,
      ref: formatTaskRef(project.key, task.number),
      number: task.number,
      title: task.title,
      projectId: task.projectId,
      teamId: task.teamId,
      status,
      priority: task.priority,
      dueDate: task.dueDate,
      labels: labels.get(task.id) ?? [],
      assignees: { users: assignedUsers, roles: assignedRoles },
      claim:
        claimant && task.claimedAt && task.claimExpiresAt
          ? {
              user: claimant,
              via: task.claimedViaKeyId ? (keys.get(task.claimedViaKeyId) ?? null) : null,
              claimedAt: task.claimedAt.toISOString(),
              expiresAt: task.claimExpiresAt.toISOString(),
            }
          : null,
      blocked: blocked.has(task.id),
      replyCount: task.replyCount,
      updatedAt: task.updatedAt.toISOString(),
      team,
      project,
      url: appPaths.task(team.slug, project.key, task.number),
      assignment: {
        direct: assignedUsers.some((user) => user.id === scope.userId),
        roles: assignedRoles.filter((role) => myRoles.has(role.id)),
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/me/tasks
// ---------------------------------------------------------------------------------------------

/** Title containing `q`, or the task `q` names (`KEY-12`, `12` or `#12`). */
function textCondition(q: string): SQL | undefined {
  const ref = parseTaskRef(q);
  const number = /^#?(\d{1,9})$/.exec(q);
  return or(
    likeContains(s.task.title, q),
    ref
      ? and(
          ref.teamSlug ? eq(s.team.slug, ref.teamSlug) : undefined,
          eq(s.project.key, ref.projectKey),
          eq(s.task.number, ref.number),
        )
      : undefined,
    number ? eq(s.task.number, Number(number[1])) : undefined,
  );
}

/**
 * Every open task assigned to the caller (directly or through their roles) across their teams,
 * filtered and sorted. Filtering by a team or project the caller can't see is `not_found`.
 */
export function listMyTasks(deps: AppDeps, actor: Actor, query: MyTasksQuery): MyTasksResponse {
  const { orm } = deps.db;
  const today = query.today ?? utcToday();
  if (query.teamId) requireMember(orm, actor, query.teamId);
  if (query.projectId) {
    const project = orm
      .select({ teamId: s.project.teamId })
      .from(s.project)
      .where(and(eq(s.project.id, query.projectId), isNull(s.project.deletedAt)))
      .get();
    if (!project) throw errors.notFound('Project');
    requireMember(orm, actor, project.teamId, 'Project');
  }

  const scope = workScope(orm, actor.userId);
  if (scope.teamIds.length === 0) return { items: [], total: 0 };

  const priorities: PriorityValue[] | undefined = query.priority?.map(priorityByKey);
  const where = and(
    assignedOpenCondition(orm, scope),
    query.teamId ? eq(s.task.teamId, query.teamId) : undefined,
    query.projectId ? eq(s.task.projectId, query.projectId) : undefined,
    priorities && priorities.length > 0 ? inArray(s.task.priority, priorities) : undefined,
    query.due ? dueCondition(query.due, today) : undefined,
    query.q ? textCondition(query.q) : undefined,
  );
  const rows = selectTasks(orm)
    .where(where)
    .orderBy(...taskOrder(query.sort))
    .limit(MY_TASKS_MAX)
    .all();
  const total = rows.length < MY_TASKS_MAX ? rows.length : countTasks(orm, where);
  return { items: toMyTasks(orm, rows, scope), total };
}
