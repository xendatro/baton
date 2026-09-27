import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { REACTION_LIMITS, type ReactionTargetType } from '@shared/constants';
import type { ReactionInput, ReactionListResponse, ReactionSummary } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { appPaths } from '../lib/urls';
import { requirePermission, requireProjectAccess, type Membership } from './access';
import { emitAfterCommit } from './events';
import { findItem, requireItem, type ItemInfo } from './items';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Emoji reactions on replies, tasks and issues (BAT-14). A lightweight preference like a
 * notification's read state: no activity rows and no notifications, only a live event so every
 * open page shows the new counts. Reactions of deleted targets are hidden because only live
 * targets are ever loaded; the trash purge removes them with their target.
 */

/** Target ids per query, under SQLite's bound-parameter limit. */
const CHUNK = 500;

/**
 * Aggregated reactions of targets of one type, keyed by target id: one entry per emoji in order
 * of its first reaction, with everyone who reacted (oldest first). Targets without reactions are
 * missing from the map.
 */
export function reactionsByTarget(
  db: DbExecutor,
  targetType: ReactionTargetType,
  targetIds: readonly string[],
  viewerId: string,
): Map<string, ReactionSummary[]> {
  const ids = [...new Set(targetIds)];
  const rows: Array<typeof s.reaction.$inferSelect> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    rows.push(
      ...db
        .select()
        .from(s.reaction)
        .where(
          and(
            eq(s.reaction.targetType, targetType),
            inArray(s.reaction.targetId, ids.slice(i, i + CHUNK)),
          ),
        )
        .orderBy(asc(s.reaction.createdAt), asc(s.reaction.id))
        .all(),
    );
  }
  if (rows.length === 0) return new Map();
  const users = getUserSummaries(
    db,
    rows.map((row) => row.userId),
  );
  const keys = getViaKeys(
    db,
    rows.map((row) => row.viaKeyId),
  );
  const byTarget = new Map<string, Map<string, ReactionSummary>>();
  for (const row of rows) {
    const user = users.get(row.userId);
    if (!user) continue;
    let emojis = byTarget.get(row.targetId);
    if (!emojis) {
      emojis = new Map();
      byTarget.set(row.targetId, emojis);
    }
    let summary = emojis.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, reactedByMe: false, users: [] };
      emojis.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.reactedByMe ||= row.userId === viewerId;
    summary.users.push({ ...user, via: row.viaKeyId ? (keys.get(row.viaKeyId) ?? null) : null });
  }
  return new Map([...byTarget].map(([id, emojis]) => [id, [...emojis.values()]]));
}

/** Reactions of one target (see `reactionsByTarget`). */
export function reactionsOf(
  db: DbExecutor,
  targetType: ReactionTargetType,
  targetId: string,
  viewerId: string,
): ReactionSummary[] {
  return reactionsByTarget(db, targetType, [targetId], viewerId).get(targetId) ?? [];
}

/** A live reaction target the actor can see: its item (the reply's item for replies). */
interface ResolvedTarget {
  item: ItemInfo;
  membership: Membership;
  /** Relative web-app path of the target. */
  path: string;
}

function resolveTarget(deps: AppDeps, actor: Actor, input: ReactionTarget): ResolvedTarget {
  const { orm } = deps.db;
  if (input.targetType !== 'reply') {
    const { item, membership } = requireItem(orm, actor, input.targetType, input.targetId);
    return { item, membership, path: item.path };
  }
  const reply = orm
    .select({
      projectId: s.reply.projectId,
      parentType: s.reply.parentType,
      parentId: s.reply.parentId,
    })
    .from(s.reply)
    .where(and(eq(s.reply.id, input.targetId), isNull(s.reply.deletedAt)))
    .get();
  if (!reply) throw errors.notFound('Reply');
  const membership = requireProjectAccess(orm, actor, reply.projectId, 'Reply');
  const item = findItem(orm, reply.parentType, reply.parentId);
  if (!item) throw errors.notFound('Reply');
  return { item, membership, path: appPaths.reply(item.path, input.targetId) };
}

export interface ReactionTarget {
  targetType: ReactionTargetType;
  targetId: string;
}

/** A target's reactions after a change, with its ref and URL (MCP tools show them). */
export interface ReactionResult extends ReactionListResponse {
  /** `team/KEY-12` / `team/KEY#51`: the task or issue (for replies, the one the reply is on). */
  ref: string;
  /** Absolute URL of the target. */
  url: string;
}

function result(deps: AppDeps, actor: Actor, target: ReactionTarget, resolved: ResolvedTarget) {
  return {
    targetType: target.targetType,
    targetId: target.targetId,
    reactions: reactionsOf(deps.db.orm, target.targetType, target.targetId, actor.userId),
    ref: `${resolved.item.teamSlug}/${resolved.item.ref}`,
    url: `${deps.env.baseUrl}${resolved.path}`,
  } satisfies ReactionResult;
}

function emitChange(tx: Tx, actor: Actor, target: ReactionTarget, item: ItemInfo): void {
  const onReply = target.targetType === 'reply';
  emitAfterCommit(tx, {
    type: 'reaction.changed',
    teamId: item.teamId,
    projectId: item.projectId,
    entityType: target.targetType,
    entityId: target.targetId,
    // For replies: the thread, so clients refresh it.
    parentType: onReply ? item.type : null,
    parentId: onReply ? item.id : null,
    actorId: actor.userId,
  });
}

/** The actor's own reaction with `emoji` on the target, if any. */
function findOwnReaction(db: DbExecutor, actor: Actor, input: ReactionInput) {
  return db
    .select({ id: s.reaction.id })
    .from(s.reaction)
    .where(
      and(
        eq(s.reaction.targetType, input.targetType),
        eq(s.reaction.targetId, input.targetId),
        eq(s.reaction.userId, actor.userId),
        eq(s.reaction.emoji, input.emoji),
      ),
    )
    .get();
}

/**
 * Reacts to a reply, task or issue with an emoji (`REPLY` permission). Idempotent: reacting
 * again with the same emoji changes nothing.
 */
export function addReaction(deps: AppDeps, actor: Actor, input: ReactionInput): ReactionResult {
  const { orm } = deps.db;
  const resolved = resolveTarget(deps, actor, input);
  requirePermission(resolved.membership, 'REPLY', "You don't have permission to react here");
  if (findOwnReaction(orm, actor, input)) return result(deps, actor, input, resolved);

  deps.db.write((tx) => {
    const onTarget = and(
      eq(s.reaction.targetType, input.targetType),
      eq(s.reaction.targetId, input.targetId),
    );
    const emojiUsed = tx
      .select({ id: s.reaction.id })
      .from(s.reaction)
      .where(and(onTarget, eq(s.reaction.emoji, input.emoji)))
      .get();
    if (!emojiUsed) {
      const emojis = tx
        .selectDistinct({ emoji: s.reaction.emoji })
        .from(s.reaction)
        .where(onTarget)
        .all().length;
      if (emojis >= REACTION_LIMITS.emojisPerTarget) {
        throw errors.conflict(
          `This already has ${REACTION_LIMITS.emojisPerTarget} different reactions; add to one of them instead`,
        );
      }
    }
    const inserted = tx
      .insert(s.reaction)
      .values({
        id: newId(),
        teamId: resolved.item.teamId,
        targetType: input.targetType,
        targetId: input.targetId,
        userId: actor.userId,
        viaKeyId: actor.key?.id ?? null,
        emoji: input.emoji,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes > 0) emitChange(tx, actor, input, resolved.item);
  });
  return result(deps, actor, input, resolved);
}

/**
 * Removes the actor's own reaction (any member who can see the target; removing one that
 * doesn't exist changes nothing).
 */
export function removeReaction(deps: AppDeps, actor: Actor, input: ReactionInput): ReactionResult {
  const resolved = resolveTarget(deps, actor, input);
  if (findOwnReaction(deps.db.orm, actor, input)) {
    deps.db.write((tx) => {
      const removed = tx
        .delete(s.reaction)
        .where(
          and(
            eq(s.reaction.targetType, input.targetType),
            eq(s.reaction.targetId, input.targetId),
            eq(s.reaction.userId, actor.userId),
            eq(s.reaction.emoji, input.emoji),
          ),
        )
        .run();
      if (removed.changes > 0) emitChange(tx, actor, input, resolved.item);
    });
  }
  return result(deps, actor, input, resolved);
}

/** Is `id` a reply's id? Lets MCP tools accept a reply id wherever a task or issue ref goes. */
export function isReplyId(deps: Pick<AppDeps, 'db'>, id: string): boolean {
  return (
    deps.db.orm.select({ id: s.reply.id }).from(s.reply).where(eq(s.reply.id, id)).get() !==
    undefined
  );
}
