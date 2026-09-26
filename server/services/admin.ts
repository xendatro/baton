import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ActivityEntityType, ActorSource, TrashableType } from '@shared/constants';
import { parseRef, type ParsedRef } from '@shared/refs';
import type {
  AuditLogFacets,
  RestoreTrashResponse,
  TrashListQuery,
  TrashPage,
} from '@shared/schemas/admin';
import type { TrashItem, TrashItemRef } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor } from '../lib/cursor';
import { errors } from '../lib/errors';
import { appPaths } from '../lib/urls';
import { memberTeamIds, requireMember, requirePermission } from './access';
import { findItem } from './items';
import { listTrash, restoreItem } from './trash';
import { getUserSummaries } from './users';

/**
 * Admin module services: the paginated team Trash (over core `listTrash`/`restoreItem`), resolving
 * refs of deleted items for MCP, and the audit log's filter facets. The audit log itself is
 * core's `listAuditLog`.
 */

// ---------------------------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------------------------

/** Cursor of a trash page: the last item's deletion time and `type:id` (the tiebreaker). */
const trashCursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1)]);

function trashSortKey(item: TrashItem): string {
  return `${item.type}:${item.id}`;
}

/** Newest deletion first; equal times ordered by `type:id` descending, so pages are stable. */
function compareTrash(a: TrashItem, b: TrashItem): number {
  const byTime = Date.parse(b.deletedAt) - Date.parse(a.deletedAt);
  if (byTime !== 0) return byTime;
  const keyA = trashSortKey(a);
  const keyB = trashSortKey(b);
  return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
}

/**
 * A page of a team's Trash, most recently deleted first, optionally one type. Members see what
 * they authored; `MANAGE_TRASH` sees everything (enforced by `listTrash`).
 */
export function listTeamTrash(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  query: TrashListQuery,
  now: Date = new Date(),
): TrashPage {
  const all = listTrash(deps, actor, teamId, now)
    .items.filter((item) => !query.type || item.type === query.type)
    .sort(compareTrash);

  let start = 0;
  if (query.cursor) {
    const [deletedAtMs, key] = decodeCursor(query.cursor, trashCursorSchema);
    start = all.findIndex((item) => {
      const time = Date.parse(item.deletedAt);
      return time < deletedAtMs || (time === deletedAtMs && trashSortKey(item) < key);
    });
    if (start === -1) start = all.length;
  }
  const items = all.slice(start, start + query.limit);
  const last = items.at(-1);
  const hasMore = start + query.limit < all.length;
  return {
    items,
    nextCursor:
      hasMore && last ? encodeCursor([Date.parse(last.deletedAt), trashSortKey(last)]) : null,
  };
}

/**
 * Restores an item through its module's handler (which checks permissions and writes the audit
 * row) and returns where to find it again.
 */
export function restoreTrashItem(
  deps: AppDeps,
  actor: Actor,
  ref: TrashItemRef,
): RestoreTrashResponse {
  restoreItem(deps, actor, ref);
  return { ok: true, type: ref.type, id: ref.id, url: restoredItemPath(deps.db.orm, ref) };
}

/** App path of a live item: projects, issues and tasks open themselves; replies their thread. */
function restoredItemPath(db: DbExecutor, ref: TrashItemRef): string | null {
  switch (ref.type) {
    case 'team': {
      const team = db
        .select({ slug: s.team.slug })
        .from(s.team)
        .where(and(eq(s.team.id, ref.id), isNull(s.team.deletedAt)))
        .get();
      return team ? appPaths.team(team.slug) : null;
    }
    case 'project':
      return projectPath(db, ref.id);
    case 'issue':
    case 'task':
      return findItem(db, ref.type, ref.id)?.path ?? null;
    case 'reply':
      return replyPath(db, ref.id);
    case 'attachment': {
      const attachment = db
        .select({ parentType: s.attachment.parentType, parentId: s.attachment.parentId })
        .from(s.attachment)
        .where(eq(s.attachment.id, ref.id))
        .get();
      if (!attachment?.parentId) return null;
      switch (attachment.parentType) {
        case 'issue':
        case 'task':
          return findItem(db, attachment.parentType, attachment.parentId)?.path ?? null;
        case 'reply':
          return replyPath(db, attachment.parentId);
        case 'project':
          return projectPath(db, attachment.parentId);
        default:
          return null;
      }
    }
  }
}

function projectPath(db: DbExecutor, projectId: string): string | null {
  const project = db
    .select({ key: s.project.key, slug: s.team.slug })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.project.id, projectId), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  return project ? appPaths.project(project.slug, project.key) : null;
}

function replyPath(db: DbExecutor, replyId: string): string | null {
  const reply = db
    .select({ parentType: s.reply.parentType, parentId: s.reply.parentId })
    .from(s.reply)
    .where(and(eq(s.reply.id, replyId), isNull(s.reply.deletedAt)))
    .get();
  const parent = reply ? findItem(db, reply.parentType, reply.parentId) : null;
  return parent ? appPaths.reply(parent.path, replyId) : null;
}

export interface TrashRefInput {
  /** `KEY-12`, `KEY#51`, `KEY` (a project), `team-slug/…`, or an id. */
  item: string;
  /** Needed only when an id is ambiguous across types; checked against the ref's kind. */
  type?: TrashableType | undefined;
}

const TYPE_NAMES: Record<TrashableType, string> = {
  team: 'Team',
  project: 'Project',
  issue: 'Issue',
  task: 'Task',
  reply: 'Reply',
  attachment: 'Attachment',
};

/**
 * Resolves a deleted item for `restore_item`. Unlike the live-item resolvers, refs here match
 * deleted issues, tasks and projects (including items of a deleted project) in the caller's
 * teams; ids match any trashable type (deleted teams only for their owner).
 */
export function resolveTrashRef(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  input: TrashRefInput,
): TrashItemRef {
  const { orm } = deps.db;
  const value = input.item.trim();
  const byId = findTrashableById(orm, actor, value, input.type);
  if (byId) return byId;

  const parsed = parseRef(value);
  if (!parsed) throw errors.notFound(input.type ? `Deleted ${input.type}` : 'Deleted item');
  if (input.type && input.type !== parsed.kind) {
    throw errors.validation(`"${value}" is a ${parsed.kind} ref, not a ${input.type}`);
  }
  const teamIds = teamIdsForRef(orm, actor, parsed);
  const projects = projectsWithKey(orm, teamIds, parsed.projectKey);

  if (parsed.kind === 'project') {
    const deleted = projects.filter((project) => project.deletedAt !== null);
    if (deleted.length === 0) {
      if (projects.length > 0) throw errors.conflict(`Project ${value} is not in Trash`);
      throw errors.notFound('Deleted project');
    }
    return { type: 'project', id: single(deleted, value, (p) => `${p.slug}/${p.key}`).id };
  }

  const table = parsed.kind === 'task' ? s.task : s.issue;
  const projectIds = projects.map((project) => project.id);
  const rows =
    projectIds.length === 0
      ? []
      : orm
          .select({ id: table.id, projectId: table.projectId, deletedAt: table.deletedAt })
          .from(table)
          .where(and(inArray(table.projectId, projectIds), eq(table.number, parsed.number)))
          .all();
  const inTrash = rows.filter((row) => row.deletedAt !== null);
  if (inTrash.length === 0) {
    const what = TYPE_NAMES[parsed.kind];
    const inDeletedProject = rows.find(
      (row) => projects.find((project) => project.id === row.projectId)?.deletedAt,
    );
    if (inDeletedProject) {
      throw errors.conflict(
        `${what} ${value} is in a deleted project. Restore the project ${parsed.projectKey} instead`,
      );
    }
    if (rows.length > 0) throw errors.conflict(`${what} ${value} is not in Trash`);
    throw errors.notFound(`Deleted ${parsed.kind}`);
  }
  const row = single(inTrash, value, (candidate) => {
    const project = projects.find((p) => p.id === candidate.projectId);
    return project ? `${project.slug}/${value.split('/').at(-1) ?? value}` : candidate.id;
  });
  return { type: parsed.kind, id: row.id };
}

function single<T>(candidates: readonly T[], ref: string, describe: (candidate: T) => string): T {
  const [first] = candidates;
  if (first === undefined) throw errors.notFound('Deleted item');
  if (candidates.length > 1) {
    const options = candidates.map(describe);
    throw errors.validation(`"${ref}" is ambiguous. Use one of: ${options.join(', ')}`, {
      candidates: options,
    });
  }
  return first;
}

/** The caller's (live) teams a ref can point into: one team when it names a slug. */
function teamIdsForRef(db: DbExecutor, actor: Actor, parsed: ParsedRef): string[] {
  const teamIds = memberTeamIds(db, actor.userId);
  if (!parsed.teamSlug) return teamIds;
  const team = db
    .select({ id: s.team.id })
    .from(s.team)
    .where(and(eq(s.team.slug, parsed.teamSlug), isNull(s.team.deletedAt)))
    .get();
  return team ? teamIds.filter((id) => id === team.id) : [];
}

interface KeyedProject {
  id: string;
  key: string;
  slug: string;
  deletedAt: Date | null;
}

/** Live and deleted projects in the teams whose key (or a former key) is `key`. */
function projectsWithKey(db: DbExecutor, teamIds: readonly string[], key: string): KeyedProject[] {
  if (teamIds.length === 0) return [];
  const columns = {
    id: s.project.id,
    key: s.project.key,
    slug: s.team.slug,
    deletedAt: s.project.deletedAt,
  };
  const current = db
    .select(columns)
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(inArray(s.project.teamId, [...teamIds]), eq(s.project.key, key)))
    .all();
  const aliased = db
    .select(columns)
    .from(s.projectKeyAlias)
    .innerJoin(s.project, eq(s.project.id, s.projectKeyAlias.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(inArray(s.projectKeyAlias.teamId, [...teamIds]), eq(s.projectKeyAlias.key, key)))
    .all();
  const seen = new Set<string>();
  return [...current, ...aliased].filter((project) =>
    seen.has(project.id) ? false : (seen.add(project.id), true),
  );
}

/** A deleted item with this id in one of the caller's teams (or a deleted team they own). */
function findTrashableById(
  db: DbExecutor,
  actor: Actor,
  id: string,
  type: TrashableType | undefined,
): TrashItemRef | null {
  const wanted = (candidate: TrashableType) => type === undefined || type === candidate;
  if (wanted('team')) {
    const team = db
      .select({ id: s.team.id })
      .from(s.team)
      .where(and(eq(s.team.id, id), eq(s.team.ownerId, actor.userId), isNotNull(s.team.deletedAt)))
      .get();
    if (team) return { type: 'team', id };
  }
  const teamIds = memberTeamIds(db, actor.userId);
  if (teamIds.length === 0) return null;
  const tables = [
    ['project', s.project],
    ['issue', s.issue],
    ['task', s.task],
    ['reply', s.reply],
    ['attachment', s.attachment],
  ] as const;
  for (const [candidate, table] of tables) {
    if (!wanted(candidate)) continue;
    const row = db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), inArray(table.teamId, teamIds), isNotNull(table.deletedAt)))
      .get();
    if (row) return { type: candidate, id };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Audit log facets
// ---------------------------------------------------------------------------------------------

/**
 * The values present in a team's audit log — actors, sources, API keys, entity types, actions
 * and projects — for its filter menus. Needs `VIEW_AUDIT_LOG`, like the log itself.
 */
export function getAuditLogFacets(deps: AppDeps, actor: Actor, teamId: string): AuditLogFacets {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, teamId);
  requirePermission(
    membership,
    'VIEW_AUDIT_LOG',
    "You don't have permission to view the audit log",
  );
  // Read from the facet rows `recordActivity` keeps, never from the (unbounded) log itself.
  const facetRows = orm
    .select()
    .from(s.activityFacet)
    .where(eq(s.activityFacet.teamId, teamId))
    .all();
  const valuesOf = (kind: s.ActivityFacetKind) =>
    facetRows.filter((row) => row.kind === kind).map((row) => row.value);

  const actorIds = valuesOf('actor');
  const sources = valuesOf('source');
  const keyRows = facetRows
    .filter((row) => row.kind === 'key')
    .map((row) => ({
      keyId: row.value,
      keyName: row.keyName,
      actorId: row.actorId,
      lastUsed: row.lastAt?.getTime() ?? 0,
    }))
    .sort((a, b) => b.lastUsed - a.lastUsed);
  const entityTypes = valuesOf('entity_type');
  const actions = valuesOf('action').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const projectIds = valuesOf('project');
  const projects =
    projectIds.length === 0
      ? []
      : orm
          .select({
            id: s.project.id,
            key: s.project.key,
            name: s.project.name,
            deletedAt: s.project.deletedAt,
          })
          .from(s.project)
          .where(and(eq(s.project.teamId, teamId), inArray(s.project.id, projectIds)))
          .orderBy(asc(s.project.name))
          .all();

  const users = getUserSummaries(orm, [...actorIds, ...keyRows.map((row) => row.actorId)]);
  const byName = new Intl.Collator('en', { sensitivity: 'base' });
  return {
    actors: actorIds
      .flatMap((id) => {
        const user = id ? users.get(id) : undefined;
        return user ? [user] : [];
      })
      .sort((a, b) => byName.compare(a.name, b.name)),
    sources: SOURCE_ORDER.filter((source) => sources.includes(source)),
    keys: keyRows.flatMap((row) =>
      row.keyId
        ? [
            {
              keyId: row.keyId,
              keyName: row.keyName ?? 'API key',
              user: row.actorId ? (users.get(row.actorId) ?? null) : null,
            },
          ]
        : [],
    ),
    entityTypes: ENTITY_ORDER.filter((type) => entityTypes.includes(type)),
    actions,
    projects: projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
      deleted: project.deletedAt !== null,
    })),
  };
}

const SOURCE_ORDER: readonly ActorSource[] = ['web', 'mcp', 'api', 'system'];

const ENTITY_ORDER: readonly ActivityEntityType[] = [
  'task',
  'issue',
  'reply',
  'attachment',
  'project',
  'status',
  'label',
  'team',
  'member',
  'role',
  'invite',
  'user',
  'api_key',
];

/**
 * An API key in a team's audit log, by id or by its (last recorded) name, case-insensitively.
 * Used by MCP `get_activity`, whose callers know key names rather than ids.
 */
export function resolveAuditLogKey(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  ref: string,
): string {
  const value = ref.trim();
  const { keys } = getAuditLogFacets(deps, actor, teamId);
  const byId = keys.find((key) => key.keyId === value);
  if (byId) return byId.keyId;
  const lower = value.toLowerCase();
  const byName = keys.filter((key) => key.keyName.toLowerCase() === lower);
  if (byName.length === 0) throw errors.notFound('API key');
  return single(byName, value, (key) => `${key.keyId} (${key.user?.username ?? 'deleted user'})`)
    .keyId;
}
