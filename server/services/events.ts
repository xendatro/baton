import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { isPersonalEvent, type LiveEvent } from '@shared/events';
import type { AppDeps } from '../context';
import { queueLiveEvent, type DbExecutor, type Tx } from '../db';
import * as s from '../db/schema';
import { liveEvent, type RecentEvents } from '../lib/eventBus';
import { canViewProject, listProjectMemberships, memberTeamIds } from './access';

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
  const canSee = userEventFilter(deps, userId);
  return deps.events.subscribe((event) => {
    if (canSee(event)) listener(event);
  });
}

/**
 * Is `event` one `userId` may see? The filter remembers the user's teams, reloading them on
 * member and team-deletion events (see `subscribeUserEvents`).
 */
export function userEventFilter(
  deps: Pick<AppDeps, 'db'>,
  userId: string,
): (event: LiveEvent) => boolean {
  let teams = new Set(memberTeamIds(deps.db.orm, userId));
  let hidden: Set<string> | null = null;
  const hiddenProjects = () =>
    (hidden ??= new Set(hiddenProjectIds(deps.db.orm, userId, [...teams])));
  return (event) => {
    if (isPersonalEvent(event) || event.teamId === null) return event.userId === userId;
    let visible = teams.has(event.teamId);
    if (changesMembership(event)) {
      teams = new Set(memberTeamIds(deps.db.orm, userId));
      visible ||= teams.has(event.teamId);
    }
    if (changesProjectAccess(event)) hidden = null;
    // Events of projects the user can't see (VIEW_PROJECT) are not delivered (design §3), except
    // access changes, which may have just hidden the project: the client then drops it.
    if (visible && event.projectId && event.type !== 'project_access.changed') {
      visible = !hiddenProjects().has(event.projectId);
    }
    return visible;
  };
}

/** Projects (deleted ones included) of the user's teams that they can't see. */
function hiddenProjectIds(db: DbExecutor, userId: string, teamIds: readonly string[]): string[] {
  if (teamIds.length === 0) return [];
  return listProjectMemberships(db, userId, { teamIds, includeDeleted: true })
    .filter((access) => !canViewProject(access))
    .map((access) => access.projectId);
}

/** Events after which the projects a user can see may differ. */
function changesProjectAccess(event: LiveEvent): boolean {
  return (
    changesMembership(event) ||
    event.type === 'role.changed' ||
    event.type === 'project_access.changed' ||
    event.type === 'project.created'
  );
}

/** How long `GET /api/events/poll` waits for an event before answering with none. */
export const POLL_WAIT_MS = 25_000;

/**
 * Long-poll fallback for clients whose SSE stream never delivers (a proxy that buffers streamed
 * responses, such as a Cloudflare quick tunnel). Answers at once with the events `userId` may see
 * after `cursor`; when there are none, waits up to `waitMs` for the next one. A null cursor
 * answers at once with the current cursor, to start from.
 */
export async function pollUserEvents(
  deps: Pick<AppDeps, 'db' | 'events'>,
  userId: string,
  cursor: string | null,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<RecentEvents> {
  const canSee = userEventFilter(deps, userId);
  const visible = (batch: RecentEvents): RecentEvents => ({
    ...batch,
    events: batch.events.filter(canSee),
  });
  const first = visible(deps.events.since(cursor));
  if (cursor === null || first.reset || first.events.length > 0) return first;

  const { waitMs = POLL_WAIT_MS, signal } = options;
  await new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    signal?.addEventListener('abort', finish, { once: true });
    unsubscribe = subscribeUserEvents(deps, userId, finish);
    if (signal?.aborted) finish();
  });
  return visible(deps.events.since(cursor));
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
