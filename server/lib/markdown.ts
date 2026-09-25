/**
 * Markdown helpers for plain-text uses of stored markdown: the search index, notification
 * snippets and activity meta. Not a renderer — the web app renders markdown (sanitized) itself.
 */

/** A fenced code block (``` or ~~~); an unclosed fence runs to the end of the document. */
const FENCE_PATTERN =
  /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm;

/** Converts markdown to readable plain text: keeps words (including code), drops syntax. */
export function markdownToPlainText(markdown: string): string {
  return (
    markdown
      // Fenced code: keep the code, drop the fences.
      .replace(FENCE_PATTERN, (_match, _fence, code: string) => `${code}\n`)
      // Images and links: keep the alt/label text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Autolinks and raw HTML tags.
      .replace(/<(https?:[^>\s]+)>/g, '$1')
      .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
      // Headings, quotes, list markers and task checkboxes at line starts.
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
      // Horizontal rules and table separator rows.
      .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '')
      .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, '')
      .replace(/\|/g, ' ')
      // Emphasis, strikethrough and inline code markers.
      .replace(/(\*{1,3}|_{1,3}|~~|`+)(\S[\s\S]*?\S|\S)\1/g, '$2')
      // Backslash escapes.
      .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * A single-line excerpt of at most `max` characters, cut at a word boundary with an ellipsis.
 * Accepts markdown or plain text.
 */
export function excerpt(markdown: string, max = 200): string {
  const text = markdownToPlainText(markdown).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Removes fenced code blocks and inline code spans, so text inside code is not treated as
 * mentions or refs. Code is replaced by spaces (keeps word boundaries).
 */
export function stripCode(markdown: string): string {
  return markdown.replace(FENCE_PATTERN, ' ').replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, ' ');
}
