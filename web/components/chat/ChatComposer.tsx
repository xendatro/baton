import { CornerUpLeftIcon, SendHorizontalIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplyParentType } from '@shared/constants';
import { agentUsername } from '@shared/principals';
import type { Attachment, Reply } from '@shared/schemas/core';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { AgentConnectionNotice } from '@web/components/common/AgentConnectionNotice';
import { Spinner } from '@web/components/common/Spinner';
import { RichTextEditor, type RichTextEditorHandle } from '@web/components/editor/RichTextEditor';
import type { MentionAgent } from '@web/components/editor/mention';
import { useCreateReply } from '@web/components/replies/queries';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { useMe, useSession } from '@web/lib/auth';
import { findMentions } from '@web/lib/mentions';
import { useProjectAccess } from '@web/lib/permissions';
import { readReplyDraft, writeReplyDraft } from '@web/lib/replyDrafts';
import { excerpt } from './chatLayout';

export interface ChatComposerProps {
  parentType: ReplyParentType;
  parentId: string;
  teamId: string;
  projectId: string;
  /** "Message API-12". */
  placeholder: string;
  /** Agents of the chat, suggested first after `@`. */
  mentionAgents: readonly MentionAgent[];
  /** The message being answered (the reply-to chip). */
  replyTo: Reply | null;
  onCancelReply: () => void;
  /** Each keystroke (throttled "is typing" pings). */
  onType: () => void;
  onSent: (reply: Reply) => void;
}

/**
 * The chat's message box, pinned under the stream: Enter sends, Shift+Enter makes a new line,
 * `@` mentions people and agents, pasted or dropped images go inline, other files (videos too)
 * are attached. A message may be only files. Unsent text is kept as a draft.
 */
export function ChatComposer({
  parentType,
  parentId,
  teamId,
  projectId,
  placeholder,
  mentionAgents,
  replyTo,
  onCancelReply,
  onType,
  onSent,
}: ChatComposerProps) {
  const access = useProjectAccess(teamId, projectId);
  const editor = useRef<RichTextEditorHandle>(null);
  const userId = useSession().data?.user.id ?? null;
  const [saved] = useState(() => (userId ? readReplyDraft(userId, parentType, parentId) : null));
  const [body, setBody] = useState(saved?.body ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(saved?.attachments ?? []);
  const create = useCreateReply(parentType, parentId);
  const ownUsername = useMe().data?.user.username ?? null;
  const ownAgent = ownUsername ? agentUsername(ownUsername).toLowerCase() : null;
  const mentionsOwnAgent = useMemo(
    () =>
      ownAgent !== null &&
      findMentions(body).some((mention) => mention.kind === 'user' && mention.id === ownAgent),
    [body, ownAgent],
  );

  useEffect(() => {
    if (userId) writeReplyDraft(userId, parentType, parentId, { body, attachments });
  }, [userId, parentType, parentId, body, attachments]);

  // Answering a message puts the cursor in the box.
  useEffect(() => {
    if (replyTo) editor.current?.focus();
  }, [replyTo]);

  if (access.isMember && !access.has('REPLY')) {
    return (
      <p className="rounded-lg border border-dashed px-3 py-3 text-center text-sm text-muted-foreground">
        You don’t have permission to send messages here.
      </p>
    );
  }

  const send = () => {
    const text = editor.current?.getMarkdown().trim() ?? body.trim();
    if ((!text && attachments.length === 0) || create.isPending) return;
    const sent = { body, attachments };
    create.mutate(
      {
        body: text,
        attachmentIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        parentReplyId: replyTo?.id,
      },
      {
        onError: () => {
          if (userId) writeReplyDraft(userId, parentType, parentId, sent);
        },
        onSuccess: (reply) => {
          setBody('');
          setAttachments([]);
          editor.current?.clear();
          onSent(reply);
        },
      },
    );
  };

  const canSend = (body.trim().length > 0 || attachments.length > 0) && !create.isPending;

  return (
    <div className="space-y-1.5" data-testid="chat-composer">
      {replyTo ? (
        <div
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs"
          data-testid="reply-to-chip"
        >
          <CornerUpLeftIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="shrink-0 text-muted-foreground">Replying to</span>
          <span className="shrink-0 font-medium">{replyTo.author?.name ?? 'Deleted user'}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {excerpt(replyTo.body, 80)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Cancel reply"
            onClick={onCancelReply}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <AttachmentList
        attachments={attachments}
        removeMode="draft"
        canDelete={() => true}
        onDelete={(attachment) =>
          setAttachments((current) => current.filter((item) => item.id !== attachment.id))
        }
      />
      <div className="flex items-end gap-2">
        <AttachmentUploader
          teamId={teamId}
          iconOnly
          onUploaded={(attachment) => setAttachments((current) => [...current, attachment])}
          className="shrink-0"
        />
        <RichTextEditor
          ref={editor}
          value={body}
          onChange={setBody}
          onType={onType}
          variant="compact"
          placeholder={placeholder}
          teamId={teamId}
          mentionAgents={mentionAgents}
          onAttach={(attachment) => setAttachments((current) => [...current, attachment])}
          onSubmit={send}
          submitOnEnter
          label="Message"
          className="min-w-0 flex-1 [&_.markdown]:max-h-60 [&_.markdown]:min-h-9 [&_.markdown]:overflow-y-auto"
        />
        <Button
          size="icon"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
          title="Send (Enter)"
          className="shrink-0"
        >
          {create.isPending ? <Spinner /> : <SendHorizontalIcon aria-hidden="true" />}
        </Button>
      </div>
      <p className="hidden text-[11px] text-muted-foreground sm:block">
        Enter to send · Shift+Enter for a new line · @ to mention people and agents
      </p>
      {mentionsOwnAgent ? <AgentConnectionNotice projectId={projectId} variant="inline" /> : null}
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(create.error)}
        </p>
      ) : null}
    </div>
  );
}
