import { stripCode } from './markdown';

/**
 * Mentions in markdown (SPEC §1.10, §1.13): `@username`, `@&role-slug` and `@everyone`.
 * Text inside code spans and fenced code blocks is ignored, and so are email addresses
 * (`a@b.com`) because a mention must not follow a word character.
 */
export interface ParsedMentions {
  /** Lowercase usernames, deduplicated, in order of appearance. */
  usernames: string[];
  /** Lowercase role slugs (without `@&`), deduplicated. `@&everyone` counts as `everyone`. */
  roleSlugs: string[];
  /** `@everyone` (or `@&everyone`) appears. */
  everyone: boolean;
}

const MENTION_PATTERN = /(?<![\w@&/.\\-])@(&?)([a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)(?![\w-])/gi;

const EVERYONE = 'everyone';

export function parseMentions(markdown: string): ParsedMentions {
  const usernames = new Set<string>();
  const roleSlugs = new Set<string>();
  let everyone = false;
  for (const match of stripCode(markdown).matchAll(MENTION_PATTERN)) {
    const isRole = match[1] === '&';
    const name = (match[2] ?? '').toLowerCase();
    if (name === EVERYONE) everyone = true;
    else if (isRole) roleSlugs.add(name);
    else usernames.add(name);
  }
  return { usernames: [...usernames], roleSlugs: [...roleSlugs], everyone };
}

/** Mentions present in `next` but not in `previous` (so editing a body re-notifies no one). */
export function addedMentions(next: string, previous: string | null | undefined): ParsedMentions {
  const after = parseMentions(next);
  if (!previous) return after;
  const before = parseMentions(previous);
  return {
    usernames: after.usernames.filter((name) => !before.usernames.includes(name)),
    roleSlugs: after.roleSlugs.filter((slug) => !before.roleSlugs.includes(slug)),
    everyone: after.everyone && !before.everyone,
  };
}
