import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { toast } from 'sonner';
import type { Attachment } from '@shared/schemas/core';
import {
  INLINE_IMAGE_TYPES,
  isInlineImage,
  uploadAttachment,
} from '@web/components/attachments/upload';
import { errorMessage } from '@web/lib/api';
import { useConfig } from '@web/lib/auth';
import { cn } from '@web/lib/utils';
import { BubbleToolbar } from './BubbleToolbar';
import { createEditorExtensions } from './extensions';
import { normalizeMarkdown } from './markdown';
import type { MentionAgent } from './mention';
import { useMentionSource } from './useMentionSource';

export interface RichTextEditorHandle {
  focus: () => void;
  /** Empties the document (e.g. after a reply is sent). */
  clear: () => void;
  getMarkdown: () => string;
  /** Opens the file picker and inserts the chosen images. */
  pickImage: () => void;
}

export interface RichTextEditorProps {
  /** Markdown. */
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** `compact` for replies and short fields, `full` for issue/task bodies and READMEs. */
  variant?: 'compact' | 'full';
  autoFocus?: boolean;
  /** Ctrl/Cmd+Enter (and plain Enter with `submitOnEnter`). */
  onSubmit?: () => void;
  /**
   * Chat style: Enter sends (`onSubmit`) and Shift+Enter makes a new line. An open `@` or `/`
   * menu keeps Enter for picking its item.
   */
  submitOnEnter?: boolean;
  /** Every change of the text by the person typing (e.g. to ping "is typing"). */
  onType?: () => void;
  /** Enables `@` mentions and uploads (pasted/dropped images and files) for this team. */
  teamId?: string | null;
  /** Agents of the thread (BAT-12), suggested above the team's people. Needs `teamId`. */
  mentionAgents?: readonly MentionAgent[];
  /**
   * Receives non-image files uploaded by paste or drop (to show in an attachment list). Without
   * it they are inserted as links.
   */
  onAttach?: (attachment: Attachment) => void;
  /** Read-only when false. */
  editable?: boolean;
  /** Accessible name of the editing area. */
  label?: string;
  className?: string;
  ref?: Ref<RichTextEditorHandle>;
}

/** Is an `@` mention or `/` command menu open (a suggestion plugin is active)? */
function suggestionOpen(view: EditorView): boolean {
  return view.state.plugins.some((plugin) => {
    const state: unknown = plugin.getState(view.state);
    return (
      typeof state === 'object' && state !== null && 'active' in state && state.active === true
    );
  });
}

function filesFrom(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : [];
}

/**
 * Notion-style markdown editor (Tiptap): markdown shortcuts, `/` block menu, bubble toolbar,
 * `@` mentions, highlighted code blocks, task lists, tables, and image/file uploads by paste,
 * drop or the `/image` command. `value`/`onChange` are markdown.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder = 'Write something… Type / for blocks, @ to mention.',
  variant = 'full',
  autoFocus = false,
  onSubmit,
  submitOnEnter = false,
  onType,
  teamId,
  mentionAgents,
  onAttach,
  editable = true,
  label = 'Editor',
  className,
  ref,
}: RichTextEditorProps) {
  const config = useConfig();
  const mentionSource = useMentionSource(teamId, mentionAgents);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The live editor for the paste/drop handlers, which are created with the editor itself. */
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef(value);
  const callbacks = useRef({ onChange, onSubmit, onAttach, onType, submitOnEnter });
  const uploadContext = useRef({ teamId, maxUploadMb: config.data?.maxUploadMb });
  useEffect(() => {
    callbacks.current = { onChange, onSubmit, onAttach, onType, submitOnEnter };
    uploadContext.current = { teamId, maxUploadMb: config.data?.maxUploadMb };
  });

  const canUpload = Boolean(teamId);

  const extensions = useMemo(
    () => createEditorExtensions({ placeholder, mentionSource, images: canUpload }),
    [placeholder, mentionSource, canUpload],
  );

  /** Uploads files and inserts them at `pos` (images inline, other files via onAttach or a link). */
  const uploadFiles = (editor: Editor, files: File[], pos: number) => {
    const { teamId: team, maxUploadMb } = uploadContext.current;
    if (!team) return;
    for (const file of files) {
      const toastId = toast.loading(`Uploading ${file.name}…`);
      uploadAttachment(file, {
        teamId: team,
        maxUploadMb,
        onProgress: (fraction) =>
          toast.loading(`Uploading ${file.name}… ${Math.round(fraction * 100)}%`, { id: toastId }),
      })
        .then((attachment) => {
          toast.dismiss(toastId);
          if (editor.isDestroyed) return;
          const at = Math.min(pos, editor.state.doc.content.size);
          if (attachment.isImage && isInlineImage(file)) {
            editor
              .chain()
              .focus()
              .insertContentAt(at, {
                type: 'image',
                attrs: { src: attachment.url, alt: attachment.filename },
              })
              .run();
          } else if (callbacks.current.onAttach) {
            callbacks.current.onAttach(attachment);
          } else {
            editor
              .chain()
              .focus()
              .insertContentAt(at, {
                type: 'text',
                text: attachment.filename,
                marks: [{ type: 'link', attrs: { href: attachment.url } }],
              })
              .run();
          }
        })
        .catch((error: unknown) => {
          toast.error(errorMessage(error, `Couldn’t upload ${file.name}.`), { id: toastId });
        });
    }
  };

  const editor = useEditor(
    {
      extensions,
      content: value,
      contentType: 'markdown',
      editable,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: cn(
            'markdown min-w-0 outline-none',
            variant === 'full' ? 'min-h-40 px-3 py-2.5' : 'min-h-16 px-3 py-2',
          ),
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label,
        },
        handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
          if (event.key !== 'Enter') return false;
          const submit = callbacks.current.onSubmit;
          if (!submit) return false;
          const chord = event.metaKey || event.ctrlKey;
          const plain =
            callbacks.current.submitOnEnter &&
            !event.shiftKey &&
            !event.altKey &&
            !event.isComposing &&
            !suggestionOpen(view);
          if (!chord && !plain) return false;
          event.preventDefault();
          submit();
          return true;
        },
        handlePaste: (view: EditorView, event: ClipboardEvent) => {
          const files = filesFrom(event.clipboardData?.files);
          if (files.length === 0 || !uploadContext.current.teamId || !editorRef.current) {
            return false;
          }
          event.preventDefault();
          uploadFiles(editorRef.current, files, view.state.selection.from);
          return true;
        },
        handleDrop: (view: EditorView, event: DragEvent, _slice: unknown, moved: boolean) => {
          const files = filesFrom(event.dataTransfer?.files);
          if (moved || files.length === 0 || !uploadContext.current.teamId || !editorRef.current) {
            return false;
          }
          event.preventDefault();
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          uploadFiles(editorRef.current, files, coords?.pos ?? view.state.selection.from);
          return true;
        },
      },
      onCreate: ({ editor: created }) => {
        created.storage.slashCommands.pickImage = () => fileInput.current?.click();
      },
      onUpdate: ({ editor: current }) => {
        const markdown = normalizeMarkdown(current.getMarkdown());
        if (markdown === lastEmitted.current) return;
        lastEmitted.current = markdown;
        callbacks.current.onChange(markdown);
        callbacks.current.onType?.();
      },
    },
    [extensions],
  );
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // External value changes (reset after submit, switching items) replace the document.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus('end'),
      clear: () => {
        lastEmitted.current = '';
        editor?.commands.clearContent(false);
      },
      getMarkdown: () => (editor ? normalizeMarkdown(editor.getMarkdown()) : lastEmitted.current),
      pickImage: () => fileInput.current?.click(),
    }),
    [editor],
  );

  return (
    <div
      className={cn(
        'relative rounded-md border border-input bg-transparent text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30',
        !editable && 'opacity-60',
        className,
      )}
      data-variant={variant}
    >
      <EditorContent editor={editor} />
      {editor && editable ? <BubbleToolbar editor={editor} /> : null}
      {canUpload ? (
        <input
          ref={fileInput}
          type="file"
          accept={[...INLINE_IMAGE_TYPES].join(',')}
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = filesFrom(event.target.files);
            event.target.value = '';
            if (editor && files.length) uploadFiles(editor, files, editor.state.selection.from);
          }}
        />
      ) : null}
    </div>
  );
}
