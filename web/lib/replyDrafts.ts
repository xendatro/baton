import { z } from 'zod';
import type { ReplyParentType } from '@shared/constants';
import { attachmentSchema } from '@shared/schemas/core';

/**
 * Unsent reply drafts (UX-13): the reply composer keeps its text and pending files in
 * sessionStorage per thread, so following a link away, Back or a reload doesn't lose them. Drafts
 * belong to the signed-in user: the key carries their id, so someone else signing in in the same
 * tab never gets them, and signing out removes them all. An answer to a reply (BAT-13) has its own
 * draft, keyed by the reply it answers.
 */

const replyDraftSchema = z.object({ body: z.string(), attachments: z.array(attachmentSchema) });
export type ReplyDraft = z.infer<typeof replyDraftSchema>;

const PREFIX = 'baton:reply-draft:';

export function replyDraftKey(
  userId: string,
  parentType: ReplyParentType,
  parentId: string,
  parentReplyId?: string,
): string {
  const base = `${PREFIX}${userId}:${parentType}:${parentId}`;
  return parentReplyId ? `${base}:${parentReplyId}` : base;
}

/** The user's saved draft for a thread (or an answer to `parentReplyId`), or null. */
export function readReplyDraft(
  userId: string,
  parentType: ReplyParentType,
  parentId: string,
  parentReplyId?: string,
): ReplyDraft | null {
  try {
    const raw = sessionStorage.getItem(replyDraftKey(userId, parentType, parentId, parentReplyId));
    if (!raw) return null;
    const parsed = replyDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Saves the draft, or forgets it when it is empty. */
export function writeReplyDraft(
  userId: string,
  parentType: ReplyParentType,
  parentId: string,
  draft: ReplyDraft,
  parentReplyId?: string,
): void {
  try {
    const key = replyDraftKey(userId, parentType, parentId, parentReplyId);
    if (!draft.body.trim() && draft.attachments.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage full or disabled: the draft lasts as long as the page.
  }
}

/** Forgets every reply draft in this tab (on sign-out). */
export function clearReplyDrafts(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Storage disabled: there is nothing to clear.
  }
}
