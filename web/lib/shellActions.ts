import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Extension points of the app shell. The shell (sidebar, palette) triggers actions that feature
 * modules implement: e.g. the sidebar's "New team" button runs `team.create`, which the teams
 * module handles by opening its dialog. A module registers its handler with
 * `useShellActionHandler` from a component listed in `web/components/layout/shellExtensions.ts`.
 * Controls for an action are hidden while no handler is registered.
 *
 * Modules can add their own actions by augmenting `ShellActionPayloads`:
 *   declare module '@web/lib/shellActions' {
 *     interface ShellActionPayloads { 'project.create': { teamId: string } }
 *   }
 */
export interface ShellActionPayloads {
  /** Open the "create a team" flow. */
  'team.create': undefined;
}

export type ShellAction = keyof ShellActionPayloads;
type Handler<A extends ShellAction> = (payload: ShellActionPayloads[A]) => void;

const handlers = new Map<ShellAction, Set<Handler<ShellAction>>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function registerShellAction<A extends ShellAction>(
  action: A,
  handler: Handler<A>,
): () => void {
  const set = handlers.get(action) ?? new Set();
  set.add(handler as Handler<ShellAction>);
  handlers.set(action, set);
  notify();
  return () => {
    set.delete(handler as Handler<ShellAction>);
    notify();
  };
}

/** Runs the most recently registered handler. Returns false when nobody handles the action. */
export function runShellAction<A extends ShellAction>(
  action: A,
  ...payload: ShellActionPayloads[A] extends undefined ? [] : [ShellActionPayloads[A]]
): boolean {
  const handler = [...(handlers.get(action) ?? [])].at(-1);
  if (!handler) return false;
  handler(payload[0]);
  return true;
}

export function hasShellAction(action: ShellAction): boolean {
  return (handlers.get(action)?.size ?? 0) > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether some module handles `action` (re-renders when that changes). */
export function useShellActionAvailable(action: ShellAction): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return hasShellAction(action);
}

/** Handles `action` while the calling component is mounted. */
export function useShellActionHandler<A extends ShellAction>(action: A, handler: Handler<A>): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => registerShellAction(action, (payload) => latest.current(payload)), [action]);
}
