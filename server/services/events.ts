import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { isPersonalEvent, type LiveEvent } from '@shared/events';
import type { AppDeps } from '../context';
import { queueLiveEvent, type Tx } from '../db';
import * as s from '../db/schema';
import { liveEvent } from '../lib/eventBus';
import { memberTeamIds } from './access';

/**
 * Live events (SPEC §5). Two ways to publish, both delivered only after the data is committed:
 *   - inside `db.write`: `emitAfterCommit(tx, {...})` — queued, emitted when the transaction
 *     commits, dropped if it rolls back;
 *   - after `db.write` returned: `emitEvent(deps, {...})`.
 * Events are hints to refetch; they never carry entity data.
 */

export type LiveEventInput = Omit<LiveEvent, 'at'>;

/** Queues `event` for delivery after the surrounding `db.write` transaction commits. */
export function emitAfterCommit(tx: Tx, event: LiveEventInput): void {
  queueLiveEvent(tx, event);
}

/** Emits `event` now. Only call this after the change it describes has committed. */
export function emitEvent(deps: Pick<AppDeps, 'events'>, event: LiveEventInput): void {
  deps.events.emit(liveEvent(event));
}

/** Membership changes can add or remove the teams a connection may see. */
function changesMembership(event: LiveEvent): boolean {
  return event.type.startsWith('member.') || event.type === 'team.deleted';
}

/**
 * Subscribes `listener` to the events `userId` may see: events of teams they belong to, plus their
 * personal events (`notification.created`, `me.updated`, account-level `activity.created`).
 * Team membership is loaded once and reloaded whenever a member or team-deletion event arrives,
 * so joining or leaving a team takes effect on open connections. Members who just left still get
 * the event that removed them, so their UI can react. Returns the unsubscribe function.
 */
export function subscribeUserEvents(
  deps: Pick<AppDeps, 'db' | 'events'>,
  userId: string,
  listener: (event: LiveEvent) => void,
): () => void {
  let teams = new Set(memberTeamIds(deps.db.orm, userId));

  return deps.events.subscribe((event) => {
    if (isPersonalEvent(event) || event.teamId === null) {
      if (event.userId === userId) listener(event);
      return;
    }
    let visible = teams.has(event.teamId);
    if (changesMembership(event)) {
      teams = new Set(memberTeamIds(deps.db.orm, userId));
      visible ||= teams.has(event.teamId);
    }
    if (visible) listener(event);
  });
}

/** What an open event stream was authenticated with: an API key, or a web session. */
export type StreamCredential = { apiKeyId: string } | { sessionId: string };

/**
 * Is the credential still valid for `userId`? Streams are authenticated once, when they open,
 * so the SSE route re-checks this before every event and heartbeat: a revoked or expired key,
 * a signed-out or revoked session and a password reset (which deletes sessions) end the stream.
 */
export function isCredentialActive(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
  credential: StreamCredential,
  now: Date = new Date(),
): boolean {
  const { orm } = deps.db;
  if ('apiKeyId' in credential) {
    return (
      orm
        .select({ id: s.apiKey.id })
        .from(s.apiKey)
        .where(
          and(
            eq(s.apiKey.id, credential.apiKeyId),
            eq(s.apiKey.userId, userId),
            isNull(s.apiKey.revokedAt),
            or(isNull(s.apiKey.expiresAt), gt(s.apiKey.expiresAt, now)),
          ),
        )
        .get() !== undefined
    );
  }
  return (
    orm
      .select({ id: s.session.id })
      .from(s.session)
      .where(
        and(
          eq(s.session.id, credential.sessionId),
          eq(s.session.userId, userId),
          gt(s.session.expiresAt, now),
        ),
      )
      .get() !== undefined
  );
}
