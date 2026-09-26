import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import type { ReplyParentType } from '@shared/constants';
import { attachmentSchema, type Attachment } from '@shared/schemas/core';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { Kbd } from '@web/components/common/Kbd';
import { Spinner } from '@web/components/common/Spinner';
import { RichTextEditor, type RichTextEditorHandle } from '@web/components/editor/RichTextEditor';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { useTeamAccess } from '@web/lib/permissions';
import { useCreateReply } from './queries';

export interface ReplyComposerProps {
  parentType: ReplyParentType;
  parentId: string;
  teamId: string;
  placeholder?: string;
  onSent?: () => void;
}

// ---------------------------------------------------------------------------------------------
// Drafts: an unsent reply survives leaving the page (links, Back, reload) in this tab
// ---------------------------------------------------------------------------------------------

const draftSchema = z.object({ body: z.string(), attachments: z.array(attachmentSchema) });
type Draft = z.infer<typeof draftSchema>;

const draftKey = (parentType: ReplyParentType, parentId: string) =>
  `baton:reply-draft:${parentType}:${parentId}`;

/** The saved draft for a thread (sessionStorage, so it stays in this tab and this session). */
function readReplyDraft(parentType: ReplyParentType, parentId: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(parentType, parentId));
    if (!raw) return null;
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeReplyDraft(parentType: ReplyParentType, parentId: string, draft: Draft): void {
  try {
    const key = draftKey(parentType, parentId);
    if (!draft.body.trim() && draft.attachments.length === 0) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage full or disabled: the draft lasts as long as the page.
  }
}

/** Reply box with mentions, uploads and Ctrl/Cmd+Enter to send. Hidden without `REPLY`. */
export function ReplyComposer(props: ReplyComposerProps) {
  // A fresh composer (and draft) per thread.
  return <Composer key={`${props.parentType}:${props.parentId}`} {...props} />;
}

function Composer({
  parentType,
  parentId,
  teamId,
  placeholder = 'Write a reply… Type / for blocks, @ to mention.',
  onSent,
}: ReplyComposerProps) {
  const access = useTeamAccess(teamId);
  const editor = useRef<RichTextEditorHandle>(null);
  const [saved] = useState(() => readReplyDraft(parentType, parentId));
  const [body, setBody] = useState(saved?.body ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(saved?.attachments ?? []);
  const create = useCreateReply(parentType, parentId);
  // Following a link away from the thread used to discard the text silently (UX-13).
  useEffect(() => {
    writeReplyDraft(parentType, parentId, { body, attachments });
  }, [parentType, parentId, body, attachments]);

  if (access.isMember && !access.has('REPLY')) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
        You don’t have permission to reply here.
      </p>
    );
  }

  const send = () => {
    const text = body.trim();
    if (!text || create.isPending) return;
    // Forget the saved draft now: if the viewer leaves before the reply is posted, coming back
    // must not offer the posted text again. A failed send saves it back.
    writeReplyDraft(parentType, parentId, { body: '', attachments: [] });
    create.mutate(
      { body: text, attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined },
      {
        onError: () => writeReplyDraft(parentType, parentId, { body, attachments }),
        onSuccess: () => {
          setBody('');
          setAttachments([]);
          editor.current?.clear();
          toast.success('Reply posted');
          onSent?.();
        },
      },
    );
  };

  const addAttachment = (attachment: Attachment) =>
    setAttachments((current) => [...current, attachment]);

  return (
    <div className="space-y-2">
      <RichTextEditor
        ref={editor}
        value={body}
        onChange={setBody}
        variant="compact"
        placeholder={placeholder}
        teamId={teamId}
        onAttach={addAttachment}
        onSubmit={send}
        label="Reply"
      />
      <AttachmentList
        attachments={attachments}
        removeMode="draft"
        canDelete={() => true}
        onDelete={(attachment) =>
          setAttachments((current) => current.filter((item) => item.id !== attachment.id))
        }
      />
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <AttachmentUploader teamId={teamId} onUploaded={addAttachment} />
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline-flex sm:items-center sm:gap-1">
            <Kbd keys="mod+enter" /> to send
          </span>
          <Button size="sm" onClick={send} disabled={!body.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}
