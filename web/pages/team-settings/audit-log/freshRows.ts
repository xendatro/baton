import { useSyncExternalStore } from 'react';

/**
 * Rows that just arrived live, highlighted for a few seconds. A tiny external store, so the page
 * can mark rows while it prepends them and each row subscribes to its own flag.
 */

const FRESH_MS = 4000;

const fresh = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function markFresh(ids: readonly string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) fresh.add(id);
  notify();
  setTimeout(() => {
    for (const id of ids) fresh.delete(id);
    notify();
  }, FRESH_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useIsFresh(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => fresh.has(id),
    () => false,
  );
}
