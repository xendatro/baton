import { defaultFilter } from 'cmdk';

/**
 * Items scoring below this are hidden: cmdk's fuzzy matcher keeps anything that shares a few
 * scattered letters with the query (e.g. "sign out" matched "Settings" at 0.0001), which buried
 * the real match and let Enter run the wrong item. Real prefix and word matches score > 0.8.
 */
export const MIN_COMMAND_SCORE = 0.1;

/**
 * cmdk `filter` that scores only what people see and type, never ids. Give each item a unique id
 * as its `value` and put the display text first in `keywords`, followed by extra search words:
 *
 *   <CommandItem value={label.id} keywords={[label.name, 'more', 'words']} />
 */
export function commandFilter(_value: string, search: string, keywords?: string[]): number {
  const [text = '', ...extra] = keywords ?? [];
  const score = defaultFilter(text, search, extra);
  return score >= MIN_COMMAND_SCORE ? score : 0;
}
