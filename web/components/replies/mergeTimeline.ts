import type { ActivityEntry, Reply } from '@shared/schemas/core';

export type TimelineItem<R extends Reply = Reply> =
  { kind: 'reply'; at: string; reply: R } | { kind: 'activity'; at: string; entry: ActivityEntry };

/**
 * Replies and history in time order. Reply creation is already visible as the reply itself, so
 * those activity rows are dropped; the item's own "created" row is dropped too, since the page
 * shows the original post above the timeline. With threaded replies (BAT-13) these are the
 * top-level comments; their answers show under them.
 */
export function mergeTimeline<R extends Reply>(
  replies: readonly R[],
  activity: readonly ActivityEntry[],
  parentId: string,
): TimelineItem<R>[] {
  const shown = (entry: ActivityEntry) =>
    !entry.action.startsWith('reply.') &&
    !(entry.entityId === parentId && entry.action.endsWith('.created'));
  const items: TimelineItem<R>[] = [
    ...replies.map((reply): TimelineItem<R> => ({ kind: 'reply', at: reply.createdAt, reply })),
    ...activity
      .filter(shown)
      .map((entry): TimelineItem<R> => ({ kind: 'activity', at: entry.createdAt, entry })),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
