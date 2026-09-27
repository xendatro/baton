import { useSyncExternalStore } from 'react';
import type { ReplyParentType } from '@shared/constants';

/**
 * Replies the viewer posted on each item during this page session (BAT-13). The comment tree loads
 * the oldest 200 comments, so in a long thread a new reply would fall outside it; the tree asks
 * the server to include these (`include`), wherever they are.
 */

const MAX_PER_THREAD = 20;
const EMPTY: readonly string[] = [];
const posted = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

const threadKey = (parentType: ReplyParentType, parentId: string) => `${parentType}:${parentId}`;

export function notePostedReply(parentType: ReplyParentType, parentId: string, replyId: string) {
  const key = threadKey(parentType, parentId);
  posted.set(key, [...(posted.get(key) ?? EMPTY), replyId].slice(-MAX_PER_THREAD));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePostedReplies(parentType: ReplyParentType, parentId: string): readonly string[] {
  const key = threadKey(parentType, parentId);
  return useSyncExternalStore(subscribe, () => posted.get(key) ?? EMPTY);
}
