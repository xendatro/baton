import type { Actor } from '../context';
import type * as s from '../db/schema';

/**
 * Task claims (SPEC §1.8), the primitives shared by the tasks and claims services and the item
 * resolver in ./items.ts. No other service is imported here, which keeps that dependency one-way.
 *
 * A claim is held by a (user, API key) pair — key null for web claims — until it is released,
 * taken over or the task is finished. Claims no longer expire (2026-09-27): `claim_expires_at` is
 * left null, and older rows' expiry is ignored.
 */

type ClaimColumns = Pick<
  typeof s.task.$inferSelect,
  'claimedById' | 'claimedViaKeyId' | 'claimExpiresAt'
>;

/** Whether the task is claimed (claims don't expire; `now` is kept for callers). */
export function isClaimValid(task: ClaimColumns, _now: Date = new Date()): boolean {
  return task.claimedById !== null;
}

/** Whether `actor` (the same user through the same key, or both on the web) holds the claim. */
export function isHolder(task: ClaimColumns, actor: Pick<Actor, 'userId' | 'key'>): boolean {
  return task.claimedById === actor.userId && task.claimedViaKeyId === (actor.key?.id ?? null);
}
