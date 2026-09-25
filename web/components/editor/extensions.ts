import type { Extensions } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { createMention, type MentionSource } from './mention';
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
    TableKit.configure({ table: { resizable: false } }),
    createMention(options.mentionSource ?? null),
    Markdown.configure({ indentation: { style: 'space', size: 2 } }),
  ];
  if (options.placeholder) {
    extensions.push(Placeholder.configure({ placeholder: options.placeholder }));
  }
  if (options.slashCommands ?? true) {
    extensions.push(SlashCommands.configure({ images: options.images ?? false }));
  }
  return extensions;
}
