import { LIMITS } from '@shared/constants';
import { AGENT_USERNAME_SUFFIX } from '@shared/principals';

/**
 * Mention syntax in markdown (SPEC §1.13): `@username` for people, `@&role-slug` for roles and
 * `@everyone` for the whole team. Agent members are users too: `@ethan-ai` (a username plus the
 * `-ai` suffix, shared/principals.ts) is one mention. Shared by the editor (serialization) and MarkdownView
 * (rendering) so both agree on what is a mention.
 */

export type MentionKind = 'user' | 'role';

export interface MentionToken {
  kind: MentionKind;
  /** Username, or role slug (`everyone` for `@everyone`). */
  id: string;
  /** The matched source text. */
  raw: string;
}

/** Slug of the built-in @everyone role, written as `@everyone` rather than `@&everyone`. */
export const EVERYONE_SLUG = 'everyone';

const USERNAME = `[a-z0-9_]{${LIMITS.username.min},${LIMITS.username.max}}(?:${AGENT_USERNAME_SUFFIX})?`;
const ROLE_SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** A mention must not run into more name characters (a name longer than the limit). */
const END = '(?![a-z0-9_])';

const AT_START = new RegExp(`^@(?:&(${ROLE_SLUG})|(${USERNAME}))${END}`, 'i');
const IN_TEXT = new RegExp(`(?<![\\w@&.\\/])@(?:&(${ROLE_SLUG})|(${USERNAME}))${END}`, 'gi');

function toToken(raw: string, roleSlug: string | undefined, username: string | undefined) {
  if (roleSlug !== undefined) {
    return { kind: 'role', id: roleSlug.toLowerCase(), raw } satisfies MentionToken;
  }
  const id = (username ?? '').toLowerCase();
  if (id === EVERYONE_SLUG) return { kind: 'role', id, raw } satisfies MentionToken;
  return { kind: 'user', id, raw } satisfies MentionToken;
}

/** The mention at the very start of `src`, if any (markdown tokenizers). */
export function mentionAtStart(src: string): MentionToken | null {
  const match = AT_START.exec(src);
  if (!match) return null;
  return toToken(match[0], match[1], match[2]);
}

/** Index of the next `@` that can start a mention, or -1. */
export function nextMentionStart(src: string): number {
  IN_TEXT.lastIndex = 0;
  const match = IN_TEXT.exec(src);
  return match ? match.index : -1;
}

export interface MentionMatch extends MentionToken {
  index: number;
}

/** Every mention in plain text (not preceded by a word character, so emails don't match). */
export function findMentions(text: string): MentionMatch[] {
  const matches: MentionMatch[] = [];
  for (const match of text.matchAll(IN_TEXT)) {
    matches.push({ ...toToken(match[0], match[1], match[2]), index: match.index });
  }
  return matches;
}

/** Markdown for a mention: `@alice`, `@&design`, `@everyone`. */
export function formatMention(kind: MentionKind, id: string): string {
  if (kind === 'role' && id !== EVERYONE_SLUG) return `@&${id}`;
  return `@${id}`;
}
