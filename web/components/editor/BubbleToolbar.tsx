import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  BoldIcon,
  CheckIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnlinkIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Input } from '@web/components/ui/input';
import { cn } from '@web/lib/utils';
import { normalizeHref } from './links';

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}

function ToolButton({ icon: Icon, label, active = false, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        active && 'bg-accent text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

/** Floating toolbar over a text selection: bold, italic, strike, code, link. */
export function BubbleToolbar({ editor }: { editor: Editor }) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState('');
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      strike: current.isActive('strike'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      href: (current.getAttributes('link').href as string | undefined) ?? '',
    }),
  });

  const applyLink = () => {
    const normalized = normalizeHref(href);
    const chain = editor.chain().focus().extendMarkRange('link');
    if (normalized) chain.setLink({ href: normalized }).run();
    else chain.unsetLink().run();
    setLinkMode(false);
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: current, state: editorState }) =>
        current.isEditable &&
        !editorState.selection.empty &&
        !current.isActive('codeBlock') &&
        !current.isActive('image')
      }
      options={{ placement: 'top', offset: 6, onHide: () => setLinkMode(false) }}
      className="z-50 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
    >
      {linkMode ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <Input
            value={href}
            onChange={(event) => setHref(event.target.value)}
            placeholder="Paste a link…"
            aria-label="Link URL"
            className="h-7 w-56 text-sm"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setLinkMode(false);
                editor.commands.focus();
              }
            }}
          />
          <ToolButton icon={CheckIcon} label="Apply link" onClick={applyLink} />
        </form>
      ) : (
        <>
          <ToolButton
            icon={BoldIcon}
            label="Bold"
            active={state.bold}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <ToolButton
            icon={ItalicIcon}
            label="Italic"
            active={state.italic}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <ToolButton
            icon={StrikethroughIcon}
            label="Strikethrough"
            active={state.strike}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <ToolButton
            icon={CodeIcon}
            label="Inline code"
            active={state.code}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />
          <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" />
          {state.link ? (
            <ToolButton
              icon={UnlinkIcon}
              label="Remove link"
              active
              onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
            />
          ) : null}
          <ToolButton
            icon={LinkIcon}
            label={state.link ? 'Edit link' : 'Add link'}
            onClick={() => {
              setHref(state.href);
              setLinkMode(true);
            }}
          />
        </>
      )}
    </BubbleMenu>
  );
}
