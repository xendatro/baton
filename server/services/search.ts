import { sql } from 'drizzle-orm';
import type { SearchEntityType } from '@shared/constants';
import { formatIssueRef, formatTaskRef, parseRef } from '@shared/refs';
import type { SearchQuery, SearchResponse, SearchResult } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { Tx } from '../db';
import { excerpt } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import { memberTeamIds, visibleProjectIds } from './access';

/**
 * Full-text search over tasks, issues and replies (SQLite FTS5, SPEC §1.9). The index is
 * maintained by the services in the same transaction as the change: call `indexSearch` after
 * creating or editing an item and `removeFromSearch` when purging it. Soft-deleted items stay in
 * the index (so a restore needs no reindex) and are filtered out at query time.
 */

export interface SearchDocument {
  entityType: SearchEntityType;
  entityId: string;
  teamId: string;
  projectId: string;
  /** Item title; empty for replies (results show the parent's title). */
  title: string;
  /**
   * Plain-text body: `markdownToPlainText(markdown)`, computed before the transaction so no
   * text processing runs while the write lock is held.
   */
  text: string;
}

/** Adds or replaces the document of an entity. */
export function indexSearch(tx: Tx, doc: SearchDocument): void {
  removeFromSearch(tx, doc.entityType, [doc.entityId]);
  tx.run(sql`insert into search_index (entity_type, entity_id, team_id, project_id, title, body)
    values (${doc.entityType}, ${doc.entityId}, ${doc.teamId}, ${doc.projectId}, ${doc.title},
      ${doc.text})`);
}

/** Removes entities from the index (on purge). */
export function removeFromSearch(
  tx: Tx,
  entityType: SearchEntityType,
  entityIds: readonly string[],
): void {
  if (entityIds.length === 0) return;
  tx.run(sql`delete from search_index where entity_type = ${entityType}
    and entity_id in (${sql.join(
      entityIds.map((id) => sql`${id}`),
      sql`, `,
    )})`);
}

const MAX_TERMS = 12;

/**
 * Turns free text into a safe FTS5 query: words are extracted (letters and digits in any script),
 * each is quoted (so FTS syntax such as `AND`, `NEAR`, `*`, `"` or `:` in user input is inert) and
 * prefix-matched, and all must match. Returns null when the input has no searchable words.
 */
export function buildFtsQuery(input: string): string | null {
  const terms = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(terms)].slice(0, MAX_TERMS);
  if (unique.length === 0) return null;
  return unique.map((term) => `"${term}"*`).join(' ');
}

interface SearchRow {
  entity_type: SearchEntityType;
  entity_id: string;
  team_id: string;
  project_id: string;
  snippet: string;
  team_slug: string;
  project_key: string;
  item_type: 'issue' | 'task';
  item_number: number;
  item_title: string;
}

/** A search query that names tasks or issues by number (`WEB-14`, `WEB#7`, `acme/WEB-14`, `14`). */
export interface RefQuery {
  kinds: ('task' | 'issue')[];
  teamSlug: string | null;
  /** Null for a bare number, which matches that number in every project. */
  projectKey: string | null;
  number: number;
}

const MAX_ITEM_NUMBER = 999_999_999;

/**
 * Reads a query as a task or issue ref: `KEY-12` (task), `KEY#12` (issue), either with a
 * `team-slug/` prefix, `KEY 12` (both), `#12` (issues) and `12` (both). Null for anything else.
 */
export function parseRefQuery(input: string): RefQuery | null {
  const value = input.trim();
  const bare = /^(#)?(\d{1,9})$/.exec(value);
  if (bare) {
    const number = Number(bare[2]);
    if (number < 1 || number > MAX_ITEM_NUMBER) return null;
    return {
      kinds: bare[1] ? ['issue'] : ['task', 'issue'],
      teamSlug: null,
      projectKey: null,
      number,
    };
  }
  // `KEY 12` / `KEY #12`: people type the key and number apart too.
  const spaced = /^((?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9]{1,5})\s+(#)?(\d{1,9})$/i.exec(
    value,
  );
  const ref = parseRef(spaced ? `${spaced[1]}${spaced[2] ?? '-'}${spaced[3]}` : value);
  if (!ref || ref.kind === 'project') return null;
  return {
    kinds: spaced && !spaced[2] ? ['task', 'issue'] : [ref.kind],
    teamSlug: ref.teamSlug,
    projectKey: ref.projectKey,
    number: ref.number,
  };
}

interface RefRow {
  id: string;
  team_id: string;
  project_id: string;
  number: number;
  title: string;
  text: string;
  team_slug: string;
  project_key: string;
}

/**
 * The live tasks and issues a ref query names, in the given (visible) projects: the project key
 * may be the current key or an old one (`project_key_alias`), as everywhere refs are accepted.
 */
function refMatches(
  deps: AppDeps,
  ref: RefQuery,
  projectIds: readonly string[],
  query: SearchQuery,
): SearchResult[] {
  const results: SearchResult[] = [];
  for (const kind of ref.kinds) {
    if (!query.types.includes(kind)) continue;
    const table = kind === 'task' ? 'task' : 'issue';
    const text = kind === 'task' ? 'item.description' : 'item.body';
    const params: unknown[] = [ref.number, ...projectIds];
    let where = '';
    if (ref.projectKey) {
      where += ` and (p.key = ? or exists (select 1 from project_key_alias a
        where a.project_id = p.id and a.team_id = p.team_id and a.key = ?))`;
      params.push(ref.projectKey, ref.projectKey);
    }
    if (ref.teamSlug) {
      where += ' and t.slug = ?';
      params.push(ref.teamSlug);
    }
    if (query.projectId) {
      where += ' and item.project_id = ?';
      params.push(query.projectId);
    }
    const rows = deps.db.sqlite
      .prepare<unknown[], RefRow>(
        `select item.id as id, item.team_id as team_id, item.project_id as project_id,
          item.number as number, item.title as title, ${text} as text,
          t.slug as team_slug, p.key as project_key
        from ${table} item
        join project p on p.id = item.project_id and p.deleted_at is null
        join team t on t.id = item.team_id and t.deleted_at is null
        where item.deleted_at is null and item.number = ?
          and item.project_id in (${projectIds.map(() => '?').join(', ')})${where}
        order by t.slug, p.key
        limit ?`,
      )
      .all(...params, query.limit);
    for (const row of rows) {
      results.push({
        entityType: kind,
        entityId: row.id,
        teamId: row.team_id,
        projectId: row.project_id,
        ref:
          kind === 'task'
            ? formatTaskRef(row.project_key, row.number)
            : formatIssueRef(row.project_key, row.number),
        title: row.title,
        snippet: excerpt(row.text, 160),
        url: appPaths[kind](row.team_slug, row.project_key, row.number),
      });
    }
  }
  return results;
}

/**
 * `GET /api/search`: matches in the caller's teams (optionally one team/project/types), best
 * first. A query that is a task or issue ref (`WEB-14`, `WEB#7`, `acme/WEB-14`, `WEB 14`, `14`)
 * puts the items it names first, then the full-text matches. Deleted items, replies of deleted
 * items and anything in deleted projects or teams are excluded.
 */
export function search(deps: AppDeps, actor: Actor, query: SearchQuery): SearchResponse {
  const match = buildFtsQuery(query.q);
  if (!match) return { results: [] };
  let teamIds = memberTeamIds(deps.db.orm, actor.userId);
  if (query.teamId) teamIds = teamIds.filter((id) => id === query.teamId);
  if (teamIds.length === 0 || query.types.length === 0) return { results: [] };
  // Projects the caller can't see (`VIEW_PROJECT`) are left out entirely (design §3).
  const projectIds = visibleProjectIds(deps.db.orm, actor.userId, teamIds);
  if (projectIds.length === 0) return { results: [] };

  const refQuery = parseRefQuery(query.q);
  const exact = refQuery ? refMatches(deps, refQuery, projectIds, query) : [];
  const found = new Set(exact.map((result) => `${result.entityType}:${result.entityId}`));

  const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');
  const statement = deps.db.sqlite.prepare<unknown[], SearchRow>(`
    select
      search_index.entity_type as entity_type,
      search_index.entity_id as entity_id,
      search_index.team_id as team_id,
      search_index.project_id as project_id,
      snippet(search_index, -1, '', '', '…', 16) as snippet,
      t.slug as team_slug,
      p.key as project_key,
      coalesce(r.parent_type, search_index.entity_type) as item_type,
      coalesce(tk.number, i.number, rt.number, ri.number) as item_number,
      coalesce(tk.title, i.title, rt.title, ri.title) as item_title
    from search_index
    join team t on t.id = search_index.team_id and t.deleted_at is null
    join project p on p.id = search_index.project_id and p.deleted_at is null
    left join task tk on search_index.entity_type = 'task' and tk.id = search_index.entity_id
      and tk.deleted_at is null
    left join issue i on search_index.entity_type = 'issue' and i.id = search_index.entity_id
      and i.deleted_at is null
    left join reply r on search_index.entity_type = 'reply' and r.id = search_index.entity_id
      and r.deleted_at is null
    left join task rt on r.parent_type = 'task' and rt.id = r.parent_id and rt.deleted_at is null
    left join issue ri on r.parent_type = 'issue' and ri.id = r.parent_id and ri.deleted_at is null
    where search_index match ?
      and search_index.team_id in (${placeholders(teamIds)})
      and search_index.project_id in (${placeholders(projectIds)})
      and search_index.entity_type in (${placeholders(query.types)})
      ${query.projectId ? 'and search_index.project_id = ?' : ''}
      and coalesce(tk.id, i.id, rt.id, ri.id) is not null
    order by bm25(search_index, 0, 0, 0, 0, 8.0, 1.0)
    limit ?
  `);
  const rows = statement.all(
    match,
    ...teamIds,
    ...projectIds,
    ...query.types,
    ...(query.projectId ? [query.projectId] : []),
    query.limit,
  );

  const fullText = rows
    .filter((row) => !found.has(`${row.entity_type}:${row.entity_id}`))
    .map((row): SearchResult => {
      const itemPath = appPaths[row.item_type](row.team_slug, row.project_key, row.item_number);
      return {
        entityType: row.entity_type,
        entityId: row.entity_id,
        teamId: row.team_id,
        projectId: row.project_id,
        ref:
          row.item_type === 'task'
            ? formatTaskRef(row.project_key, row.item_number)
            : formatIssueRef(row.project_key, row.item_number),
        title: row.item_title,
        snippet: row.snippet.replace(/\s+/g, ' ').trim(),
        url: row.entity_type === 'reply' ? appPaths.reply(itemPath, row.entity_id) : itemPath,
      };
    });
  return { results: [...exact, ...fullText].slice(0, query.limit) };
}
