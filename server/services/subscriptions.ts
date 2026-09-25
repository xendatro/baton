import { and, eq } from 'drizzle-orm';
import type { SubscribableType } from '@shared/constants';
import type {
  SetSubscriptionInput,
  SubscriptionQuery,
  SubscriptionResponse,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { requireItem } from './items';

/**
 * Reply-notification subscriptions (SPEC §1.10). Authors, assignees and repliers are subscribed
 * automatically; the explicit toggle on each page overrides that, and an explicit unsubscribe
 * (`subscribed = false`) is never undone by automatic subscription.
 */

/**
 * Subscribes users to an item unless they have a subscription row already (in particular an
 * explicit unsubscribe). Call it in the transaction that makes them author, assignee or replier.
 */
export function autoSubscribe(
  tx: Tx,
  userIds: Iterable<string | null | undefined>,
  entityType: SubscribableType,
  entityId: string,
): void {
  const unique = [...new Set([...userIds].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;
  tx.insert(s.subscription)
    .values(unique.map((userId) => ({ userId, entityType, entityId, subscribed: true })))
    .onConflictDoNothing()
    .run();
}

/** Users currently subscribed to an item. */
export function subscriberIds(
  db: DbExecutor,
  entityType: SubscribableType,
  entityId: string,
): string[] {
  return db
    .select({ userId: s.subscription.userId })
    .from(s.subscription)
    .where(
      and(
        eq(s.subscription.entityType, entityType),
        eq(s.subscription.entityId, entityId),
        eq(s.subscription.subscribed, true),
      ),
    )
    .all()
    .map((row) => row.userId);
}

function isSubscribed(db: DbExecutor, userId: string, type: SubscribableType, id: string): boolean {
  const row = db
    .select({ subscribed: s.subscription.subscribed })
    .from(s.subscription)
    .where(
      and(
        eq(s.subscription.userId, userId),
        eq(s.subscription.entityType, type),
        eq(s.subscription.entityId, id),
      ),
    )
    .get();
  return row?.subscribed ?? false;
}

/** `GET /api/subscriptions`: is the actor subscribed to this issue or task? */
export function getSubscription(
  deps: AppDeps,
  actor: Actor,
  query: SubscriptionQuery,
): SubscriptionResponse {
  const { orm } = deps.db;
  requireItem(orm, actor, query.entityType, query.entityId);
  return { subscribed: isSubscribed(orm, actor.userId, query.entityType, query.entityId) };
}

/**
 * `POST /api/subscriptions` and the MCP subscribe/unsubscribe tools: the explicit toggle.
 * Personal preference, so it is not written to the team audit log.
 */
export function setSubscription(
  deps: AppDeps,
  actor: Actor,
  input: SetSubscriptionInput,
): SubscriptionResponse {
  requireItem(deps.db.orm, actor, input.entityType, input.entityId);
  deps.db.write((tx) =>
    tx
      .insert(s.subscription)
      .values({
        userId: actor.userId,
        entityType: input.entityType,
        entityId: input.entityId,
        subscribed: input.subscribed,
      })
      .onConflictDoUpdate({
        target: [s.subscription.userId, s.subscription.entityType, s.subscription.entityId],
        set: { subscribed: input.subscribed, updatedAt: new Date() },
      })
      .run(),
  );
  return { subscribed: input.subscribed };
}
