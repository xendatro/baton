/**
 * Output clean-up for the editor's markdown, so stored bodies read naturally to people and agents:
 * surrounding blank lines are trimmed, and links whose text is their own URL or email (autolinks)
 * are written bare — GFM turns them back into links when parsed. Fenced code and inline code are
 * left untouched.
 */

const AUTOLINK =
  /\[((?:https?:\/\/|www\.)[^\s[\]()]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)\]\((?:mailto:)?([^\s()]+)\)/g;

function collapseAutolinks(text: string): string {
  return text.replace(AUTOLINK, (match: string, label: string, href: string) => {
    const same =
      href === label ||
      href === `mailto:${label}` ||
      href === `http://${label}` ||
      href === `https://${label}`;
    return same ? label : match;
  });
}

/** Applies `transform` to the parts of a line outside inline code spans. */
function outsideInlineCode(line: string, transform: (text: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) => (index % 2 === 1 ? part : transform(part)))
    .join('');
}

export function normalizeMarkdown(markdown: string): string {
  let inFence = false;
  const lines = markdown.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : outsideInlineCode(line, collapseAutolinks);
  });
  return lines.join('\n').trim();
}
