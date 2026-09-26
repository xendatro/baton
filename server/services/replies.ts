import { and, asc, eq, isNull } from 'drizzle-orm';
import type {
  CreateReplyInput,
  ListRepliesQuery,
  Reply,
  ReplyListResponse,
  UpdateReplyInput,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { change } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt, markdownToPlainText } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import {
  canRestoreContent,
  requireCanDeleteContent,
  requireCanEditContent,
  requireMember,
  requirePermission,
} from './access';
import { recordActivity } from './activity';
import { attachmentsByParent, attachToParent, referencedPendingUploads } from './attachments';
import { emitAfterCommit } from './events';
import { findItem, itemResolvers, requireItem, type ItemInfo } from './items';
import {
  notifyMentions,
  notifyReply,
  refreshNotificationText,
  type NotificationTarget,
} from './notifications';
import { indexSearch } from './search';
import { autoSubscribe } from './subscriptions';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Replies on issues and tasks (SPEC §1.7, §1.8). Generic over the parent type through the item
 * resolvers in ./items.
 */

export type ReplyRow = typeof s.reply.$inferSelect;

export function toReplies(db: DbExecutor, rows: readonly ReplyRow[]): Reply[] {
  const authors = getUserSummaries(
    db,
    rows.map((row) => row.authorId),
  );
  const keys = getViaKeys(
    db,
    rows.map((row) => row.viaKeyId),
  );
  const attachments = attachmentsByParent(
    db,
    'reply',
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    parentType: row.parentType,
    parentId: row.parentId,
    body: row.body,
    author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
    via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
    attachments: attachments.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  }));
}

function toReply(db: DbExecutor, row: ReplyRow): Reply {
  const [reply] = toReplies(db, [row]);
  if (!reply) throw errors.internal();
  return reply;
}

/** A reply with its parent item, as MCP tools return it (`ref` and absolute `url`). */
export interface ReplyWithContext extends Reply {
  /** Ref of the parent item, e.g. `API-12`. */
  ref: string;
  url: string;
}

function withContext(deps: AppDeps, reply: Reply, item: ItemInfo): ReplyWithContext {
  return {
    ...reply,
    ref: item.ref,
    url: `${deps.env.baseUrl}${appPaths.reply(item.path, reply.id)}`,
  };
}

/** Thread of an issue or task, oldest first (deleted replies excluded). */
export function listReplies(
  deps: AppDeps,
  actor: Actor,
  query: ListRepliesQuery,
): ReplyListResponse {
  const { orm } = deps.db;
  requireItem(orm, actor, query.parentType, query.parentId);
  const rows = orm
    .select()
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, query.parentType),
        eq(s.reply.parentId, query.parentId),
        isNull(s.reply.deletedAt),
      ),
    )
    .orderBy(asc(s.reply.createdAt), asc(s.reply.id))
    .all();
  return { items: toReplies(orm, rows) };
}

/** A live reply the actor can see, with its parent item and the actor's membership. */
function requireReply(deps: AppDeps, actor: Actor, id: string) {
  const { orm } = deps.db;
  const row = orm
    .select()
    .from(s.reply)
    .where(and(eq(s.reply.id, id), isNull(s.reply.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Reply');
  const membership = requireMember(orm, actor, row.teamId, 'Reply');
  const item = findItem(orm, row.parentType, row.parentId);
  if (!item) throw errors.notFound('Reply');
  return { row, item, membership };
}

export function getReply(deps: AppDeps, actor: Actor, id: string): ReplyWithContext {
  const { row, item } = requireReply(deps, actor, id);
  return withContext(deps, toReply(deps.db.orm, row), item);
}

function notificationTarget(item: ItemInfo, replyId: string, body: string): NotificationTarget {
  return {
    teamId: item.teamId,
    entityType: 'reply',
    entityId: replyId,
    title: `${item.ref}: ${item.title}`,
    snippet: body,
    url: appPaths.reply(item.path, replyId),
  };
}

const EXCERPT_LENGTH = 140;

/**
 * Text derived from a reply body (search text, activity excerpt). Computed before `db.write`, so
 * no text processing runs while the write lock is held.
 */
function derivedText(body: string) {
  return { plain: markdownToPlainText(body), excerpt: excerpt(body, EXCERPT_LENGTH) };
}

function activityMeta(item: ItemInfo, bodyExcerpt: string) {
  return {
    parentType: item.type,
    parentId: item.id,
    parentRef: item.ref,
    parentTitle: item.title,
    excerpt: bodyExcerpt,
  };
}

/**
 * Posts a reply (`REPLY` permission): bumps the parent's reply count and last activity, claims
 * pending attachments, subscribes the author, indexes it for search and notifies mentioned
 * members and the parent's subscribers (one notification per person).
 */
export function createReply(
  deps: AppDeps,
  actor: Actor,
  input: CreateReplyInput,
): ReplyWithContext {
  const { orm } = deps.db;
  const { item, membership } = requireItem(orm, actor, input.parentType, input.parentId);
  requirePermission(membership, 'REPLY', "You don't have permission to reply here");
  const text = derivedText(input.body);

  const row = deps.db.write((tx) => {
    const now = new Date();
    const reply = tx
      .insert(s.reply)
      .values({
        id: newId(),
        teamId: item.teamId,
        projectId: item.projectId,
        parentType: item.type,
        parentId: item.id,
        authorId: actor.userId,
        viaKeyId: actor.key?.id ?? null,
        body: input.body,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    itemResolvers[item.type].adjustReplies(tx, item.id, 1, true);
    itemResolvers[item.type].onThreadWrite?.(tx, actor, item.id);
    // Explicit files plus the images pasted into the body (uploaded as pending while typing).
    attachToParent(
      tx,
      actor,
      [
        ...(input.attachmentIds ?? []),
        ...referencedPendingUploads(tx, actor, item.teamId, input.body),
      ],
      { type: 'reply', id: reply.id, teamId: item.teamId, projectId: item.projectId },
    );
    autoSubscribe(tx, [actor.userId], item.type, item.id);
    recordActivity(tx, actor, {
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: reply.id,
      action: 'reply.created',
      meta: activityMeta(item, text.excerpt),
    });
    indexSearch(tx, {
      entityType: 'reply',
      entityId: reply.id,
      teamId: item.teamId,
      projectId: item.projectId,
      title: '',
      text: text.plain,
    });
    const target = notificationTarget(item, reply.id, reply.body);
    const notified = new Set<string>();
    notifyMentions(tx, actor, target, reply.body, { notified });
    notifyReply(tx, actor, { type: item.type, id: item.id }, target, notified);
    emitAfterCommit(tx, {
      type: 'reply.created',
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: reply.id,
      parentType: item.type,
      parentId: item.id,
      actorId: actor.userId,
    });
    return reply;
  });
  return withContext(deps, toReply(orm, row), item);
}

/** Edits a reply (author, or `EDIT_ANY_CONTENT`). Newly added mentions notify. */
export function editReply(
  deps: AppDeps,
  actor: Actor,
  id: string,
  input: UpdateReplyInput,
): ReplyWithContext {
  const { orm } = deps.db;
  const { row, item, membership } = requireReply(deps, actor, id);
  requireCanEditContent(membership, row.authorId);
  if (row.body === input.body) return withContext(deps, toReply(orm, row), item);
  const previousExcerpt = excerpt(row.body, EXCERPT_LENGTH);
  const text = derivedText(input.body);

  const updated = deps.db.write((tx) => {
    const now = new Date();
    const next = tx
      .update(s.reply)
      .set({ body: input.body, editedAt: now, updatedAt: now })
      .where(eq(s.reply.id, id))
      .returning()
      .get();
    itemResolvers[item.type].onThreadWrite?.(tx, actor, item.id);
    attachToParent(tx, actor, referencedPendingUploads(tx, actor, item.teamId, input.body), {
      type: 'reply',
      id,
      teamId: item.teamId,
      projectId: item.projectId,
    });
    recordActivity(tx, actor, {
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      action: 'reply.edited',
      changes: { body: change(previousExcerpt, text.excerpt) },
      meta: activityMeta(item, text.excerpt),
    });
    indexSearch(tx, {
      entityType: 'reply',
      entityId: id,
      teamId: item.teamId,
      projectId: item.projectId,
      title: '',
      text: text.plain,
    });
    const target = notificationTarget(item, id, next.body);
    refreshNotificationText(tx, target);
    notifyMentions(tx, actor, target, next.body, { previousBody: row.body });
    emitAfterCommit(tx, {
      type: 'reply.updated',
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      parentType: item.type,
      parentId: item.id,
      actorId: actor.userId,
    });
    return next;
  });
  return withContext(deps, toReply(orm, updated), item);
}

/** Moves a reply to Trash (author, or `DELETE_ANY_CONTENT`). */
export function deleteReply(deps: AppDeps, actor: Actor, id: string): { ok: true } {
  const { row, item, membership } = requireReply(deps, actor, id);
  requireCanDeleteContent(membership, row.authorId);
  const bodyExcerpt = excerpt(row.body, EXCERPT_LENGTH);
  deps.db.write((tx) => {
    tx.update(s.reply)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.reply.id, id))
      .run();
    itemResolvers[item.type].adjustReplies(tx, item.id, -1, false);
    recordActivity(tx, actor, {
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      action: 'reply.deleted',
      meta: activityMeta(item, bodyExcerpt),
    });
    emitAfterCommit(tx, {
      type: 'reply.deleted',
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      parentType: item.type,
      parentId: item.id,
      actorId: actor.userId,
    });
  });
  return { ok: true };
}

/** Restores a reply from Trash (author, or `MANAGE_TRASH`); its issue or task must be live. */
export function restoreReply(deps: AppDeps, actor: Actor, id: string): void {
  const { orm } = deps.db;
  const row = orm.select().from(s.reply).where(eq(s.reply.id, id)).get();
  if (!row?.deletedAt) throw errors.notFound('Deleted reply');
  const membership = requireMember(orm, actor, row.teamId, 'Deleted reply');
  if (!canRestoreContent(membership, row.authorId)) {
    throw errors.forbidden('You can only restore your own replies');
  }
  const item = findItem(orm, row.parentType, row.parentId);
  if (!item) {
    throw errors.conflict(`Restore the ${row.parentType} this reply belongs to first`);
  }
  const bodyExcerpt = excerpt(row.body, EXCERPT_LENGTH);
  deps.db.write((tx) => {
    tx.update(s.reply)
      .set({ deletedAt: null, deletedById: null, deletedViaKeyId: null })
      .where(eq(s.reply.id, id))
      .run();
    itemResolvers[item.type].adjustReplies(tx, item.id, 1, false);
    recordActivity(tx, actor, {
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      action: 'reply.restored',
      meta: activityMeta(item, bodyExcerpt),
    });
    // The reply reappears in its thread.
    emitAfterCommit(tx, {
      type: 'reply.created',
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: 'reply',
      entityId: id,
      parentType: item.type,
      parentId: item.id,
      actorId: actor.userId,
    });
  });
}
