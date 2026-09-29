import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { LatestReply } from '@shared/schemas/core';
import { useSession } from '@web/lib/auth';
import type { ReactNode } from 'react';

/**
 * BAT-44: state shared by the item rail's pieces: whether the viewer collapsed it (per user, in
 * localStorage), the frame's controls (context), and the row model.
 */

/** Screens at least this wide show the rail beside the page. */
export const RAIL_INLINE_QUERY = '(min-width: 1280px)';

const STORAGE_PREFIX = 'baton.itemRail.collapsed:';
const collapseListeners = new Set<() => void>();

function readCollapsed(userId: string | null): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${userId ?? 'anonymous'}`) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(userId: string | null, collapsed: boolean): void {
  try {
    const key = `${STORAGE_PREFIX}${userId ?? 'anonymous'}`;
    if (collapsed) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  for (const listener of collapseListeners) listener();
}

/** Whether the viewer collapsed the rail (per user, shared by the issue and task pages). */
export function useRailCollapsed(): [boolean, (collapsed: boolean) => void] {
  const userId = useSession().data?.user.id ?? null;
  const collapsed = useSyncExternalStore(
    (listener) => {
      collapseListeners.add(listener);
      return () => {
        collapseListeners.delete(listener);
      };
    },
    () => readCollapsed(userId),
    () => false,
  );
  const set = useCallback((next: boolean) => writeCollapsed(userId, next), [userId]);
  return [collapsed, set];
}

export interface RailControls {
  /** Is the rail showing (beside the page, or as the open sheet)? */
  open: boolean;
  /** Shown beside the page (wide screens) rather than as a sheet. */
  inline: boolean;
  toggle: () => void;
  /** Closes the sheet (after picking an item on a narrow screen). */
  closeSheet: () => void;
  label: string;
}

export const RailContext = createContext<RailControls | null>(null);

/** The frame's rail controls; null outside an `ItemPageFrame`. */
export function useItemRail(): RailControls | null {
  return useContext(RailContext);
}

/** One row's data, whatever the item type. */
export interface RailItem {
  id: string;
  ref: string;
  title: string;
  path: string;
  unreadCount?: number;
  /** Latest activity (ISO): the sort order and the time shown. */
  activityAt: string;
  latestReply?: LatestReply | null;
  /** A second line detail, e.g. the task's stage and assignees. */
  detail?: ReactNode;
}

/** What the rail needs of its (infinite) query. */
export interface RailQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}

/** Newest activity first; ties keep the server's order. */
export function sortByActivity<T extends Pick<RailItem, 'activityAt'>>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index, at: Date.parse(item.activityAt) || 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item);
}
