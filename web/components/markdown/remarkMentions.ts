import { findMentions } from '@web/lib/mentions';

/**
 * Remark plugin: turns `@username`, `@&role-slug` and `@everyone` in text into mention nodes that
 * render as `<span data-mention="user|role" data-id="…">`. Code, inline code and link text are
 * left alone.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'html']);

function splitText(node: MdastNode): MdastNode[] {
  const text = node.value ?? '';
  const matches = findMentions(text);
  if (matches.length === 0) return [node];
  const parts: MdastNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) parts.push({ type: 'text', value: text.slice(cursor, match.index) });
    parts.push({
      type: 'mention',
      data: {
        hName: 'span',
        hProperties: { dataMention: match.kind, dataId: match.id },
        hChildren: [{ type: 'text', value: match.raw }],
      },
    });
    cursor = match.index + match.raw.length;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}

function transform(node: MdastNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text') return splitText(child);
    transform(child);
    return [child];
  });
}

export function remarkMentions() {
  return (tree: MdastNode) => {
    transform(tree);
  };
}
