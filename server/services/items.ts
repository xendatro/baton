import { and, eq, isNull, sql } from 'drizzle-orm';
import type { ReplyParentType } from '@shared/constants';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type { Actor } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { appPaths } from '../lib/urls';
import { requireMember, type Membership } from './access';

/**
 * Issues and tasks as generic "items": the things replies, subscriptions and attachments hang
 * off. A registry of resolvers (one per item type) keeps the reply, subscription and attachment
 * services independent of the issue and task services.
 */

export type ItemType = ReplyParentType;

export interface ItemInfo {
  type: ItemType;
  id: string;
  teamId: string;
  teamSlug: string;
  projectId: string;
  projectKey: string;
  number: number;
  title: string;
  /** Markdown body (issue body, task description). */
  body: string;
  authorId: string | null;
  /** `KEY-12` or `KEY#51`. */
  ref: string;
  /** Relative web-app URL. */
  path: string;
}

export interface ItemResolver {
  /** The item, if it exists and neither it nor its project or team is deleted. */
  find(db: DbExecutor, id: string): ItemInfo | null;
  /** Adjusts the reply count by `delta`; a new reply (`bumpActivity`) also moves lastActivityAt. */
  adjustReplies(tx: Tx, id: string, delta: number, bumpActivity: boolean): void;
}

function makeResolver(type: ItemType): ItemResolver {
  const table = type === 'issue' ? s.issue : s.task;
  const bodyColumn = type === 'issue' ? s.issue.body : s.task.description;
  const formatRef = type === 'issue' ? formatIssueRef : formatTaskRef;
  return {
    find(db, id) {
      const row = db
        .select({
          id: table.id,
          teamId: table.teamId,
          projectId: table.projectId,
          number: table.number,
          title: table.title,
          body: bodyColumn,
          authorId: table.authorId,
          projectKey: s.project.key,
          teamSlug: s.team.slug,
        })
        .from(table)
        .innerJoin(s.project, eq(s.project.id, table.projectId))
        .innerJoin(s.team, eq(s.team.id, table.teamId))
        .where(
          and(
            eq(table.id, id),
            isNull(table.deletedAt),
            isNull(s.project.deletedAt),
            isNull(s.team.deletedAt),
          ),
        )
        .get();
      if (!row) return null;
      return {
        type,
        ...row,
        ref: formatRef(row.projectKey, row.number),
        path: appPaths[type](row.teamSlug, row.projectKey, row.number),
      };
    },
    adjustReplies(tx, id, delta, bumpActivity) {
      tx.update(table)
        .set({
          replyCount: sql`max(0, ${table.replyCount} + ${delta})`,
          ...(bumpActivity ? { lastActivityAt: new Date() } : {}),
          // Reply counters are not an edit of the item itself.
          updatedAt: sql`${table.updatedAt}`,
        })
        .where(eq(table.id, id))
        .run();
    },
  };
}

/** Item resolvers by type. */
export const itemResolvers: Readonly<Record<ItemType, ItemResolver>> = {
  issue: makeResolver('issue'),
  task: makeResolver('task'),
};

export function findItem(db: DbExecutor, type: ItemType, id: string): ItemInfo | null {
  return itemResolvers[type].find(db, id);
}

const ITEM_NAMES: Record<ItemType, string> = { issue: 'Issue', task: 'Task' };

/**
 * The item and the actor's membership in its team. Missing, deleted and other teams' items are
 * all `not_found`.
 */
export function requireItem(
  db: DbExecutor,
  actor: Actor,
  type: ItemType,
  id: string,
): { item: ItemInfo; membership: Membership } {
  const item = findItem(db, type, id);
  if (!item) throw errors.notFound(ITEM_NAMES[type]);
  const membership = requireMember(db, actor, item.teamId, ITEM_NAMES[type]);
  return { item, membership };
}
