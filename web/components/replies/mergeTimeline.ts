import type { ActivityEntry, Reply } from '@shared/schemas/core';

export type TimelineItem =
  | { kind: 'reply'; at: string; reply: Reply }
  | { kind: 'activity'; at: string; entry: ActivityEntry };

/**
 * Replies and history in time order. Reply creation is already visible as the reply itself, so
 * those activity rows are dropped; the item's own "created" row is dropped too, since the page
 * shows the original post above the timeline.
 */
export function mergeTimeline(
  replies: readonly Reply[],
  activity: readonly ActivityEntry[],
  parentId: string,
): TimelineItem[] {
  const shown = (entry: ActivityEntry) =>
    !entry.action.startsWith('reply.') &&
    !(entry.entityId === parentId && entry.action.endsWith('.created'));
  const items: TimelineItem[] = [
    ...replies.map((reply): TimelineItem => ({ kind: 'reply', at: reply.createdAt, reply })),
    ...activity
      .filter(shown)
      .map((entry): TimelineItem => ({ kind: 'activity', at: entry.createdAt, entry })),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
