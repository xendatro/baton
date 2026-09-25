import { mergeAttributes, Node, type JSONContent, type MarkdownToken } from '@tiptap/core';

/**
 * Markdown the editor has no WYSIWYG form for, kept verbatim so that opening and saving a body
 * never loses it (agents write markdown directly): raw HTML (inline tags and comments, HTML
 * blocks) and GFM footnotes (`[^1]` references and `[^1]: …` definitions). The editor shows it as
 * source in a small chip or block; MarkdownView renders it as usual (footnotes) or not at all
 * (HTML, which is sanitized away).
 */

/** Inline HTML (CommonMark "raw HTML"): open tag, closing tag, comment, PI, declaration, CDATA. */
const INLINE_HTML =
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/;
/** `<br>` stays a hard break: that is how table cells write line breaks. */
const LINE_BREAK_TAG = /^<br\s*\/?>$/i;
/** A footnote reference, `[^label]`. */
const FOOTNOTE_REFERENCE = /^\[\^[^\]\s]+\]/;
/** A footnote definition: `[^label]: text` plus indented continuation lines. */
const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:[^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*(?:\n|$)/;

function inlineRawAt(src: string): string | null {
  const html = INLINE_HTML.exec(src)?.[0];
  if (html) return LINE_BREAK_TAG.test(html) ? null : html;
  return FOOTNOTE_REFERENCE.exec(src)?.[0] ?? null;
}

function markdownAttribute(node: JSONContent): string {
  const value: unknown = node.attrs?.markdown;
  return typeof value === 'string' ? value : '';
}

const markdownAttributeSpec = {
  markdown: {
    default: '',
    parseHTML: (element: HTMLElement) => element.getAttribute('data-markdown') ?? '',
    renderHTML: (attributes: Record<string, unknown>) => ({
      'data-markdown': typeof attributes.markdown === 'string' ? attributes.markdown : '',
    }),
  },
};

/** Inline raw markdown (an HTML tag or a footnote reference), as an atomic source chip. */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return markdownAttributeSpec;
  },
  parseHTML() {
    return [{ tag: 'span[data-raw-markdown]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-raw-markdown': '',
        class: 'raw-markdown',
        title: 'Kept exactly as written',
      }),
      typeof node.attrs.markdown === 'string' ? node.attrs.markdown : '',
    ];
  },

  markdownTokenName: 'rawInline',
  markdownTokenizer: {
    name: 'rawInline',
    level: 'inline',
    start: (src: string) => {
      const match = /<[A-Za-z/!?]|\[\^/.exec(src);
      return match ? match.index : -1;
    },
    tokenize: (src: string) => {
      const raw = inlineRawAt(src);
      return raw ? { type: 'rawInline', raw, text: raw } : undefined;
    },
  },
  parseMarkdown: (token: MarkdownToken): JSONContent => ({
    type: 'rawInline',
    attrs: { markdown: token.raw ?? '' },
  }),
  renderMarkdown: (node: JSONContent) => markdownAttribute(node),
});

/** Block raw markdown (an HTML block or a footnote definition), as an atomic source block. */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return markdownAttributeSpec;
  },
  parseHTML() {
    return [{ tag: 'pre[data-raw-markdown]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, {
        'data-raw-markdown': '',
        class: 'raw-markdown-block',
        title: 'Kept exactly as written',
      }),
      typeof node.attrs.markdown === 'string' ? node.attrs.markdown : '',
    ];
  },

  // Block HTML arrives as marked's own `html` tokens (CommonMark HTML blocks); footnote
  // definitions come from the tokenizer below.
  markdownTokenName: 'html',
  markdownTokenizer: {
    name: 'footnoteDefinition',
    level: 'block',
    start: (src: string) => {
      const match = /^\[\^[^\]\s]+\]:/m.exec(src);
      return match ? match.index : -1;
    },
    tokenize: (src: string) => {
      const raw = FOOTNOTE_DEFINITION.exec(src)?.[0];
      return raw ? { type: 'html', raw, text: raw, block: true } : undefined;
    },
  },
  parseMarkdown: (token: MarkdownToken): JSONContent[] => {
    const markdown = (token.raw ?? token.text ?? '').replace(/\s+$/, '');
    return markdown ? [{ type: 'rawBlock', attrs: { markdown } }] : [];
  },
  renderMarkdown: (node: JSONContent) => markdownAttribute(node),
});
