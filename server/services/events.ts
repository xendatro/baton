import { isPersonalEvent, type LiveEvent } from '@shared/events';
import type { AppDeps } from '../context';
import { queueLiveEvent, type Tx } from '../db';
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
