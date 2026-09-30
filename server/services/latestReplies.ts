import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ReplyParentType } from '@shared/constants';
import type { LatestReply } from '@shared/schemas/core';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { excerpt } from '../lib/markdown';
import { getUserSummaries } from './users';

const LATEST_EXCERPT_LENGTH = 120;

/**
 * The newest live reply of each item (BAT-44: the issue and task rails), keyed by item id. One
 * query for the whole page; items without replies are missing from the map.
 */
export function latestRepliesByItem(
  db: DbExecutor,
  parentType: ReplyParentType,
  ids: readonly string[],
): Map<string, LatestReply> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({
      id: s.reply.id,
      parentId: s.reply.parentId,
      authorId: s.reply.authorId,
      body: s.reply.body,
      createdAt: s.reply.createdAt,
    })
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, parentType),
        inArray(s.reply.parentId, [...ids]),
        isNull(s.reply.deletedAt),
        sql`${s.reply.createdAt} = (select max(latest.created_at) from ${s.reply} as latest
          where latest.parent_type = ${s.reply.parentType}
            and latest.parent_id = ${s.reply.parentId}
            and latest.deleted_at is null)`,
      ),
    )
    .all();
  const authors = getUserSummaries(
    db,
    rows.map((row) => row.authorId),
  );
  const latest = new Map<string, LatestReply>();
  for (const row of rows) {
    const current = latest.get(row.parentId);
    // Two replies in the same millisecond: the larger (later) ULID wins.
    if (current && current.id > row.id) continue;
    latest.set(row.parentId, {
      id: row.id,
      author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
      excerpt: excerpt(row.body, LATEST_EXCERPT_LENGTH),
      createdAt: row.createdAt.toISOString(),
    });
  }
  return latest;
}
