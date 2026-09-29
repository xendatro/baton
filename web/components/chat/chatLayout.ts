import type { CatchUpRange, ChatPage } from '@shared/schemas/chat';
import type { Attachment, Reply } from '@shared/schemas/core';

/** Pure helpers of the chat stream: page order, message grouping, quoted previews, media. */

/** Messages of the loaded pages (newest page first), oldest first. */
export function chatMessages(pages: readonly ChatPage[] | undefined): Reply[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: Reply[] = [];
  for (const page of [...pages].reverse()) {
    for (const reply of page.items) {
      if (seen.has(reply.id)) continue;
      seen.add(reply.id);
      out.push(reply);
    }
  }
  return out;
}

/** Consecutive messages by the same author within this long share one header (Discord-like). */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Does `message` continue the group of `previous` (same author and key, a few minutes apart, not
 * an answer to another message, no "new messages" divider between them)?
 */
export function continuesGroup(
  previous: Reply | undefined,
  message: Reply,
  dividerBefore: boolean,
): boolean {
  if (!previous || dividerBefore || message.parentReplyId) return false;
  if (!previous.author || previous.author.id !== message.author?.id) return false;
  if ((previous.via?.keyId ?? null) !== (message.via?.keyId ?? null)) return false;
  const gap = Date.parse(message.createdAt) - Date.parse(previous.createdAt);
  return gap >= 0 && gap < GROUP_WINDOW_MS;
}

/** One line of plain text for a quoted preview. */
export function excerpt(markdown: string, max = 120): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => `[image${alt ? `: ${alt}` : ''}]`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Videos the server serves for inline playback. */
const PLAYABLE_VIDEO_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm', 'video/ogg']);

export function isPlayableVideo(attachment: Pick<Attachment, 'mimeType'>): boolean {
  return PLAYABLE_VIDEO_TYPES.has(attachment.mimeType);
}

/** A message's files: images and videos shown inline, the rest as file rows. */
export function splitAttachments(message: Pick<Reply, 'attachments' | 'body'>) {
  const media: Attachment[] = [];
  const files: Attachment[] = [];
  for (const attachment of message.attachments) {
    // Images already shown in the text (pasted inline) are not shown again.
    if (attachment.isImage && message.body.includes(attachment.url)) continue;
    if (attachment.isImage || isPlayableVideo(attachment)) media.push(attachment);
    else files.push(attachment);
  }
  return { media, files };
}

/** "X is typing…", "X and Y are typing…", "Several people are typing…". */
export function typingText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/** "Unread · 23 messages", "Last 50 messages". */
export function rangeLabel(range: CatchUpRange): string {
  const messages = `${range.count} ${range.count === 1 ? 'message' : 'messages'}`;
  return range.kind === 'unread' ? `Unread · ${messages}` : `Last ${messages}`;
}
