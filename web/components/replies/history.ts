import type { ActivityEntry } from '@shared/schemas/core';

/**
 * An item's history for the Activity drawer, newest first. Replies are the conversation itself, so
 * their rows are left out; everything else (created, moves, claims, edits…) is listed.
 */
export function historyEntries(activity: readonly ActivityEntry[]): ActivityEntry[] {
  return activity
    .filter((entry) => !entry.action.startsWith('reply.'))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
