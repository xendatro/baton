import { sql } from 'drizzle-orm';
import type { SearchEntityType } from '@shared/constants';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type { SearchQuery, SearchResponse, SearchResult } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { Tx } from '../db';
import { markdownToPlainText } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import { memberTeamIds } from './access';

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
  /** Markdown body; indexed as plain text. */
  body: string;
}

/** Adds or replaces the document of an entity. */
export function indexSearch(tx: Tx, doc: SearchDocument): void {
  removeFromSearch(tx, doc.entityType, [doc.entityId]);
  tx.run(sql`insert into search_index (entity_type, entity_id, team_id, project_id, title, body)
    values (${doc.entityType}, ${doc.entityId}, ${doc.teamId}, ${doc.projectId}, ${doc.title},
      ${markdownToPlainText(doc.body)})`);
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

/**
 * `GET /api/search`: matches in the caller's teams (optionally one team/project/types), best
 * first. Deleted items, replies of deleted items and anything in deleted projects or teams are
 * excluded.
 */
export function search(deps: AppDeps, actor: Actor, query: SearchQuery): SearchResponse {
  const match = buildFtsQuery(query.q);
  if (!match) return { results: [] };
  let teamIds = memberTeamIds(deps.db.orm, actor.userId);
  if (query.teamId) teamIds = teamIds.filter((id) => id === query.teamId);
  if (teamIds.length === 0 || query.types.length === 0) return { results: [] };

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
      and search_index.entity_type in (${placeholders(query.types)})
      ${query.projectId ? 'and search_index.project_id = ?' : ''}
      and coalesce(tk.id, i.id, rt.id, ri.id) is not null
    order by bm25(search_index, 0, 0, 0, 0, 8.0, 1.0)
    limit ?
  `);
  const rows = statement.all(
    match,
    ...teamIds,
    ...query.types,
    ...(query.projectId ? [query.projectId] : []),
    query.limit,
  );

  return {
    results: rows.map((row): SearchResult => {
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
    }),
  };
}
