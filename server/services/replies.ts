import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import {
  REPLY_TREE,
  type CreateReplyInput,
  type ListRepliesQuery,
  type Reply,
  type ReplyListResponse,
  type ReplyNode,
  type UpdateReplyInput,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { decodeCursor, encodeCursor, timeIdCursorSchema } from '../lib/cursor';
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
import { recordAgentMentions } from './agentMentions';
import { attachmentsByParent, attachToParent, referencedPendingUploads } from './attachments';
import { emitAfterCommit } from './events';
import { findItem, itemResolvers, requireItem, type ItemInfo } from './items';
import {
  notifyMentions,
  notifyReply,
  notifyUsers,
  refreshNotificationText,
  type NotificationTarget,
} from './notifications';
import { reactionsByTarget } from './reactions';
import { ReplyTree } from './replyTree';
import { indexSearch } from './search';
import { autoSubscribe } from './subscriptions';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Replies on issues and tasks (SPEC §1.7, §1.8). Generic over the parent type through the item
 * resolvers in ./items.
 */

export type ReplyRow = typeof s.reply.$inferSelect;

/** Replies as `viewerId` sees them (`reactedByMe`). */
export function toReplies(db: DbExecutor, rows: readonly ReplyRow[], viewerId: string): Reply[] {
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
  const reactions = reactionsByTarget(
    db,
    'reply',
    rows.map((row) => row.id),
    viewerId,
  );
  return rows.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    parentType: row.parentType,
    parentId: row.parentId,
    parentReplyId: row.parentReplyId,
    body: row.body,
    author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
    via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null,
    attachments: attachments.get(row.id) ?? [],
    reactions: reactions.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  }));
}

function toReply(db: DbExecutor, row: ReplyRow, viewerId: string): Reply {
  const [reply] = toReplies(db, [row], viewerId);
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

/**
 * The comment tree of an issue or task (BAT-13), Reddit style: the oldest 200 comments (`limit`)
 * within 10 levels, parents before their answers and siblings oldest first. `root` shows one reply
 * and its answers ("Continue this thread"), `expand` adds the answers of those replies ("N more
 * replies") and `include` replies with their ancestors (a `#reply-<id>` link, the viewer's new
 * replies). A deleted reply that
 * still has answers stays as a `deleted` placeholder without its text or author.
 */
export function listReplies(
  deps: AppDeps,
  actor: Actor,
  query: ListRepliesQuery,
): ReplyListResponse {
  const { orm } = deps.db;
  const { item } = requireItem(orm, actor, query.parentType, query.parentId);
  const skeleton = orm
    .select({
      id: s.reply.id,
      parentReplyId: s.reply.parentReplyId,
      createdAt: s.reply.createdAt,
      deletedAt: s.reply.deletedAt,
    })
    .from(s.reply)
    .where(and(eq(s.reply.parentType, item.type), eq(s.reply.parentId, item.id)))
    .all()
    .map((row) => ({ ...row, deleted: row.deletedAt !== null }));
  const view = new ReplyTree(skeleton).view({
    root: query.root,
    limit: query.limit ?? REPLY_TREE.limit,
    depth: REPLY_TREE.depth,
    expand: query.expand,
    include: query.include,
  });
  if (!view) throw errors.notFound('Reply');

  const ids = view.nodes.map((node) => node.id);
  const rows: ReplyRow[] = [];
  for (let index = 0; index < ids.length; index += 500) {
    rows.push(
      ...orm
        .select()
        .from(s.reply)
        .where(inArray(s.reply.id, ids.slice(index, index + 500)))
        .all(),
    );
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const live = new Map(
    toReplies(
      orm,
      rows.filter((row) => row.deletedAt === null),
      actor.userId,
    ).map((reply) => [reply.id, reply]),
  );
  const items: ReplyNode[] = [];
  for (const node of view.nodes) {
    const extra = { replyCount: node.replyCount, depth: node.depth };
    const reply = live.get(node.id);
    const row = byId.get(node.id);
    if (reply) items.push({ ...reply, deleted: false, ...extra });
    else if (row) items.push({ ...placeholder(row), ...extra });
  }
  return {
    items,
    total: view.total,
    topLevelCount: view.topLevelCount,
    ancestors: view.ancestors,
  };
}

/** A deleted reply that still has answers: its place in the tree, without text or author. */
function placeholder(row: ReplyRow): Reply & { deleted: true } {
  const at = row.createdAt.toISOString();
  return {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    parentType: row.parentType,
    parentId: row.parentId,
    parentReplyId: row.parentReplyId,
    body: '',
    author: null,
    via: null,
    attachments: [],
    reactions: [],
    createdAt: at,
    updatedAt: at,
    editedAt: null,
    deleted: true,
  };
}

export interface ReplyPageQuery extends Pick<ListRepliesQuery, 'parentType' | 'parentId'> {
  limit: number;
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined;
  /** `asc`: oldest first (thread order); `desc`: newest first. */
  order: 'asc' | 'desc';
}

export interface ReplyPage {
  items: Reply[];
  /** Live replies in the whole thread. */
  total: number;
  nextCursor: string | null;
}

/**
 * One page of a thread (MCP `list_replies`, and the latest replies of `get_task` / `get_issue`),
 * keyset-paginated on `[createdAt, id]` in either direction, so long threads stay bounded.
 */
export function listReplyPage(deps: AppDeps, actor: Actor, query: ReplyPageQuery): ReplyPage {
  const { orm } = deps.db;
  requireItem(orm, actor, query.parentType, query.parentId);
  const thread = and(
    eq(s.reply.parentType, query.parentType),
    eq(s.reply.parentId, query.parentId),
    isNull(s.reply.deletedAt),
  );
  const newestFirst = query.order === 'desc';
  let after: SQL | undefined;
  if (query.cursor) {
    const [createdAtMs, id] = decodeCursor(query.cursor, timeIdCursorSchema);
    const createdAt = new Date(createdAtMs);
    const beyond = newestFirst ? lt : gt;
    after = or(
      beyond(s.reply.createdAt, createdAt),
      and(eq(s.reply.createdAt, createdAt), beyond(s.reply.id, id)),
    );
  }
  const direction = newestFirst ? desc : asc;
  const rows = orm
    .select()
    .from(s.reply)
    .where(and(thread, after))
    .orderBy(direction(s.reply.createdAt), direction(s.reply.id))
    .limit(query.limit + 1)
    .all();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const total = orm.select({ value: count() }).from(s.reply).where(thread).get()?.value ?? 0;
  return {
    items: toReplies(orm, page, actor.userId),
    total,
    nextCursor:
      rows.length > query.limit && last ? encodeCursor([last.createdAt.getTime(), last.id]) : null,
  };
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
  return withContext(deps, toReply(deps.db.orm, row, actor.userId), item);
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

function activityMeta(item: ItemInfo, bodyExcerpt: string, parentReplyId?: string | null) {
  return {
    parentType: item.type,
    parentId: item.id,
    parentRef: item.ref,
    parentTitle: item.title,
    excerpt: bodyExcerpt,
    ...(parentReplyId ? { parentReplyId } : {}),
  };
}

/** A reply checked and ready to insert: its parent item and the text derived from its body. */
export interface PreparedReply {
  item: ItemInfo;
  input: CreateReplyInput;
  text: ReturnType<typeof derivedText>;
}

/**
 * The live reply a new reply answers (`parentReplyId`): it must belong to the same issue or task
 * and must not be deleted.
 */
function answeredReply(db: DbExecutor, item: ItemInfo, parentReplyId: string) {
  const row = db
    .select({
      id: s.reply.id,
      authorId: s.reply.authorId,
      parentType: s.reply.parentType,
      parentId: s.reply.parentId,
      deletedAt: s.reply.deletedAt,
    })
    .from(s.reply)
    .where(eq(s.reply.id, parentReplyId))
    .get();
  if (row?.parentType !== item.type || row.parentId !== item.id) {
    throw errors.validation(`You can only answer a reply on this ${item.type}`, {
      field: 'parentReplyId',
    });
  }
  if (row.deletedAt) throw errors.conflict('The reply you are answering was deleted');
  return row;
}

/**
 * Checks a new reply before the write (`REPLY` permission on a live item, and the reply it
 * answers) and derives its search text and excerpt, so `insertReply` can post it inside any
 * transaction.
 */
export function prepareReply(deps: AppDeps, actor: Actor, input: CreateReplyInput): PreparedReply {
  const { item, membership } = requireItem(deps.db.orm, actor, input.parentType, input.parentId);
  requirePermission(membership, 'REPLY', "You don't have permission to reply here");
  if (input.parentReplyId) answeredReply(deps.db.orm, item, input.parentReplyId);
  return { item, input, text: derivedText(input.body) };
}

/**
 * Posts a prepared reply inside the caller's write: bumps the parent's reply count and last
 * activity, claims pending attachments, subscribes the author, indexes it for search and notifies
 * mentioned members and the parent's subscribers (one notification per person).
 */
export function insertReply(tx: Tx, actor: Actor, prepared: PreparedReply): ReplyRow {
  const { item, input, text } = prepared;
  // Checked again inside the write: the answered reply may have been deleted meanwhile.
  const answered = input.parentReplyId ? answeredReply(tx, item, input.parentReplyId) : null;
  const now = new Date();
  const reply = tx
    .insert(s.reply)
    .values({
      id: newId(),
      teamId: item.teamId,
      projectId: item.projectId,
      parentType: item.type,
      parentId: item.id,
      parentReplyId: answered?.id ?? null,
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
    meta: activityMeta(item, text.excerpt, answered?.id),
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
  // The author of the answered reply hears about it even without a subscription (like Reddit).
  if (answered?.authorId) notifyUsers(tx, actor, 'reply', [answered.authorId], target, notified);
  notifyReply(tx, actor, { type: item.type, id: item.id }, target, notified);
  recordAgentMentions(tx, actor, {
    id: reply.id,
    teamId: item.teamId,
    parentType: item.type,
    parentId: item.id,
    body: reply.body,
  });
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
}

/** Posts a reply (`REPLY` permission) in its own transaction; see `insertReply`. */
export function createReply(
  deps: AppDeps,
  actor: Actor,
  input: CreateReplyInput,
): ReplyWithContext {
  const prepared = prepareReply(deps, actor, input);
  const row = deps.db.write((tx) => insertReply(tx, actor, prepared));
  return withContext(deps, toReply(deps.db.orm, row, actor.userId), prepared.item);
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
  if (row.body === input.body) return withContext(deps, toReply(orm, row, actor.userId), item);
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
    recordAgentMentions(
      tx,
      actor,
      { id, teamId: item.teamId, parentType: item.type, parentId: item.id, body: next.body },
      row.body,
    );
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
  return withContext(deps, toReply(orm, updated, actor.userId), item);
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
