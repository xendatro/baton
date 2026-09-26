import { randomBytes } from 'node:crypto';
import type { LiveEvent } from '@shared/events';
import type { Logger } from '../logger';

export type LiveEventListener = (event: LiveEvent) => void;

/** How many recent events the bus keeps for long-polling clients (`GET /api/events/poll`). */
export const RECENT_EVENTS_LIMIT = 1000;

/** The events emitted after a cursor, and the cursor to ask from next time. */
export interface RecentEvents {
  events: LiveEvent[];
  cursor: string;
  /**
   * The cursor was not from this process or is older than the kept events (a server restart or a
   * long gap): events may be missing, so the client should refetch everything.
   */
  reset: boolean;
}

/**
 * In-process pub/sub for live events. Services call `emit` after their transaction commits; the
 * SSE endpoint subscribes per connection. Listener errors are logged, never propagated to the
 * emitting service. The last `RECENT_EVENTS_LIMIT` events are also kept, numbered, for clients
 * that can't hold a stream open and long-poll instead (`since`).
 */
export interface EventBus {
  emit(event: LiveEvent): void;
  subscribe(listener: LiveEventListener): () => void;
  /** Events emitted after `cursor` (from an earlier `since`, or null for "from now"). */
  since(cursor: string | null): RecentEvents;
  readonly listenerCount: number;
}

export function createEventBus(logger: Logger): EventBus {
  const listeners = new Set<LiveEventListener>();
  // Cursors are `<boot id>.<sequence>`, so a cursor from before a restart is recognised as stale.
  const bootId = randomBytes(6).toString('hex');
  const recent: Array<{ seq: number; event: LiveEvent }> = [];
  let seq = 0;
  const cursorOf = (value: number) => `${bootId}.${value}`;

  return {
    emit(event) {
      seq += 1;
      recent.push({ seq, event });
      if (recent.length > RECENT_EVENTS_LIMIT) recent.shift();
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          logger.error({ err: error, eventType: event.type }, 'live event listener failed');
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    since(cursor) {
      const current = cursorOf(seq);
      if (cursor === null) return { events: [], cursor: current, reset: false };
      const [boot, rawSeq] = cursor.split('.');
      const after = Number(rawSeq);
      const oldest = recent[0]?.seq ?? seq + 1;
      if (boot !== bootId || !Number.isInteger(after) || after > seq || after < oldest - 1) {
        return { events: [], cursor: current, reset: true };
      }
      return {
        events: recent.filter((entry) => entry.seq > after).map((entry) => entry.event),
        cursor: current,
        reset: false,
      };
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** Builds a live event stamped with the current time. */
export function liveEvent(event: Omit<LiveEvent, 'at'>): LiveEvent {
  return { ...event, at: new Date().toISOString() };
}
