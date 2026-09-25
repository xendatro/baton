/**
 * Search-term highlighting. Terms are the query's words (letters and digits in any script, like
 * the server's full-text search), matched case-insensitively at the start of words, since the
 * search matches word prefixes.
 */

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const MAX_TERMS = 12;

/** The words of a search query, longest first so overlapping terms prefer the longer match. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_TERMS).sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits `text` into matching and non-matching segments (adjacent segments never share a kind). */
export function highlightSegments(text: string, terms: readonly string[]): HighlightSegment[] {
  if (terms.length === 0 || text === '') return text ? [{ text, match: false }] : [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join('|')})`, 'giu');
  const segments: HighlightSegment[] = [];
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    const start = found.index;
    if (start > last) segments.push({ text: text.slice(last, start), match: false });
    const previous = segments.at(-1);
    if (previous?.match && start === last) previous.text += found[0];
    else segments.push({ text: found[0], match: true });
    last = start + found[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false });
  return segments;
}
