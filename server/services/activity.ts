import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { ActivityEntityType } from '@shared/constants';
import type { Paginated } from '@shared/schemas/common';
import type {
  ActivityEntry,
  ActivityListResponse,
  AuditLogQuery,
  EntityActivityQuery,
  ViaKey,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import { queueLiveEvent, type DbExecutor, type Tx } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor, timeIdCursorSchema } from '../lib/cursor';
import type { Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { inviteCodeHint } from '../lib/security';
import { likePrefix } from '../lib/sql';
import { appPaths } from '../lib/urls';
import {
  canRestoreContent,
  hasPermission,
  requireMember,
  requirePermission,
  type Membership,
} from './access';
import { canSeeAttachmentHistory } from './attachments';
import { trashedItem, trashedReply } from './items';
import { getUserSummaries, getViaKeys } from './users';

/**
 * The append-only audit log (SPEC §1.11). Every mutation calls `recordActivity` inside its
 * `db.write` transaction; per-item history, the team audit log and the per-user security log
 * are all queries over the same `activity` table.
 */

export type ActivityRow = typeof s.activity.$inferSelect;

export interface ActivityInput {
  /** Null only for account-level entries (the security log). */
  teamId: string | null;
  projectId?: string | null;
  entityType: ActivityEntityType;
  entityId: string;
  /** Dotted action, e.g. `task.created`, `task.status_changed`, `user.signed_in`. */
  action: string;
  /** Field-level changes with human-readable values (see `diffFields` in lib/diff.ts). */
  changes?: Changes;
  /** Context such as a title snapshot, e.g. `{ title: 'Fix login', ref: 'API-12' }`. */
  meta?: Record<string, unknown>;
}

/**
 * Appends an activity row in the caller's transaction and queues an `activity.created` live event
 * (delivered after commit). A null actor records a system action. The key name and its agent are
 * snapshotted, so the log keeps saying "Claude via Ethan's laptop" after the key is renamed or
 * deleted.
 */
export function recordActivity(tx: Tx, actor: Actor | null, input: ActivityInput): ActivityRow {
  const row = tx
    .insert(s.activity)
    .values({
      id: newId(),
      teamId: input.teamId,
      projectId: input.projectId ?? null,
      actorId: actor?.userId ?? null,
      source: actor?.source ?? 'system',
      viaKeyId: actor?.key?.id ?? null,
      viaKeyName: actor?.key?.name ?? null,
      viaAgentName: actor?.key?.agentName ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      changes: input.changes ?? {},
      meta: input.meta ?? {},
      createdAt: new Date(),
    })
    .returning()
    .get();
  if (row.teamId) recordFacets(tx, row, row.teamId);
  queueLiveEvent(tx, {
    type: 'activity.created',
    teamId: row.teamId,
    projectId: row.projectId,
    entityType: 'activity',
    entityId: row.id,
    parentType: row.entityType,
    parentId: row.entityId,
    actorId: row.actorId,
    // Account-level rows have no team: deliver them to the user they belong to.
    ...(row.teamId === null && row.actorId ? { userId: row.actorId } : {}),
  });
  return row;
}

/**
 * Adds the row's values to its team's audit-log facets (`activity_facet`), which the filter menus
 * read instead of scanning the log. Values already listed cost one primary-key lookup each; a
 * key's name, owner and last use follow its newest row.
 */
function recordFacets(tx: Tx, row: ActivityRow, teamId: string): void {
  const values: Array<{ kind: s.ActivityFacetKind; value: string | null }> = [
    { kind: 'actor', value: row.actorId },
    { kind: 'source', value: row.source },
    { kind: 'entity_type', value: row.entityType },
    { kind: 'action', value: row.action },
    { kind: 'project', value: row.projectId },
  ];
  tx.insert(s.activityFacet)
    .values(values.flatMap(({ kind, value }) => (value === null ? [] : [{ teamId, kind, value }])))
    .onConflictDoNothing()
    .run();
  if (row.viaKeyId) {
    const key = { keyName: row.viaKeyName, actorId: row.actorId, lastAt: row.createdAt };
    tx.insert(s.activityFacet)
      .values({ teamId, kind: 'key', value: row.viaKeyId, ...key })
      .onConflictDoUpdate({
        target: [s.activityFacet.teamId, s.activityFacet.kind, s.activityFacet.value],
        set: key,
        setWhere: sql`${s.activityFacet.lastAt} is null or ${s.activityFacet.lastAt} <= excluded.last_at`,
      })
      .run();
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * Relative URLs of the entities the rows are about (null when the entity is gone or deleted).
 * Batched: one query per entity type present.
 */
function resolveEntityUrls(
  db: DbExecutor,
  rows: readonly ActivityRow[],
): Map<string, string | null> {
  const urls = new Map<string, string | null>();
  const idsOf = (type: ActivityEntityType) => [
    ...new Set(rows.filter((row) => row.entityType === type).map((row) => row.entityId)),
  ];

  const teamIds = [...new Set(rows.map((row) => row.teamId).filter((id): id is string => !!id))];
  const teams = new Map(
    (teamIds.length === 0
      ? []
      : db
          .select({ id: s.team.id, slug: s.team.slug })
          .from(s.team)
          .where(and(inArray(s.team.id, teamIds), isNull(s.team.deletedAt)))
          .all()
    ).map((team) => [team.id, team.slug]),
  );
  const projectIds = [
    ...new Set(rows.map((row) => row.projectId).filter((id): id is string => !!id)),
  ];
  const projects = new Map(
    (projectIds.length === 0
      ? []
      : db
          .select({ id: s.project.id, key: s.project.key, teamId: s.project.teamId })
          .from(s.project)
          .where(and(inArray(s.project.id, projectIds), isNull(s.project.deletedAt)))
          .all()
    ).map((project) => [project.id, project]),
  );
  const projectPath = (projectId: string | null) => {
    const project = projectId ? projects.get(projectId) : undefined;
    const slug = project ? teams.get(project.teamId) : undefined;
    return project && slug ? { slug, key: project.key } : null;
  };

  const itemPaths = (type: 'issue' | 'task', ids: readonly string[]) => {
    const paths = new Map<string, string>();
    if (ids.length === 0) return paths;
    const table = type === 'issue' ? s.issue : s.task;
    const found = db
      .select({ id: table.id, number: table.number, projectId: table.projectId })
      .from(table)
      .where(and(inArray(table.id, [...ids]), isNull(table.deletedAt)))
      .all();
    for (const item of found) {
      const project = projectPath(item.projectId);
      if (project) paths.set(item.id, appPaths[type](project.slug, project.key, item.number));
    }
    return paths;
  };
  const issuePaths = itemPaths('issue', idsOf('issue'));
  const taskPaths = itemPaths('task', idsOf('task'));

  const replyIds = idsOf('reply');
  const replies =
    replyIds.length === 0
      ? []
      : db
          .select({ id: s.reply.id, parentType: s.reply.parentType, parentId: s.reply.parentId })
          .from(s.reply)
          .where(and(inArray(s.reply.id, replyIds), isNull(s.reply.deletedAt)))
          .all();
  const parentPaths = {
    issue: itemPaths(
      'issue',
      replies.filter((reply) => reply.parentType === 'issue').map((reply) => reply.parentId),
    ),
    task: itemPaths(
      'task',
      replies.filter((reply) => reply.parentType === 'task').map((reply) => reply.parentId),
    ),
  };
  const replyPaths = new Map<string, string>();
  for (const reply of replies) {
    const parentPath = parentPaths[reply.parentType].get(reply.parentId);
    if (parentPath) replyPaths.set(reply.id, appPaths.reply(parentPath, reply.id));
  }

  const roleIds = idsOf('role');
  const liveRoles = new Set(
    roleIds.length === 0
      ? []
      : db
          .select({ id: s.role.id })
          .from(s.role)
          .where(inArray(s.role.id, roleIds))
          .all()
          .map((role) => role.id),
  );

  for (const row of rows) {
    const slug = row.teamId ? teams.get(row.teamId) : undefined;
    const project = projectPath(row.projectId);
    let url: string | null = null;
    switch (row.entityType) {
      case 'team':
        url = slug ? appPaths.team(slug) : null;
        break;
      case 'member':
        url = slug ? appPaths.teamSettings(slug, 'members') : null;
        break;
      case 'invite':
        url = slug ? appPaths.teamSettings(slug, 'invites') : null;
        break;
      case 'role':
        url = slug && liveRoles.has(row.entityId) ? appPaths.role(slug, row.entityId) : null;
        break;
      case 'project':
        url = project ? appPaths.project(project.slug, project.key) : null;
        break;
      case 'status':
        url = project ? appPaths.projectSettings(project.slug, project.key, 'statuses') : null;
        break;
      case 'label':
        url = project ? appPaths.projectSettings(project.slug, project.key, 'labels') : null;
        break;
      case 'issue':
        url = issuePaths.get(row.entityId) ?? null;
        break;
      case 'task':
        url = taskPaths.get(row.entityId) ?? null;
        break;
      case 'reply':
        url = replyPaths.get(row.entityId) ?? null;
        break;
      case 'api_key':
        url = appPaths.apiKeys();
        break;
      case 'user':
        url = row.teamId === null ? appPaths.accountSecurity() : null;
        break;
      case 'attachment':
        url = null;
        break;
    }
    urls.set(entityKey(row.entityType, row.entityId), url);
  }
  return urls;
}

/**
 * The row's `meta` as readers may see it. Invite codes are working join links, and seeing them
 * needs `MANAGE_INVITES`, not `VIEW_AUDIT_LOG`: rows store only a hint (`inviteCodeHint`), and
 * rows written before that are cut down to one here.
 */
function readableMeta(row: ActivityRow): Record<string, unknown> {
  const { meta } = row;
  const code = row.entityType === 'invite' ? meta.code : undefined;
  const inviteCode = meta.inviteCode;
  if (typeof code !== 'string' && typeof inviteCode !== 'string') return meta;
  return {
    ...meta,
    ...(typeof code === 'string' ? { code: inviteCodeHint(code) } : {}),
    ...(typeof inviteCode === 'string' ? { inviteCode: inviteCodeHint(inviteCode) } : {}),
  };
}

/**
 * The row's via-key snapshot ("Claude via Ethan's laptop"). Rows written before the agent was
 * snapshotted (BAT-10) take the key's current agent from `currentKeys`, when it has one.
 */
function viaOf(row: ActivityRow, currentKeys: ReadonlyMap<string, ViaKey>): ViaKey | null {
  if (!row.viaKeyId || !row.viaKeyName) return null;
  const agentName = row.viaAgentName ?? currentKeys.get(row.viaKeyId)?.agentName ?? null;
  return { keyId: row.viaKeyId, keyName: row.viaKeyName, ...(agentName ? { agentName } : {}) };
}

/** Hydrates activity rows into wire entries (actor summaries, via-key snapshots, URLs). */
export function toActivityEntries(db: DbExecutor, rows: readonly ActivityRow[]): ActivityEntry[] {
  const users = getUserSummaries(
    db,
    rows.map((row) => row.actorId),
  );
  // Only older rows without an agent snapshot need the keys' current agents.
  const currentKeys = getViaKeys(
    db,
    rows.filter((row) => row.viaAgentName === null).map((row) => row.viaKeyId),
  );
  const urls = resolveEntityUrls(db, rows);
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    actor: {
      user: row.actorId ? (users.get(row.actorId) ?? null) : null,
      via: viaOf(row, currentKeys),
      source: row.source,
    },
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    changes: row.changes,
    meta: readableMeta(row),
    url: urls.get(entityKey(row.entityType, row.entityId)) ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/**
 * Most rows returned by an entity history: the newest ones. A long-lived task can pass it (every
 * explicit `renew_claim` writes a row), and then its oldest rows are left out, never its latest.
 */
export const HISTORY_LIMIT = 1000;

/**
 * Entity history (`GET /api/activity`, MCP `get_activity`): the newest `HISTORY_LIMIT` rows,
 * oldest first. Per-item history
 * (issues, tasks, replies, attachments) is visible to every member of the item's team while the
 * item is live, and to those who may see it in Trash (its author or `MANAGE_TRASH`) while it is
 * not. The history of anything else in a team (the team, members, roles, invites, projects,
 * statuses, labels) is part of the team audit log and needs `VIEW_AUDIT_LOG`. Account-level rows
 * (the security log) are visible only to their own user. Non-members and unknown items get 404.
 */
export function listEntityActivity(
  deps: AppDeps,
  actor: Actor,
  query: EntityActivityQuery,
): ActivityListResponse {
  const page = listEntityActivityPage(deps, actor, {
    ...query,
    limit: HISTORY_LIMIT,
    order: 'desc',
  });
  return { items: page.items.reverse() };
}

export interface EntityActivityPageQuery extends EntityActivityQuery {
  limit: number;
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined;
  /** `desc`: newest first; `asc`: oldest first. */
  order: 'asc' | 'desc';
}

/**
 * One page of an entity's history (MCP `get_activity` with an item), keyset-paginated on
 * `[createdAt, id]` in either direction, with the visibility rules of `listEntityActivity`.
 */
export function listEntityActivityPage(
  deps: AppDeps,
  actor: Actor,
  query: EntityActivityPageQuery,
): Paginated<ActivityEntry> {
  const { orm } = deps.db;
  const entity = and(
    eq(s.activity.entityType, query.entityType),
    eq(s.activity.entityId, query.entityId),
  );
  const visible = and(entity, historyScope(orm, actor, query));
  const newestFirst = query.order === 'desc';
  let after: SQL | undefined;
  if (query.cursor) {
    const [createdAtMs, id] = decodeCursor(query.cursor, timeIdCursorSchema);
    const createdAt = new Date(createdAtMs);
    const beyond = newestFirst ? lt : gt;
    after = or(
      beyond(s.activity.createdAt, createdAt),
      and(eq(s.activity.createdAt, createdAt), beyond(s.activity.id, id)),
    );
  }
  const direction = newestFirst ? desc : asc;
  const rows = orm
    .select()
    .from(s.activity)
    .where(and(visible, after))
    .orderBy(direction(s.activity.createdAt), direction(s.activity.id))
    .limit(query.limit + 1)
    .all();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: toActivityEntries(orm, page),
    nextCursor:
      rows.length > query.limit && last ? encodeCursor([last.createdAt.getTime(), last.id]) : null,
  };
}

/**
 * The rows of an entity's history the actor may read (see `listEntityActivity`), as a condition;
 * throws 404/403 when the actor may read none of it.
 */
function historyScope(db: DbExecutor, actor: Actor, query: EntityActivityQuery): SQL | undefined {
  const entity = and(
    eq(s.activity.entityType, query.entityType),
    eq(s.activity.entityId, query.entityId),
  );
  if (query.entityType === 'user' || query.entityType === 'api_key') {
    // Account-level rows (the security log): only the user's own.
    const own = and(isNull(s.activity.teamId), eq(s.activity.actorId, actor.userId));
    const any = db.select({ id: s.activity.id }).from(s.activity).where(entity).limit(1).get();
    const mine = db
      .select({ id: s.activity.id })
      .from(s.activity)
      .where(and(entity, own))
      .limit(1)
      .get();
    if (any && !mine) throw errors.notFound('Item');
    return own;
  }
  const teamId =
    entityTeamId(db, query.entityType, query.entityId) ??
    db
      .select({ teamId: s.activity.teamId })
      .from(s.activity)
      .where(and(entity, isNotNull(s.activity.teamId)))
      .limit(1)
      .get()?.teamId ??
    undefined;
  if (!teamId) throw errors.notFound('Item');
  const membership = requireMember(db, actor, teamId, 'Item');
  requireHistoryAccess(db, membership, query);
  return eq(s.activity.teamId, teamId);
}

/** Throws unless the member may see this team entity's history (see `listEntityActivity`). */
function requireHistoryAccess(
  db: DbExecutor,
  membership: Membership,
  query: EntityActivityQuery,
): void {
  if (hasPermission(membership, 'VIEW_AUDIT_LOG')) return;
  let visible: boolean;
  switch (query.entityType) {
    case 'issue':
    case 'task':
    case 'reply': {
      const trashed =
        query.entityType === 'reply'
          ? trashedReply(db, query.entityId)
          : trashedItem(db, query.entityType, query.entityId);
      visible = !trashed || canRestoreContent(membership, trashed.authorId);
      break;
    }
    case 'attachment':
      visible = canSeeAttachmentHistory(db, membership, query.entityId);
      break;
    default:
      throw errors.forbidden(
        "This history is part of the team audit log, which needs the 'View audit log' permission",
      );
  }
  if (!visible) throw errors.notFound('Item');
}

/**
 * The team an entity belongs to, looked up in its own table (deleted rows included, so trashed
 * items keep their history). Undefined for types without a table row (members) or purged rows.
 */
function entityTeamId(
  db: DbExecutor,
  entityType: ActivityEntityType,
  entityId: string,
): string | undefined {
  const byId = (
    table:
      | typeof s.project
      | typeof s.issue
      | typeof s.task
      | typeof s.reply
      | typeof s.role
      | typeof s.invite,
  ) => db.select({ teamId: table.teamId }).from(table).where(eq(table.id, entityId)).get()?.teamId;
  switch (entityType) {
    case 'team':
      return db.select({ id: s.team.id }).from(s.team).where(eq(s.team.id, entityId)).get()?.id;
    case 'project':
      return byId(s.project);
    case 'issue':
      return byId(s.issue);
    case 'task':
      return byId(s.task);
    case 'reply':
      return byId(s.reply);
    case 'role':
      return byId(s.role);
    case 'invite':
      return byId(s.invite);
    case 'attachment':
      return (
        db
          .select({ teamId: s.attachment.teamId })
          .from(s.attachment)
          .where(eq(s.attachment.id, entityId))
          .get()?.teamId ?? undefined
      );
    case 'status':
    case 'label': {
      const table = entityType === 'status' ? s.status : s.label;
      return db
        .select({ teamId: s.project.teamId })
        .from(table)
        .innerJoin(s.project, eq(s.project.id, table.projectId))
        .where(eq(table.id, entityId))
        .get()?.teamId;
    }
    case 'member':
    case 'user':
    case 'api_key':
      return undefined;
  }
}

function cursorCondition(cursor: string | undefined): SQL | undefined {
  if (!cursor) return undefined;
  const [createdAtMs, id] = decodeCursor(cursor, timeIdCursorSchema);
  const createdAt = new Date(createdAtMs);
  return or(
    lt(s.activity.createdAt, createdAt),
    and(eq(s.activity.createdAt, createdAt), lt(s.activity.id, id)),
  );
}

function page(db: DbExecutor, rows: ActivityRow[], limit: number): Paginated<ActivityEntry> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: toActivityEntries(db, pageRows),
    nextCursor: hasMore && last ? encodeCursor([last.createdAt.getTime(), last.id]) : null,
  };
}

/**
 * Team audit log, newest first with cursor pagination. Needs `VIEW_AUDIT_LOG`. `action` is an
 * exact action or a prefix ending in a dot (`task.`); `from` is inclusive, `to` exclusive.
 */
export function listAuditLog(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  query: AuditLogQuery,
): Paginated<ActivityEntry> {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, teamId);
  requirePermission(
    membership,
    'VIEW_AUDIT_LOG',
    "You don't have permission to view the audit log",
  );

  const action = query.action
    ? query.action.endsWith('.')
      ? likePrefix(s.activity.action, query.action)
      : eq(s.activity.action, query.action)
    : undefined;

  const rows = orm
    .select()
    .from(s.activity)
    .where(
      and(
        eq(s.activity.teamId, teamId),
        query.actorId ? eq(s.activity.actorId, query.actorId) : undefined,
        query.keyId ? eq(s.activity.viaKeyId, query.keyId) : undefined,
        query.source ? eq(s.activity.source, query.source) : undefined,
        query.entityType ? eq(s.activity.entityType, query.entityType) : undefined,
        query.projectId ? eq(s.activity.projectId, query.projectId) : undefined,
        query.from ? gte(s.activity.createdAt, new Date(query.from)) : undefined,
        query.to ? lt(s.activity.createdAt, new Date(query.to)) : undefined,
        action,
        cursorCondition(query.cursor),
      ),
    )
    .orderBy(desc(s.activity.createdAt), desc(s.activity.id))
    .limit(query.limit + 1)
    .all();
  return page(orm, rows, query.limit);
}

/**
 * The per-user security log (sign-ins, password changes, keys, linked accounts): account-level
 * rows the user made, newest first.
 */
export function listSecurityLog(
  deps: AppDeps,
  actor: Actor,
  query: { cursor?: string | undefined; limit: number },
): Paginated<ActivityEntry> {
  const { orm } = deps.db;
  const rows = orm
    .select()
    .from(s.activity)
    .where(
      and(
        isNull(s.activity.teamId),
        eq(s.activity.actorId, actor.userId),
        cursorCondition(query.cursor),
      ),
    )
    .orderBy(desc(s.activity.createdAt), desc(s.activity.id))
    .limit(query.limit + 1)
    .all();
  return page(orm, rows, query.limit);
}
