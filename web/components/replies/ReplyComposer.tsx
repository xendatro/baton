import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ReplyParentType } from '@shared/constants';
import type { Attachment } from '@shared/schemas/core';
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

/** Reply box with mentions, uploads and Ctrl/Cmd+Enter to send. Hidden without `REPLY`. */
export function ReplyComposer({
  parentType,
  parentId,
  teamId,
  placeholder = 'Write a reply… Type / for blocks, @ to mention.',
  onSent,
}: ReplyComposerProps) {
  const access = useTeamAccess(teamId);
  const editor = useRef<RichTextEditorHandle>(null);
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const create = useCreateReply(parentType, parentId);

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
    create.mutate(
      { body: text, attachmentIds: attachments.length ? attachments.map((a) => a.id) : undefined },
      {
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
