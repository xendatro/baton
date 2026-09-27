import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ReplyParentType } from '@shared/constants';
import type { Attachment, Reply } from '@shared/schemas/core';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { Kbd } from '@web/components/common/Kbd';
import { Spinner } from '@web/components/common/Spinner';
import { RichTextEditor, type RichTextEditorHandle } from '@web/components/editor/RichTextEditor';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { useSession } from '@web/lib/auth';
import { useTeamAccess } from '@web/lib/permissions';
import { readReplyDraft, writeReplyDraft, type ReplyDraft } from '@web/lib/replyDrafts';
import { useCreateReply, useReplies } from './queries';
import { threadAgents, type ThreadWrite } from './threadAgents';

export interface ReplyComposerProps {
  parentType: ReplyParentType;
  parentId: string;
  teamId: string;
  /** The task or issue replied to: its agent, and those of its replies, can be `@`-mentioned. */
  item?: ThreadWrite;
  placeholder?: string;
  /** Answer this reply (BAT-13) instead of posting a top-level comment. */
  parentReplyId?: string;
  /** Accessible name of the editor (default "Reply"). */
  label?: string;
  autoFocus?: boolean;
  /** Shows a Cancel button (inline answers). */
  onCancel?: () => void;
  onSent?: (reply: Reply) => void;
}

/** Reply box with mentions, uploads and Ctrl/Cmd+Enter to send. Hidden without `REPLY`. */
export function ReplyComposer(props: ReplyComposerProps) {
  // A fresh composer (and draft) per thread, and per answered reply.
  return (
    <Composer
      key={`${props.parentType}:${props.parentId}:${props.parentReplyId ?? ''}`}
      {...props}
    />
  );
}

function Composer({
  parentType,
  parentId,
  teamId,
  item,
  placeholder = 'Write a reply… Type / for blocks, @ to mention.',
  parentReplyId,
  label = 'Reply',
  autoFocus,
  onCancel,
  onSent,
}: ReplyComposerProps) {
  const access = useTeamAccess(teamId);
  const editor = useRef<RichTextEditorHandle>(null);
  // Unsent text survives leaving the thread (UX-13); drafts belong to the signed-in user.
  const userId = useSession().data?.user.id ?? null;
  const saveDraft = (draft: ReplyDraft) => {
    if (userId) writeReplyDraft(userId, parentType, parentId, draft, parentReplyId);
  };
  const [saved] = useState(() =>
    userId ? readReplyDraft(userId, parentType, parentId, parentReplyId) : null,
  );
  const [body, setBody] = useState(saved?.body ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(saved?.attachments ?? []);
  const create = useCreateReply(parentType, parentId);
  // BAT-12: the thread's agents lead the @ suggestions (the timeline already loads the replies).
  const replies = useReplies(parentType, parentId).data;
  const agents = useMemo(
    () => threadAgents([...(item ? [item] : []), ...(replies?.items ?? [])]),
    [item, replies],
  );
  // Following a link away from the thread used to discard the text silently (UX-13).
  useEffect(() => {
    if (userId) writeReplyDraft(userId, parentType, parentId, { body, attachments }, parentReplyId);
  }, [userId, parentType, parentId, parentReplyId, body, attachments]);

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
    saveDraft({ body: '', attachments: [] });
    create.mutate(
      {
        body: text,
        attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined,
        parentReplyId,
      },
      {
        onError: () => saveDraft({ body, attachments }),
        onSuccess: (reply) => {
          setBody('');
          setAttachments([]);
          editor.current?.clear();
          toast.success('Reply posted');
          onSent?.(reply);
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
        mentionAgents={agents}
        onAttach={addAttachment}
        onSubmit={send}
        label={label}
        autoFocus={autoFocus}
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
          {onCancel ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Cancelling discards the answer.
                saveDraft({ body: '', attachments: [] });
                onCancel();
              }}
            >
              Cancel
            </Button>
          ) : null}
          <Button size="sm" onClick={send} disabled={!body.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Reply
          </Button>
        </div>
      </div>
    </div>
  );
}
