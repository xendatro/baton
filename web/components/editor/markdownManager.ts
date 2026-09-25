import type { JSONContent } from '@tiptap/core';
import { assumeContentType, Markdown, MarkdownManager } from '@tiptap/markdown';
import { formatMention, type MentionKind } from '@web/lib/mentions';

/**
 * Markdown is the storage format (SPEC §1.13), so what the editor writes must read naturally to
 * people and agents and must survive being opened and saved again. `@tiptap/markdown` is close,
 * but its text encoding HTML-escapes text (`&amp;`, `&lt;`) and backslash-escapes every `*`, `_`,
 * `[` and `~`, and it drops the formatting around mentions. This manager changes three things:
 *
 * - Text is escaped only where a character would change the markdown structure in context
 *   (`escapeMarkdownText`); HTML entities in stored markdown are decoded when parsing.
 * - Marks apply to inline atoms (mentions, raw chips), and those atoms are written as marked text,
 *   so `**@alice**` and `[@alice](url)` round-trip.
 * - Empty paragraphs are skipped instead of being written as `&nbsp;` lines.
 *
 * Two of these hooks replace private methods of MarkdownManager (`encodeTextForMarkdown`,
 * `applyMarkToContent`). The constructor checks they still exist, and the round-trip tests in
 * markdown.test.ts cover the behaviour, so a library change fails loudly rather than silently.
 */

/** Inline atoms written as text in the markdown source. */
const INLINE_ATOMS: ReadonlySet<string> = new Set(['mention', 'rawInline']);

/** Containers whose first child must stay a paragraph even when it is empty. */
const NEEDS_FIRST_PARAGRAPH: ReadonlySet<string> = new Set([
  'listItem',
  'taskItem',
  'tableCell',
  'tableHeader',
]);

/** Marker on text nodes that already are markdown (atoms turned into text): written as is. */
const VERBATIM = 'batonVerbatim';

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const WHITESPACE = /\s/;
const WORD = /[\p{L}\p{N}]/u;
const ENTITY_AT = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;

type Neighbour = 'space' | 'word' | 'other';

function classify(char: string | undefined, boundary: Neighbour): Neighbour {
  if (char === undefined) return boundary;
  if (WHITESPACE.test(char)) return 'space';
  return WORD.test(char) ? 'word' : 'other';
}

/** Index of the character to escape so that a line does not start a block construct, or -1. */
function lineStartEscape(line: string): number {
  const indent = /^[ \t]{0,3}/.exec(line)?.[0].length ?? 0;
  const rest = line.slice(indent);
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return indent;
  if (/^(?:>|~{3,}|\[[ xX]\](?:[ \t]|$))/.test(rest)) return indent;
  if (/^[-+*](?:[ \t]|$)/.test(rest)) return indent;
  if (/^(?:=+|-+)[ \t]*$/.test(rest)) return indent;
  const ordered = /^\d{1,9}[.)](?:[ \t]|$)/.exec(rest);
  if (ordered) return indent + ordered[0].search(/[.)]/);
  return -1;
}

export interface EscapeOptions {
  /** The text begins a line (first in its block, or after a hard break). */
  lineStart: boolean;
  /** The text is a link label: brackets always need escaping. */
  inLink: boolean;
}

/**
 * Escapes plain text for markdown, only where needed: a character is escaped when, in its
 * context, it could start or end markdown syntax (emphasis, code, links, HTML, entities, block
 * markers at a line start). `user_id`, `2 * 3`, `array[0]`, `R&D`, `a < b` and `C:\Users` stay as
 * they are. Neighbours outside the text node are unknown, so the edges are treated cautiously.
 */
export function escapeMarkdownText(text: string, options: EscapeOptions): string {
  const escapeAt = new Set<number>();

  // Block markers at the start of each line.
  let offset = 0;
  text.split('\n').forEach((line, index) => {
    if (index > 0 || options.lineStart) {
      const at = lineStartEscape(line);
      if (at >= 0) escapeAt.add(offset + at);
    }
    offset += line.length + 1;
  });

  const startBoundary: Neighbour = options.lineStart ? 'space' : 'other';
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '*' || char === '_' || char === '~') {
      let end = i;
      while (text.charAt(end) === char) end += 1;
      const before = classify(i === 0 ? undefined : text.charAt(i - 1), startBoundary);
      const after = classify(end === text.length ? undefined : text.charAt(end), 'other');
      const spaced = before === 'space' && after === 'space';
      const inWord = before === 'word' && after === 'word';
      if (!(spaced || (char === '_' && inWord))) {
        for (let k = i; k < end; k += 1) escapeAt.add(k);
      }
      i = end;
      continue;
    }
    const next = text.charAt(i + 1);
    if (char === '`') {
      escapeAt.add(i);
    } else if (char === '\\') {
      if (next === '' || ASCII_PUNCTUATION.test(next)) escapeAt.add(i);
    } else if (char === '<') {
      if (/[A-Za-z/!?]/.test(next)) escapeAt.add(i);
    } else if (char === '&') {
      if (ENTITY_AT.test(text.slice(i, i + 40))) escapeAt.add(i);
    } else if (char === '[') {
      const close = text.indexOf(']', i + 1);
      const follower = close === -1 ? '' : text.charAt(close + 1);
      if (options.inLink || next === '^' || close === -1 || /[([:]/.test(follower)) {
        escapeAt.add(i);
      }
    } else if (char === ']') {
      if (options.inLink) escapeAt.add(i);
    }
    i += 1;
  }

  let result = '';
  for (let k = 0; k < text.length; k += 1) {
    result += escapeAt.has(k) ? `\\${text.charAt(k)}` : text.charAt(k);
  }
  return result;
}

/** A named or numeric entity in markdown source; group 1 is any backslashes before it. */
const ENTITY_PATTERN = /(\\*)&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const decodedEntities = new Map<string, string | null>();

function decodeEntity(entity: string): string | null {
  const cached = decodedEntities.get(entity);
  if (cached !== undefined) return cached;
  const decoded = new DOMParser().parseFromString(`<body>${entity}</body>`, 'text/html').body
    .textContent;
  const value = decoded && decoded !== entity ? decoded : null;
  decodedEntities.set(entity, value);
  return value;
}

/**
 * Decodes HTML entities that stand for non-ASCII characters (`&copy;`, `&#8212;`), outside code.
 * The editor has no notion of entities, so without this `x &copy; y` would come back as the
 * literal text "&copy;". ASCII entities are left alone: the parser already decodes the ones that
 * matter (`&amp;`, `&lt;`, …) and the others could turn into markdown syntax.
 */
export function decodeEntities(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !line.includes('&')) return line;
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(ENTITY_PATTERN, (match: string, slashes: string, body: string) => {
                if (slashes.length % 2 === 1) return match;
                const char = decodeEntity(`&${body};`);
                return char && (char.codePointAt(0) ?? 0) > 127 ? `${slashes}${char}` : match;
              }),
        )
        .join('');
    })
    .join('\n');
}

function isTextInCode(node: JSONContent, parent: JSONContent | undefined): boolean {
  return parent?.type === 'codeBlock' || (node.marks ?? []).some((mark) => mark.type === 'code');
}

/** Mentions and raw chips as the text they stand for, keeping their marks. */
function atomAsText(node: JSONContent): JSONContent {
  const attrs = node.attrs ?? {};
  const text =
    node.type === 'mention'
      ? formatMention(attrs.kind === 'role' ? 'role' : 'user', String(attrs.id ?? ''))
      : String(attrs.markdown ?? '');
  return { type: 'text', text, marks: node.marks, [VERBATIM]: true };
}

/** The document as it is serialized: atoms become marked text, empty paragraphs are dropped. */
function prepareForSerialization(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content = node.content.flatMap((child, index): JSONContent[] => {
    if (child.type && INLINE_ATOMS.has(child.type)) return [atomAsText(child)];
    const isEmptyParagraph = child.type === 'paragraph' && !child.content?.length;
    if (isEmptyParagraph && !(index === 0 && node.type && NEEDS_FIRST_PARAGRAPH.has(node.type))) {
      return [];
    }
    return [prepareForSerialization(child)];
  });
  return { ...node, content };
}

/** A mention inside a link is just link text (MarkdownView renders it so too). */
function unlinkMentions(node: JSONContent): JSONContent {
  if (!node.content) return node;
  return {
    ...node,
    content: node.content.map((child) => {
      const linked = (child.marks ?? []).some((mark) => mark.type === 'link');
      if (child.type === 'mention' && linked) {
        const attrs = child.attrs ?? {};
        const kind: MentionKind = attrs.kind === 'role' ? 'role' : 'user';
        return {
          type: 'text',
          text: formatMention(kind, String(attrs.id ?? '')),
          marks: child.marks,
        };
      }
      return unlinkMentions(child);
    }),
  };
}

type ManagerOptions = ConstructorParameters<typeof MarkdownManager>[0];

export class BatonMarkdownManager extends MarkdownManager {
  constructor(options: ManagerOptions) {
    super(options);
    const internals = this as unknown as Record<string, unknown>;
    for (const name of ['encodeTextForMarkdown', 'applyMarkToContent']) {
      if (typeof internals[name] !== 'function') {
        throw new Error(`@tiptap/markdown changed: MarkdownManager.${name} no longer exists`);
      }
    }
    Object.assign(this, {
      encodeTextForMarkdown: (text: string, node: JSONContent, parent?: JSONContent): string => {
        if ((node as Record<string, unknown>)[VERBATIM] === true || isTextInCode(node, parent)) {
          return text;
        }
        const siblings = parent?.content ?? [];
        const index = siblings.indexOf(node);
        const lineStart = index === 0 || siblings[index - 1]?.type === 'hardBreak';
        const inLink = (node.marks ?? []).some((mark) => mark.type === 'link');
        return escapeMarkdownText(text, { lineStart, inLink });
      },
      applyMarkToContent: (
        markType: string,
        content: JSONContent[],
        attrs?: Record<string, unknown>,
      ): JSONContent[] => this.applyMark(markType, content, attrs),
    });
  }

  /** Like the library's version, but inline atoms (mentions, raw chips) take the mark too. */
  private applyMark(
    markType: string,
    content: JSONContent[],
    attrs?: Record<string, unknown>,
  ): JSONContent[] {
    const mark = attrs ? { type: markType, attrs } : { type: markType };
    return content.map((node) => {
      if (node.type === 'text' || (node.type && INLINE_ATOMS.has(node.type))) {
        return { ...node, marks: [...(node.marks ?? []), mark] };
      }
      return {
        ...node,
        content: node.content ? this.applyMark(markType, node.content, attrs) : undefined,
      };
    });
  }

  override parse(markdown: string): JSONContent {
    return unlinkMentions(super.parse(decodeEntities(markdown)));
  }

  override serialize(doc: JSONContent): string {
    return super.serialize(prepareForSerialization(doc));
  }
}

/** The Markdown extension, with BatonMarkdownManager in place of the stock manager. */
export const BatonMarkdown = Markdown.extend({
  onBeforeCreate() {
    const manager = new BatonMarkdownManager({
      indentation: this.options.indentation,
      marked: this.options.marked,
      markedOptions: this.options.markedOptions,
      extensions: this.editor.extensionManager.baseExtensions,
    });
    this.storage.manager = manager;
    this.editor.markdown = manager;
    this.editor.getMarkdown = () => manager.serialize(this.editor.getJSON());

    // As in the stock extension: initial markdown content is parsed here, by this manager.
    const { content, contentType } = this.editor.options;
    if (!contentType || assumeContentType(content, contentType) !== 'markdown') return;
    if (typeof content !== 'string') {
      throw new Error('[markdown] contentType "markdown" needs the initial content as a string');
    }
    const json = manager.parse(content);
    if (json.content?.length) this.editor.options.content = json;
  },
});
