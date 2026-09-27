import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router';

/**
 * In-app history (BAT-11): the URL and window scroll position of every history entry the app has
 * shown, by the index React Router keeps in `history.state.idx`. Back links use it to tell
 * whether the previous entry is the list a detail page was opened from, so going back returns to
 * that list with its filters (the query string) and scroll position instead of a fresh copy.
 * `useNavigationHistory` (mounted once, in the app shell) keeps it up to date.
 */

export interface HistoryEntry {
  pathname: string;
  search: string;
  /** `window.scrollY` when the entry was last shown. */
  scrollY: number;
}

const entries = new Map<number, HistoryEntry>();
let current: number | null = null;
/** Set by `goBackInHistory`: the entry being returned to and where to scroll once it shows. */
let pendingBack: { index: number; scrollY: number } | null = null;
let previousSnapshot: HistoryEntry | null = null;
const listeners = new Set<() => void>();

function browserIndex(): number | null {
  const state: unknown = window.history.state;
  if (state && typeof state === 'object' && 'idx' in state && typeof state.idx === 'number') {
    return state.idx;
  }
  return null;
}

/** Without `history.state.idx` (memory routers in tests), count pushes ourselves. */
function countedIndex(type: NavigationType): number | null {
  if (type === NavigationType.Push) return (current ?? 0) + 1;
  if (type === NavigationType.Replace) return current ?? 0;
  return pendingBack?.index ?? (current === null ? 0 : null);
}

function publish(): void {
  const previous = current === null ? null : (entries.get(current - 1) ?? null);
  if (previous === previousSnapshot) return;
  previousSnapshot = previous;
  for (const listener of listeners) listener();
}

/** Scrolls to `y` once the page is tall enough (its data may still be rendering), for up to 2 s. */
function restoreScroll(y: number): void {
  if (y <= 0) return;
  const deadline = Date.now() + 2000;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
  for (const name of events) window.addEventListener(name, cancel, { once: true, passive: true });
  const step = () => {
    if (!cancelled) window.scrollTo(0, y);
    if (cancelled || Math.abs(window.scrollY - y) <= 1 || Date.now() > deadline) {
      for (const name of events) window.removeEventListener(name, cancel);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Records each location the router shows, and the window's scroll position on it. */
export function useNavigationHistory(): void {
  const location = useLocation();
  const type = useNavigationType();

  // A layout effect, so the new index is set before any scroll event of the new page arrives.
  useLayoutEffect(() => {
    const index = browserIndex() ?? countedIndex(type);
    const back = pendingBack;
    pendingBack = null;
    current = index;
    if (index !== null) {
      const known = entries.get(index);
      const keepScroll = type !== NavigationType.Push && known?.pathname === location.pathname;
      entries.set(index, {
        pathname: location.pathname,
        search: location.search,
        scrollY: keepScroll ? known.scrollY : 0,
      });
      if (back?.index === index) restoreScroll(back.scrollY);
    }
    publish();
  }, [location.key, location.pathname, location.search, type]);

  useEffect(() => {
    const onScroll = () => {
      const entry = current === null ? undefined : entries.get(current);
      if (entry) entry.scrollY = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
}

/** The history entry before the current one, if the app showed it. */
export function usePreviousEntry(): HistoryEntry | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => previousSnapshot,
    () => null,
  );
}

/** Goes back one entry and restores the scroll position it had. */
export function useGoBackInHistory(): () => void {
  const navigate = useNavigate();
  return () => {
    const previous = current === null ? undefined : entries.get(current - 1);
    if (current !== null && previous) {
      pendingBack = { index: current - 1, scrollY: previous.scrollY };
    }
    void navigate(-1);
  };
}

// ---------------------------------------------------------------------------------------------
// Back links
// ---------------------------------------------------------------------------------------------

/** A list a detail page can be opened from, e.g. `{ pathname: '/my-tasks', label: 'My tasks' }`. */
export interface BackSource {
  pathname: string;
  label: string;
}

export interface BackOptions {
  /** The section's list: where the link goes when the page wasn't opened from a known list. */
  to: string;
  /** Name of that list, e.g. `Issues`. */
  label: string;
  /** Other lists that open this page; going back returns to them when they came right before. */
  also?: readonly BackSource[];
}

export interface BackTarget {
  /** The list's URL, with its query string when returning to the entry it was opened from. */
  href: string;
  label: string;
  /** True when the previous history entry is that list, so going back is `history.back()`. */
  fromHistory: boolean;
}

function pathnameOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/** Where a back link goes: the previous entry when it is one of the lists, else the section. */
export function resolveBackTarget(
  previous: Pick<HistoryEntry, 'pathname' | 'search'> | null,
  { to, label, also = [] }: BackOptions,
): BackTarget {
  if (previous) {
    const sources: BackSource[] = [{ pathname: pathnameOf(to), label }, ...also];
    const source = sources.find((candidate) => candidate.pathname === previous.pathname);
    if (source) {
      return {
        href: `${previous.pathname}${previous.search}`,
        label: source.label,
        fromHistory: true,
      };
    }
  }
  return { href: to, label, fromHistory: false };
}

/** The back target of the current page and a function that goes there. */
export function useBack(options: BackOptions): BackTarget & { goBack: () => void } {
  const navigate = useNavigate();
  const goBackInHistory = useGoBackInHistory();
  const target = resolveBackTarget(usePreviousEntry(), options);
  const goBack = () => {
    if (target.fromHistory) goBackInHistory();
    else void navigate(target.href);
  };
  return { ...target, goBack };
}

/** Forgets everything (tests). */
export function resetNavigationHistory(): void {
  entries.clear();
  current = null;
  pendingBack = null;
  previousSnapshot = null;
}
