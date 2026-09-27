import { REPLY_TREE, type ReplyNode } from '@shared/schemas/core';

/**
 * The comment tree of an issue or task as the web shows it (BAT-13), built from the nodes
 * `GET /api/replies` returns (parents before answers, each with its depth and answer count).
 */

/** Levels shown before "Continue this thread" (Reddit's 10). */
export const MAX_THREAD_DEPTH = REPLY_TREE.depth;

export interface ThreadNode {
  reply: ReplyNode;
  children: ThreadNode[];
  /** Answers not loaded yet ("N more replies"). */
  hidden: number;
}

export interface ReplyForest {
  roots: ThreadNode[];
  byId: Map<string, ThreadNode>;
}

export function buildReplyForest(items: readonly ReplyNode[]): ReplyForest {
  const byId = new Map<string, ThreadNode>();
  const roots: ThreadNode[] = [];
  for (const reply of items) {
    const node: ThreadNode = { reply, children: [], hidden: 0 };
    byId.set(reply.id, node);
    const parent = reply.parentReplyId ? byId.get(reply.parentReplyId) : undefined;
    if (parent && reply.depth > 0) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of byId.values()) {
    node.hidden = Math.max(0, node.reply.replyCount - node.children.length);
  }
  return { roots, byId };
}

/** Ids of the loaded ancestors of a reply, outermost first. */
export function ancestorIds(forest: ReplyForest, id: string): string[] {
  const chain: string[] = [];
  let current = forest.byId.get(id);
  while (current?.reply.parentReplyId && current.reply.depth > 0) {
    const parent = forest.byId.get(current.reply.parentReplyId);
    if (!parent) break;
    chain.unshift(parent.reply.id);
    current = parent;
  }
  return chain;
}

/** Whether a node's answers are shown in place (deeper ones go through "Continue this thread"). */
export function showsAnswers(node: ThreadNode): boolean {
  return node.reply.depth < MAX_THREAD_DEPTH - 1;
}

/** Answers under a node that are loaded, at any depth. */
export function loadedDescendants(node: ThreadNode): number {
  let count = 0;
  const stack = [...node.children];
  while (stack.length > 0) {
    const next = stack.pop()!;
    count += 1;
    stack.push(...next.children);
  }
  return count;
}

/**
 * Where a `#reply-<id>` link should open when its reply is nested too deeply to show in place:
 * the ancestor three levels up becomes the thread's root (Reddit's `context=3`). Null when the
 * reply shows where it is.
 */
export function focusForDeepLink(forest: ReplyForest, id: string): string | null {
  const node = forest.byId.get(id);
  if (!node || node.reply.depth < MAX_THREAD_DEPTH) return null;
  const chain = ancestorIds(forest, id);
  return chain[Math.max(0, chain.length - 3)] ?? null;
}
