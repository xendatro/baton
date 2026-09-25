/**
 * Markdown helpers for plain-text uses of stored markdown: the search index, notification
 * snippets and activity meta. Not a renderer — the web app renders markdown (sanitized) itself.
 *
 * Bodies can be 100,000 characters long and are written by any member or agent, so every
 * pattern here must run in linear time: no open-ended scan may start at one opener and run past
 * the next opener of the same construct (each scanning class excludes its own opener), and
 * emphasis is not paired up (delimiter runs are judged by their neighbours instead).
 */

/**
 * A fenced code block (``` or ~~~); an unclosed fence runs to the end of the document. The
 * opening run is matched atomically (lookahead + backreference), so a long run of backticks with
 * no line break after it is not retried at every shorter length.
 */
const FENCE_PATTERN =
  /^ {0,3}(?=(`{3,}|~{3,}))\1[^\n]*\n([\s\S]*?)(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;

/** `![alt](src)`; the scans stop at the next bracket or parenthesis. */
const IMAGE_PATTERN = /!\[([^[\]\n]*)\]\([^()[\]\n]*\)/g;
/** `[label](href)`; the scans stop at the next bracket or parenthesis. */
const LINK_PATTERN = /\[([^[\]\n]+)\]\([^()[\]\n]*\)/g;
/** `<https://…>`; the scan stops at the next `<`. */
const AUTOLINK_PATTERN = /<(https?:[^<>\s]+)>/g;
/** An HTML tag; the scan stops at the next `<`. */
const TAG_PATTERN = /<\/?[a-zA-Z][^<>]*>/g;

/**
 * One left-to-right pass over the inline syntax that is left: backslash escapes, emphasis /
 * strikethrough delimiter runs, backtick runs and table pipes.
 */
const INLINE_PATTERN = /\\([\\`*_{}[\]()#+\-.!|~>])|[*_]+|~{2,}|`+|\|/g;

const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE_CHAR = /\s/;

/**
 * Whether a run of `*`, `_` or `~` is markup rather than text. Runs inside a word (`user_id`,
 * `a*b`) and runs with space on both sides (`2 * 3`) are text; any other run opens or closes
 * emphasis. Runs are not paired, so an unclosed `**` is dropped too, which is fine for plain text.
 */
function isDelimiterRun(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  const spaceBefore = before === undefined || SPACE_CHAR.test(before);
  const spaceAfter = after === undefined || SPACE_CHAR.test(after);
  if (spaceBefore && spaceAfter) return false;
  const wordBefore = before !== undefined && WORD_CHAR.test(before);
  const wordAfter = after !== undefined && WORD_CHAR.test(after);
  return !(wordBefore && wordAfter);
}

function replaceInline(text: string): string {
  return text.replace(
    INLINE_PATTERN,
    (match: string, escaped: string | undefined, offset: number) => {
      if (escaped !== undefined) return escaped;
      if (match === '|') return ' ';
      if (match.startsWith('`')) return '';
      return isDelimiterRun(text, offset, offset + match.length) ? '' : match;
    },
  );
}

/** Converts markdown to readable plain text: keeps words (including code), drops syntax. */
export function markdownToPlainText(markdown: string): string {
  const blocks = markdown
    // Fenced code: keep the code, drop the fences.
    .replace(FENCE_PATTERN, (_match, _fence, code: string) => `${code}\n`)
    // Images and links: keep the alt/label text.
    .replace(IMAGE_PATTERN, '$1')
    .replace(LINK_PATTERN, '$1')
    // Autolinks and raw HTML tags.
    .replace(AUTOLINK_PATTERN, '$1')
    .replace(TAG_PATTERN, ' ')
    // Headings, quotes, list markers and task checkboxes at line starts.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    // Horizontal rules and table separator rows.
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, '');
  return replaceInline(blocks)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * How much markdown `excerpt` converts per character of output: enough for link targets and
 * other syntax before the text, while keeping the work proportional to the excerpt, not the body.
 */
const EXCERPT_INPUT_FACTOR = 8;

/**
 * A single-line excerpt of at most `max` characters, cut at a word boundary with an ellipsis.
 * Accepts markdown or plain text.
 */
export function excerpt(markdown: string, max = 200): string {
  const input = markdown.slice(0, max * EXCERPT_INPUT_FACTOR);
  const text = markdownToPlainText(input).replace(/\s+/g, ' ').trim();
  if (text.length <= max && input.length === markdown.length) return text;
  if (text.length <= max) return `${text.slice(0, max - 1).trimEnd()}…`;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Removes fenced code blocks and inline code spans, so text inside code is not treated as
 * mentions or refs. Code is replaced by spaces (keeps word boundaries).
 */
export function stripCode(markdown: string): string {
  return stripCodeSpans(markdown.replace(FENCE_PATTERN, ' '));
}

/**
 * Replaces inline code spans with a space. A span opens with a run of backticks and closes at the
 * next run of the same length (CommonMark); an opener without a closer is literal text. Runs are
 * paired in one pass with a precomputed "next run of the same length" table, so the work stays
 * linear however many unmatched openers there are.
 */
function stripCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const nextSameLength: number[] = [];
  const lastByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const length = (runs[i]?.end ?? 0) - (runs[i]?.start ?? 0);
    nextSameLength[i] = lastByLength.get(length) ?? -1;
    lastByLength.set(length, i);
  }
  let result = '';
  let copied = 0;
  let i = 0;
  while (i < runs.length) {
    const close = nextSameLength[i] ?? -1;
    const opening = runs[i];
    const closing = runs[close];
    if (opening && closing) {
      result += `${text.slice(copied, opening.start)} `;
      copied = closing.end;
      i = close + 1;
    } else {
      i += 1;
    }
  }
  return result + text.slice(copied);
}
