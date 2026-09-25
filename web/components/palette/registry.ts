import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Command palette registry. Pages add commands while mounted with `usePaletteCommands`; modules
 * add search sources with `registerSearchProvider` (the admin module plugs full-text search in
 * here). Both are plain stores so the palette re-renders when they change.
 */

export interface PaletteCommand {
  /** Unique across the palette, e.g. `task.create`. */
  id: string;
  label: string;
  /** Group heading, e.g. "Actions" or "Project". */
  group: string;
  icon?: LucideIcon;
  /** Extra words matched by the filter. */
  keywords?: string[];
  /** Shortcut hint in hotkey syntax (`c`, `g d`). */
  shortcut?: string;
  perform: () => void;
}

export interface PaletteSearchResult {
  id: string;
  label: string;
  /** Secondary text, e.g. a ref or snippet. */
  description?: string;
  icon?: LucideIcon;
  /** App path to open. */
  href: string;
}

export interface PaletteSearchProvider {
  id: string;
  /** Group heading for the results. */
  group: string;
  /** Queries shorter than this are not searched (default 2). */
  minQueryLength?: number;
  search: (query: string, signal: AbortSignal) => Promise<PaletteSearchResult[]>;
}

type Listener = () => void;

function createStore<T>() {
  const entries = new Map<number, T>();
  const listeners = new Set<Listener>();
  let snapshot: T[] = [];
  let nextId = 1;
  return {
    add: (value: T): (() => void) => {
      const id = nextId++;
      entries.set(id, value);
      snapshot = [...entries.values()];
      for (const listener of listeners) listener();
      return () => {
        entries.delete(id);
        snapshot = [...entries.values()];
        for (const listener of listeners) listener();
      };
    },
    subscribe: (listener: Listener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: (): T[] => snapshot,
  };
}

const commandStore = createStore<PaletteCommand[]>();
const providerStore = createStore<PaletteSearchProvider>();

/** Adds commands to the palette while the calling component is mounted. */
export function usePaletteCommands(commands: PaletteCommand[]): void {
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });
  const signature = commands.map((command) => `${command.id}\u0000${command.label}`).join('\u0001');
  useEffect(() => {
    // Commands run the latest `perform`, so handlers may close over fresh state.
    const stable = latest.current.map((command) => ({
      ...command,
      perform: () => latest.current.find((current) => current.id === command.id)?.perform(),
    }));
    return commandStore.add(stable);
  }, [signature]);
}

export function useRegisteredCommands(): PaletteCommand[] {
  const groups = useSyncExternalStore(
    commandStore.subscribe,
    commandStore.getSnapshot,
    commandStore.getSnapshot,
  );
  return groups.flat();
}

/** Registers a search source. Returns the unregister function. */
export function registerSearchProvider(provider: PaletteSearchProvider): () => void {
  return providerStore.add(provider);
}

/** `registerSearchProvider` for the lifetime of a component. */
export function useSearchProvider(provider: PaletteSearchProvider): void {
  const latest = useRef(provider);
  useEffect(() => {
    latest.current = provider;
  });
  const { id, group, minQueryLength } = provider;
  useEffect(
    () =>
      registerSearchProvider({
        id,
        group,
        minQueryLength,
        search: (query, signal) => latest.current.search(query, signal),
      }),
    [id, group, minQueryLength],
  );
}

export function useSearchProviders(): PaletteSearchProvider[] {
  return useSyncExternalStore(
    providerStore.subscribe,
    providerStore.getSnapshot,
    providerStore.getSnapshot,
  );
}

// ---------------------------------------------------------------------------------------------
// Open state (the palette is opened from the sidebar, the header and Ctrl/Cmd+K)
// ---------------------------------------------------------------------------------------------

let open = false;
const openListeners = new Set<Listener>();

export function setPaletteOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of openListeners) listener();
}

export function openPalette(): void {
  setPaletteOpen(true);
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);
      return () => {
        openListeners.delete(listener);
      };
    },
    () => open,
    () => false,
  );
}
