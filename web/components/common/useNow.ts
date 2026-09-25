import { useSyncExternalStore } from 'react';

/** One shared clock for every relative time on the page, ticking every 30 seconds. */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The shared clock, refreshed when it is older than a tick (e.g. before any subscriber). */
function getSnapshot(): number {
  const current = Date.now();
  if (current - now > TICK_MS) now = current;
  return now;
}

/** Current time in ms (at most 30 s stale), re-rendering the caller every 30 seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
