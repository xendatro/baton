import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { CLAIM_LEASE } from '@shared/constants';
import type { Actor } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';

/**
 * Task claim leases (SPEC §1.8), the primitives shared by the tasks and claims services and the
 * item resolver in ./items.ts (so replies by the holder renew the lease). No other service is
 * imported here, which keeps that dependency one-way.
 *
 * A claim is held by a (user, API key) pair — key null for web claims — and is valid while its
 * lease has not ended. Expired claims count as unclaimed; the sweeper clears them every minute.
 */

type ClaimColumns = Pick<
  typeof s.task.$inferSelect,
  'claimedById' | 'claimedViaKeyId' | 'claimExpiresAt'
>;

const MINUTE_MS = 60_000;

/** Audit actions that start or restart a lease; their `meta.leaseMinutes` is the lease length. */
export const LEASE_ACTIONS = ['task.claimed', 'task.claim_taken_over', 'task.claim_renewed'];

/** Whether the task carries a claim whose lease has not ended. */
export function isClaimValid(task: ClaimColumns, now: Date = new Date()): boolean {
  return (
    task.claimedById !== null &&
    task.claimExpiresAt !== null &&
    task.claimExpiresAt.getTime() > now.getTime()
  );
}

/** Whether `actor` (the same user through the same key, or both on the web) holds the claim. */
export function isHolder(task: ClaimColumns, actor: Pick<Actor, 'userId' | 'key'>): boolean {
  return task.claimedById === actor.userId && task.claimedViaKeyId === (actor.key?.id ?? null);
}

/** When a lease of `minutes` started at `from` ends. */
export function leaseEnd(from: Date, minutes: number): Date {
  return new Date(from.getTime() + minutes * MINUTE_MS);
}

/**
 * The lease length the holder chose (from the latest claim or renewal audit row), or the
 * default. Implicit renewals reuse it, so a 2-hour claim isn't cut to 30 minutes by a reply.
 */
export function leaseMinutesOf(db: DbExecutor, taskId: string): number {
  const row = db
    .select({ meta: s.activity.meta })
    .from(s.activity)
    .where(
      and(
        eq(s.activity.entityType, 'task'),
        eq(s.activity.entityId, taskId),
        inArray(s.activity.action, LEASE_ACTIONS),
      ),
    )
    .orderBy(desc(s.activity.createdAt), desc(s.activity.id))
    .get();
  const minutes = row?.meta.leaseMinutes;
  return typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= CLAIM_LEASE.minMinutes &&
    minutes <= CLAIM_LEASE.maxMinutes
    ? minutes
    : CLAIM_LEASE.defaultMinutes;
}

/**
 * "Any write by the holder renews the lease": when `actor` holds a valid claim on the task, its
 * lease is extended to a full lease from now (never shortened). Runs inside the caller's write.
 * Not audited separately: the write that renewed it is. Returns whether it renewed.
 */
export function renewClaimOnWrite(
  tx: Tx,
  actor: Pick<Actor, 'userId' | 'key'>,
  taskId: string,
  now: Date = new Date(),
): boolean {
  const task = tx
    .select({
      claimedById: s.task.claimedById,
      claimedViaKeyId: s.task.claimedViaKeyId,
      claimExpiresAt: s.task.claimExpiresAt,
    })
    .from(s.task)
    .where(eq(s.task.id, taskId))
    .get();
  if (!task || !isClaimValid(task, now) || !isHolder(task, actor)) return false;
  const expiresAt = leaseEnd(now, leaseMinutesOf(tx, taskId));
  if (task.claimExpiresAt && expiresAt.getTime() <= task.claimExpiresAt.getTime()) return false;
  tx.update(s.task)
    // A renewal is not an edit of the task.
    .set({ claimExpiresAt: expiresAt, updatedAt: sql`${s.task.updatedAt}` })
    .where(eq(s.task.id, taskId))
    .run();
  return true;
}
