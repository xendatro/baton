import type { Extensions } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { renderTableToMarkdown, Table, TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { BatonMarkdown } from './markdownManager';
import { createMention, type MentionSource } from './mention';
import { RawBlock, RawInline } from './rawMarkdown';
import { SlashCommands } from './slashCommands';

/** Syntax highlighting for code blocks: highlight.js's common languages (~35). */
export const lowlight = createLowlight(common);

export interface EditorExtensionOptions {
  placeholder?: string;
  /** Candidates for `@` mentions; null keeps mentions parseable but offers no suggestions. */
  mentionSource?: MentionSource | null;
  /** Adds the `/` menu (default true). */
  slashCommands?: boolean;
  /** Offers the slash menu's Image command (uploads must be possible). */
  images?: boolean;
}

/**
 * Escapes every `|` in a table cell's markdown (text, code spans and link targets alike), unless
 * it already is escaped: GFM splits cells on any other pipe, even inside code spans, so a cell
 * holding x|y or the code a || b would otherwise break the table.
 */
export function escapeCellPipes(markdown: string): string {
  return markdown.replace(/(\\*)\|/g, (match: string, slashes: string) =>
    slashes.length % 2 === 1 ? match : `${slashes}\\|`,
  );
}

/** Tables whose cells escape their pipes (see escapeCellPipes). */
const BatonTable = Table.extend({
  renderMarkdown: (node, helpers) =>
    renderTableToMarkdown(node, {
      ...helpers,
      renderChildren: (nodes, separator) =>
        escapeCellPipes(helpers.renderChildren(nodes, separator)),
    }),
});

/**
 * Every extension of the rich-text editor. Markdown is the storage format, so each node here must
 * round-trip through `@tiptap/markdown`; underline is disabled because markdown can't express it.
 */
export function createEditorExtensions(options: EditorExtensionOptions = {}): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({
      codeBlock: false,
      underline: false,
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: false }),
    BatonTable.configure({ resizable: false }),
    createMention(options.mentionSource ?? null),
    RawInline,
    RawBlock,
    BatonMarkdown.configure({ indentation: { style: 'space', size: 2 } }),
  ];
  if (options.placeholder) {
    extensions.push(Placeholder.configure({ placeholder: options.placeholder }));
  }
  if (options.slashCommands ?? true) {
    extensions.push(SlashCommands.configure({ images: options.images ?? false }));
  }
  return extensions;
}
