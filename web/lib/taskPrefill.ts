import { LIMITS, type ReplyParentType } from '@shared/constants';
import type { Reply } from '@shared/schemas/core';

/**
 * "Create task" from an issue and "Make task from this" on messages: what the New task form
 * starts with. The title comes from the issue (or the first message's first line), the
 * description links back to the source and quotes it, and an issue is linked as `fixes` (as
 * `relates` for those who may not resolve it). `source` is what "Have my agent draft it" reads.
 */

export interface TaskPrefillIssue {
  id: string;
  ref: string;
  title?: string;
  /** `fixes` resolves the issue when the task is done; only for those who may resolve it. */
  kind: 'fixes' | 'relates';
}

export interface TaskPrefill {
  title: string;
  description: string;
  /** Linked to the new task (removable in the form). */
  issue: TaskPrefillIssue | null;
  /** The item and messages it came from ("From KEY#12", "From 3 messages in KEY-5"). */
  source: {
    itemType: ReplyParentType;
    itemId: string;
    ref: string;
    /** Empty: the item itself. */
    replyIds: string[];
  };
}

/** The conversation's item, as a message's prefill needs it. */
export interface PrefillItem {
  type: ReplyParentType;
  id: string;
  ref: string;
  /** Relative app path. */
  path: string;
  /** Set when the item is an issue: linked like "Create task" on it. */
  issueKind?: 'fixes' | 'relates';
  title?: string;
}

const MAX_TITLE = 80;

/** Plain text of a markdown line: no heading, quote or list marks, links as their text. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A task title from a message: its first line with text, shortened at a word. */
export function titleFromText(markdown: string, fallback: string): string {
  const line =
    markdown
      .split('\n')
      .map(plainLine)
      .find((text) => text.length > 0) ?? '';
  if (!line) return fallback;
  if (line.length <= MAX_TITLE) return line;
  const cut = line.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function quote(text: string): string {
  return (text.trim() || '_(no text)_')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function clip(text: string): string {
  return text.length <= LIMITS.body.max ? text : `${text.slice(0, LIMITS.body.max - 1)}…`;
}

/** Prefill of "Create task" on an issue (the same title and description the server would use). */
export function prefillFromIssue(issue: {
  id: string;
  ref: string;
  title: string;
  body: string;
  path: string;
  kind: 'fixes' | 'relates';
}): TaskPrefill {
  const header = `From issue [${issue.ref}](${issue.path}): ${issue.title}`;
  const body = issue.body.trim();
  return {
    title: issue.title,
    description: clip(body ? `${header}\n\n${body}` : header),
    issue: { id: issue.id, ref: issue.ref, title: issue.title, kind: issue.kind },
    source: { itemType: 'issue', itemId: issue.id, ref: issue.ref, replyIds: [] },
  };
}

/**
 * Prefill of "Make task from this" on one or more messages (in conversation order): the title from
 * the first one, the description quoting each with a link back. Authors are named, not
 * @mentioned, so creating the task pings nobody.
 */
export function prefillFromMessages(item: PrefillItem, messages: readonly Reply[]): TaskPrefill {
  const ordered = [...messages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
  const first = ordered[0];
  const header =
    ordered.length === 1
      ? `From [a message](${item.path}#reply-${first?.id ?? ''}) in [${item.ref}](${item.path})`
      : `From ${ordered.length} messages in [${item.ref}](${item.path})`;
  const quotes = ordered.map((message) => {
    const files = message.attachments.map((file) => file.filename);
    const who = message.author?.name ?? 'Deleted user';
    return `**${who}** ([message](${item.path}#reply-${message.id})):\n${quote(message.body)}${
      files.length > 0 ? `\n> _Files: ${files.join(', ')}_` : ''
    }`;
  });
  return {
    title: titleFromText(first?.body ?? '', `Follow up on ${item.ref}`),
    description: clip([`${header}:`, ...quotes].join('\n\n')),
    issue:
      item.type === 'issue'
        ? {
            id: item.id,
            ref: item.ref,
            ...(item.title ? { title: item.title } : {}),
            kind: item.issueKind ?? 'relates',
          }
        : null,
    source: {
      itemType: item.type,
      itemId: item.id,
      ref: item.ref,
      replyIds: ordered.map((message) => message.id),
    },
  };
}
