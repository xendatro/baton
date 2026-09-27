import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { LiveEvent } from '@shared/events';
import type { NotificationItem } from '@shared/schemas/core';
import { useLiveEventListener } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';
import { useMarkNotificationsRead } from './queries';

/**
 * BAT-15: opening a task or issue marks every notification about it (and its replies) read, and
 * so do notifications that arrive while it is on screen. A background tab leaves them unread until
 * it is visible again.
 */

/** The item whose thread is on screen in this tab, if any. */
let viewedItem: NotificationItem | null = null;

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * Is the notification a live event announced about the item on screen in a visible tab? Such a
 * notification is marked read at once, so the inbox doesn't toast or chime for it.
 */
export function isAboutItemOnScreen(event: Pick<LiveEvent, 'parentType' | 'parentId'>): boolean {
  return (
    viewedItem !== null &&
    event.parentType === viewedItem.type &&
    event.parentId === viewedItem.id &&
    isVisible()
  );
}

/** Has the item's reply thread loaded (any replies query of the item, whatever its params)? */
function useThreadShown(type: NotificationItem['type'], id: string): boolean {
  const cache = useQueryClient().getQueryCache();
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache]);
  return useSyncExternalStore(subscribe, () =>
    cache
      .findAll({ queryKey: queryKeys.replies.list(type, id) })
      .some((query) => query.state.status === 'success'),
  );
}

/**
 * Marks the item's notifications read once its thread (replies) has loaded and the tab is visible,
 * then again whenever a new notification about it arrives (or, in a background tab, once the tab
 * becomes visible).
 */
export function useMarkItemRead(
  type: NotificationItem['type'],
  item: { id: string; projectId: string },
): void {
  const { id, projectId } = item;
  const queryClient = useQueryClient();
  const threadShown = useThreadShown(type, id);
  const { mutate } = useMarkNotificationsRead();
  // Something may be unread: true on open and when a notification about the item arrives.
  const pending = useRef(true);

  const markIfVisible = useCallback(() => {
    if (!threadShown || !pending.current || !isVisible()) return;
    pending.current = false;
    mutate(
      { item: { type, id } },
      {
        // The item's unread badge on the board, list and issue list (BAT-16).
        onSuccess: ({ updated }) => {
          if (updated === 0) return;
          const key = type === 'task' ? queryKeys.tasks.all : queryKeys.issues.all;
          void queryClient.invalidateQueries({ queryKey: key(projectId) });
        },
      },
    );
  }, [threadShown, type, id, projectId, mutate, queryClient]);

  useEffect(() => {
    if (!threadShown) return;
    const entry: NotificationItem = { type, id };
    viewedItem = entry;
    return () => {
      if (viewedItem === entry) viewedItem = null;
    };
  }, [threadShown, type, id]);

  useEffect(() => {
    markIfVisible();
    document.addEventListener('visibilitychange', markIfVisible);
    return () => document.removeEventListener('visibilitychange', markIfVisible);
  }, [markIfVisible]);

  useLiveEventListener((event) => {
    if (event.type !== 'notification.created') return;
    if (event.parentType !== type || event.parentId !== id) return;
    pending.current = true;
    markIfVisible();
  });
}
