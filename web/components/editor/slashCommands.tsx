import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { Suggestion } from '@tiptap/suggestion';
import {
  CodeSquareIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  TableIcon,
  type LucideIcon,
} from 'lucide-react';
import type { SuggestionItem } from './SuggestionMenu';
import { suggestionRenderer } from './suggestionRenderer';

/** The `/` menu (SPEC §1.13): headings, lists, to-do list, quote, code block, divider, image, table. */

export interface SlashCommand extends SuggestionItem {
  title: string;
  description: string;
  icon: LucideIcon;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

export interface SlashCommandOptions {
  /** Offers the Image command (the editor must set `storage.slashCommands.pickImage`). */
  images: boolean;
}

export interface SlashCommandStorage {
  /** Opens the editor's image file picker; set by RichTextEditor once it has mounted. */
  pickImage: (() => void) | null;
}

declare module '@tiptap/core' {
  interface Storage {
    slashCommands: SlashCommandStorage;
  }
}

function slashCommands(options: SlashCommandOptions): SlashCommand[] {
  const commands: SlashCommand[] = [
    {
      key: 'text',
      title: 'Text',
      description: 'Plain paragraph',
      icon: PilcrowIcon,
      keywords: 'paragraph p',
      run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
    },
    ...([1, 2, 3] as const).map((level): SlashCommand => ({
      key: `h${level}`,
      title: `Heading ${level}`,
      description: ['Large section heading', 'Medium section heading', 'Small section heading'][
        level - 1
      ] as string,
      icon: [Heading1Icon, Heading2Icon, Heading3Icon][level - 1] as LucideIcon,
      keywords: `h${level} title heading`,
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level }).run(),
    })),
    {
      key: 'bullet',
      title: 'Bulleted list',
      description: 'A simple list',
      icon: ListIcon,
      keywords: 'ul unordered bullet',
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      key: 'ordered',
      title: 'Numbered list',
      description: 'A list with numbers',
      icon: ListOrderedIcon,
      keywords: 'ol ordered number',
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      key: 'todo',
      title: 'To-do list',
      description: 'Checklist of tasks',
      icon: ListChecksIcon,
      keywords: 'task checkbox checklist todo',
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
      key: 'quote',
      title: 'Quote',
      description: 'Blockquote',
      icon: QuoteIcon,
      keywords: 'blockquote citation',
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      key: 'code',
      title: 'Code block',
      description: 'Syntax-highlighted code',
      icon: CodeSquareIcon,
      keywords: 'codeblock snippet pre',
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      key: 'divider',
      title: 'Divider',
      description: 'Horizontal rule',
      icon: MinusIcon,
      keywords: 'hr rule separator line',
      run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      key: 'table',
      title: 'Table',
      description: '3 × 3 table with a header row',
      icon: TableIcon,
      keywords: 'grid columns rows',
      run: (editor, range) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ];
  if (options.images) {
    commands.push({
      key: 'image',
      title: 'Image',
      description: 'Upload an image',
      icon: ImageIcon,
      keywords: 'picture photo upload',
      run: (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        editor.storage.slashCommands.pickImage?.();
      },
    });
  }
  return commands;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase().trim();
  if (!q) return commands;
  return commands.filter(
    (command) => command.title.toLowerCase().includes(q) || command.keywords.includes(q),
  );
}

export const SlashCommands = Extension.create<SlashCommandOptions>({
  name: 'slashCommands',

  addOptions() {
    return { images: false };
  },

  addStorage(): SlashCommandStorage {
    return { pickImage: null };
  },

  addProseMirrorPlugins() {
    const commands = slashCommands(this.options);
    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommands'),
        char: '/',
        allowedPrefixes: [' '],
        items: ({ query }) => filterSlashCommands(commands, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          return $from.parent.type.name !== 'codeBlock';
        },
        render: suggestionRenderer<SlashCommand>({
          label: 'Insert block',
          emptyText: 'No matching blocks.',
          renderItem: (command) => (
            <>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
                <command.icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{command.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {command.description}
                </span>
              </span>
            </>
          ),
        }),
      }),
    ];
  },
});
