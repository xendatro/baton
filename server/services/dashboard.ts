import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { ActivityEntityType } from '@shared/constants';
import {
  DASHBOARD_ACTIVITY_LIMIT,
  DASHBOARD_LIST_LIMIT,
  type DashboardCounts,
  type DashboardQuery,
  type DashboardResponse,
  type DashboardTeam,
} from '@shared/schemas/work';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { appPaths } from '../lib/urls';
import { canRestoreContent, hasPermission, type Membership } from './access';
import { toActivityEntries, type ActivityRow } from './activity';
import { canSeeAttachmentHistory } from './attachments';
import { trashedItem, trashedReply, type TrashEntry } from './items';
import {
  assignedOpenCondition,
  claimedByCondition,
  countTasks,
  dueSoonUntil,
  selectTasks,
  taskOrder,
  toMyTasks,
  workScope,
  type WorkScope,
} from './myWork';
import { utcToday } from './taskViews';
import { listProjectCards, memberCounts } from './teams';

/**
 * The dashboard (SPEC §1.9): what is assigned to me, overdue and due soon, what I or my agents
 * have claimed, recent activity across my teams and my teams with their projects.
 */

/** Claimed tasks listed on the dashboard. */
const CLAIMED_LIMIT = 20;

/** Entity types whose history every member may see (the rest is the team audit log). */
const MEMBER_VISIBLE_TYPES: ActivityEntityType[] = ['issue', 'task', 'reply', 'attachment'];

/** Activity rows read per batch while looking for visible ones, and at most in all. */
const ACTIVITY_BATCH = 100;
const ACTIVITY_SCAN_LIMIT = 1000;

function assignedCounts(
  db: DbExecutor,
  scope: WorkScope,
  today: string,
): Omit<DashboardCounts, 'claimed'> {
  const soon = dueSoonUntil(today);
  const row = db
    .select({
      assigned: sql<number>`count(*)`,
      overdue: sql<number>`coalesce(sum(case when ${s.task.dueDate} < ${today} then 1 else 0 end), 0)`,
      dueSoon: sql<number>`coalesce(sum(case when ${s.task.dueDate} between ${today} and ${soon} then 1 else 0 end), 0)`,
    })
    .from(s.task)
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .innerJoin(s.project, eq(s.project.id, s.task.projectId))
    .innerJoin(s.team, eq(s.team.id, s.task.teamId))
    .where(assignedOpenCondition(scope))
    .get();
  return {
    assigned: Number(row?.assigned ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueSoon: Number(row?.dueSoon ?? 0),
  };
}

/**
 * Can the member see this activity row? Everything with `VIEW_AUDIT_LOG`; otherwise per-item
 * history (issues, tasks, replies, files) whose item is live, or in Trash for its author and
 * `MANAGE_TRASH` (the rule `GET /api/activity` applies).
 */
function createVisibility(db: DbExecutor, memberships: readonly Membership[]) {
  const byTeam = new Map(memberships.map((membership) => [membership.teamId, membership]));
  const trashCache = new Map<string, TrashEntry | null>();
  const trashEntry = (type: 'issue' | 'task' | 'reply', id: string) => {
    const key = `${type}:${id}`;
    if (!trashCache.has(key)) {
      trashCache.set(key, type === 'reply' ? trashedReply(db, id) : trashedItem(db, type, id));
    }
    return trashCache.get(key) ?? null;
  };
  return (row: ActivityRow): boolean => {
    const membership = row.teamId ? byTeam.get(row.teamId) : undefined;
    if (!membership) return false;
    if (hasPermission(membership, 'VIEW_AUDIT_LOG')) return true;
    switch (row.entityType) {
      case 'issue':
      case 'task':
      case 'reply': {
        const trashed = trashEntry(row.entityType, row.entityId);
        return !trashed || canRestoreContent(membership, trashed.authorId);
      }
      case 'attachment':
        return canSeeAttachmentHistory(db, membership, row.entityId);
      default:
        return false;
    }
  };
}

/** The newest activity rows across the caller's teams that they may see. */
export function recentActivity(
  db: DbExecutor,
  memberships: readonly Membership[],
  limit: number = DASHBOARD_ACTIVITY_LIMIT,
): ActivityRow[] {
  const auditTeams = memberships
    .filter((membership) => hasPermission(membership, 'VIEW_AUDIT_LOG'))
    .map((membership) => membership.teamId);
  const otherTeams = memberships
    .filter((membership) => !hasPermission(membership, 'VIEW_AUDIT_LOG'))
    .map((membership) => membership.teamId);
  const scope = or(
    auditTeams.length > 0 ? inArray(s.activity.teamId, auditTeams) : undefined,
    otherTeams.length > 0
      ? and(
          inArray(s.activity.teamId, otherTeams),
          inArray(s.activity.entityType, MEMBER_VISIBLE_TYPES),
        )
      : undefined,
  );
  if (!scope) return [];

  const visible = createVisibility(db, memberships);
  const found: ActivityRow[] = [];
  let before: ActivityRow | undefined;
  for (let scanned = 0; scanned < ACTIVITY_SCAN_LIMIT && found.length < limit;) {
    const cursor: SQL | undefined = before
      ? or(
          lt(s.activity.createdAt, before.createdAt),
          and(eq(s.activity.createdAt, before.createdAt), lt(s.activity.id, before.id)),
        )
      : undefined;
    const batch = db
      .select()
      .from(s.activity)
      .where(and(scope, cursor))
      .orderBy(desc(s.activity.createdAt), desc(s.activity.id))
      .limit(ACTIVITY_BATCH)
      .all();
    for (const row of batch) {
      if (visible(row)) found.push(row);
      if (found.length === limit) break;
    }
    scanned += batch.length;
    before = batch.at(-1);
    if (batch.length < ACTIVITY_BATCH) break;
  }
  return found;
}

/** The caller's live teams by name, with member counts and project cards. */
function teamsWithProjects(db: DbExecutor, teamIds: readonly string[]): DashboardTeam[] {
  if (teamIds.length === 0) return [];
  const teams = db
    .select()
    .from(s.team)
    .where(and(inArray(s.team.id, [...teamIds]), isNull(s.team.deletedAt)))
    .orderBy(asc(s.team.name))
    .all();
  const members = memberCounts(
    db,
    teams.map((team) => team.id),
  );
  return teams.map((team) => ({
    id: team.id,
    slug: team.slug,
    name: team.name,
    icon: team.icon,
    color: team.color,
    memberCount: members.get(team.id) ?? 0,
    url: appPaths.team(team.slug),
    projects: listProjectCards(db, team.id).map((project) => ({
      ...project,
      url: appPaths.project(team.slug, project.key),
    })),
  }));
}

/** `GET /api/me/dashboard` and MCP `dashboard_summary`. */
export function getDashboard(
  deps: AppDeps,
  actor: Actor,
  query: DashboardQuery,
  now: Date = new Date(),
): DashboardResponse {
  const { orm } = deps.db;
  const today = query.today ?? utcToday(now);
  const scope = workScope(orm, actor.userId);
  if (scope.teamIds.length === 0) {
    return {
      today,
      counts: { assigned: 0, overdue: 0, dueSoon: 0, claimed: 0 },
      assigned: [],
      overdue: [],
      dueSoon: [],
      claimed: [],
      activity: [],
      teams: [],
    };
  }

  const assignedOpen = assignedOpenCondition(scope);
  const list = (where: SQL | undefined, order: SQL[], limit = DASHBOARD_LIST_LIMIT) =>
    toMyTasks(
      orm,
      selectTasks(orm)
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .all(),
      scope,
      now,
    );

  const claimedWhere = claimedByCondition(scope, now);
  return {
    today,
    counts: { ...assignedCounts(orm, scope, today), claimed: countTasks(orm, claimedWhere) },
    assigned: list(assignedOpen, taskOrder('priority')),
    overdue: list(and(assignedOpen, lt(s.task.dueDate, today)), taskOrder('due')),
    dueSoon: list(
      and(assignedOpen, gte(s.task.dueDate, today), lte(s.task.dueDate, dueSoonUntil(today))),
      taskOrder('due'),
    ),
    claimed: list(claimedWhere, [desc(s.task.claimedAt), asc(s.task.id)], CLAIMED_LIMIT),
    activity: toActivityEntries(orm, recentActivity(orm, scope.memberships)),
    teams: teamsWithProjects(orm, scope.teamIds),
  };
}
