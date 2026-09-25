import type { LiveEvent } from '@shared/events';
import type { Logger } from '../logger';

export type LiveEventListener = (event: LiveEvent) => void;

/**
 * In-process pub/sub for live events. Services call `emit` after their transaction commits; the
 * SSE endpoint subscribes per connection. Listener errors are logged, never propagated to the
 * emitting service.
 */
export interface EventBus {
  emit(event: LiveEvent): void;
  subscribe(listener: LiveEventListener): () => void;
  readonly listenerCount: number;
}

export function createEventBus(logger: Logger): EventBus {
  const listeners = new Set<LiveEventListener>();
  return {
    emit(event) {
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
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** Builds a live event stamped with the current time. */
export function liveEvent(event: Omit<LiveEvent, 'at'>): LiveEvent {
  return { ...event, at: new Date().toISOString() };
}
