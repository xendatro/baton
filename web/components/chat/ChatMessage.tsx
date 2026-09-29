import type { QueryKey } from '@tanstack/react-query';
import { CornerUpLeftIcon, LinkIcon, PencilIcon, SmilePlusIcon, Trash2Icon } from 'lucide-react';
import { lazy, memo, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { QUICK_REACTIONS } from '@shared/constants';
import type { Reply } from '@shared/schemas/core';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { ReactionBar } from '@web/components/reactions/ReactionBar';
import { useReactionMutation } from '@web/components/reactions/queries';
import {
  useDeleteAttachment,
  useDeleteReply,
  useUpdateReply,
} from '@web/components/replies/queries';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { formatDateTime } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { cn } from '@web/lib/utils';
import { copyText } from '@web/pages/teams/clipboard';
import { excerpt, isPlayableVideo, splitAttachments } from './chatLayout';

const EmojiPickerPanel = lazy(() => import('@web/components/reactions/EmojiPickerPanel'));

/** The message a reply answers, as its quoted preview shows it. */
export type QuotedMessage = { kind: 'loaded'; message: Reply } | { kind: 'unknown' } | null;

export interface ChatMessageProps {
  message: Reply;
  /** Continues the previous message's group: no avatar or name. */
  grouped: boolean;
  quoted: QuotedMessage;
  /** The query the message comes from (refreshed after reactions). */
  queryKey: QueryKey;
  /** Absolute link to the message. */
  link: string;
  onReply: (message: Reply) => void;
  onJumpTo: (replyId: string) => void;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayAndTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const time = clockTime(iso);
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`;
}

/**
 * One chat message, Discord style: avatar, name and time on the first message of a group, the
 * text, inline images and videos, other files, reactions, and hover (or focus) actions: react,
 * reply, edit and delete your own, copy link. An answer shows a small quote of the message it
 * answers; clicking it jumps there.
 */
export const ChatMessage = memo(function ChatMessage({
  message,
  grouped,
  quoted,
  queryKey,
  link,
  onReply,
  onJumpTo,
}: ChatMessageProps) {
  const access = useProjectAccess(message.teamId, message.projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const update = useUpdateReply(message.parentType, message.parentId);
  const remove = useDeleteReply(message.parentType, message.parentId);
  const deleteAttachment = useDeleteAttachment();
  const react = useReactionMutation('reply', message.id, queryKey);
  const authorId = message.author?.id;
  const canEdit = access.canEdit(authorId);
  const canDelete = access.canDelete(authorId);
  const canReact = access.has('REPLY');
  const { media, files } = splitAttachments(message);
  const authorName = message.author?.name ?? 'Deleted user';

  const save = () => {
    const body = draft.trim();
    if (!body || update.isPending) return;
    if (body === message.body) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id: message.id, body },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Message edited');
        },
      },
    );
  };

  const addReaction = (emoji: string) => {
    if (message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reactedByMe)) {
      return;
    }
    react.mutate(
      { emoji, remove: false },
      { onError: (error) => toast.error(errorMessage(error, 'Couldn’t add the reaction.')) },
    );
  };

  return (
    <article
      id={`reply-${message.id}`}
      tabIndex={-1}
      data-testid="chat-message"
      aria-label={`${authorName}, ${dayAndTime(message.createdAt)}`}
      className={cn(
        'group/message relative flex scroll-mt-24 gap-3 rounded-md px-2 outline-none target:bg-primary/5 focus-within:bg-muted/40 hover:bg-muted/40',
        grouped ? 'py-0.5' : 'mt-2 pt-1.5 pb-0.5',
      )}
    >
      <div className="w-8 shrink-0">
        {grouped ? (
          <time
            dateTime={message.createdAt}
            title={formatDateTime(message.createdAt)}
            className="block pt-0.5 text-right text-[10px] leading-5 text-muted-foreground opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100"
          >
            {clockTime(message.createdAt)}
          </time>
        ) : (
          <ActorAvatar
            user={message.author}
            agentName={message.via?.agentName}
            keyName={message.via?.keyName}
            size="lg"
            // Beside the name, under the quote of the answered message.
            className={quoted ? 'mt-5' : 'mt-0.5'}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {quoted ? <QuotedPreview quoted={quoted} onJumpTo={onJumpTo} /> : null}
        {grouped ? null : (
          <header className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <UserName user={message.author} via={message.via} />
            <time
              dateTime={message.createdAt}
              title={formatDateTime(message.createdAt)}
              className="text-xs text-muted-foreground"
            >
              {dayAndTime(message.createdAt)}
            </time>
          </header>
        )}
        {editing ? (
          <div className="my-1 space-y-1.5">
            <RichTextEditor
              value={draft}
              onChange={setDraft}
              variant="compact"
              teamId={message.teamId}
              autoFocus
              submitOnEnter
              onSubmit={save}
              label="Edit message"
              className="[&_.markdown]:min-h-9"
            />
            {update.error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(update.error)}
              </p>
            ) : null}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Enter to save ·</span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              {update.isPending ? <Spinner className="size-3" /> : null}
            </div>
          </div>
        ) : message.body ? (
          <div className="text-sm [&_.markdown>*:first-child]:mt-0 [&_.markdown>*:last-child]:mb-0">
            <MarkdownView markdown={message.body} teamId={message.teamId} />
            {message.editedAt ? (
              <span
                className="text-[11px] text-muted-foreground"
                title={`Edited ${formatDateTime(message.editedAt)}`}
              >
                {' '}
                (edited)
              </span>
            ) : null}
          </div>
        ) : null}
        {media.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-2" aria-label="Media">
            {media.map((attachment) => (
              <li key={attachment.id} className="max-w-full">
                {isPlayableVideo(attachment) ? (
                  <video
                    src={attachment.url}
                    controls
                    preload="metadata"
                    aria-label={attachment.filename}
                    className="max-h-80 max-w-full rounded-md border bg-black"
                  />
                ) : (
                  <a
                    href={attachment.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${attachment.filename}`}
                  >
                    <img
                      src={attachment.url}
                      alt={attachment.filename}
                      loading="lazy"
                      className="max-h-80 max-w-full rounded-md border object-contain"
                    />
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {files.length > 0 ? (
          <AttachmentList
            className="mt-1 max-w-xl"
            attachments={files}
            canDelete={(attachment) => access.canDelete(attachment.uploader?.id)}
            onDelete={async (attachment) => {
              await deleteAttachment.mutateAsync(attachment.id);
              toast.success('Attachment moved to Trash');
            }}
          />
        ) : null}
        {message.reactions.length > 0 ? (
          <ReactionBar
            className="mt-1"
            targetType="reply"
            targetId={message.id}
            teamId={message.teamId}
            projectId={message.projectId}
            reactions={message.reactions}
            queryKey={queryKey}
          />
        ) : null}
      </div>

      {editing ? null : (
        <div
          role="toolbar"
          aria-label="Message actions"
          className={cn(
            'absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm',
            'opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 has-[[data-state=open]]:opacity-100',
            '[@media(hover:none)]:opacity-100',
          )}
        >
          {canReact ? (
            <>
              {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React with ${emoji}`}
                  title={`React with ${emoji}`}
                  onClick={() => addReaction(emoji)}
                  className="hidden size-7 items-center justify-center rounded text-sm hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none sm:inline-flex"
                >
                  <span aria-hidden="true">{emoji}</span>
                </button>
              ))}
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Add reaction">
                        <SmilePlusIcon aria-hidden="true" />
                      </Button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Add reaction</TooltipContent>
                </Tooltip>
                <PopoverContent align="end" className="w-auto overflow-hidden p-0">
                  <Suspense
                    fallback={
                      <div className="flex h-[380px] w-[320px] items-center justify-center">
                        <Spinner />
                      </div>
                    }
                  >
                    <EmojiPickerPanel
                      onPick={(emoji) => {
                        setPickerOpen(false);
                        addReaction(emoji);
                      }}
                    />
                  </Suspense>
                </PopoverContent>
              </Popover>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Reply"
                title="Reply"
                onClick={() => onReply(message)}
              >
                <CornerUpLeftIcon aria-hidden="true" />
              </Button>
            </>
          ) : null}
          {canEdit ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit message"
              title="Edit"
              onClick={() => {
                setDraft(message.body);
                setEditing(true);
              }}
            >
              <PencilIcon aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy link to message"
            title="Copy link"
            onClick={() => void copyText(link)}
          >
            <LinkIcon aria-hidden="true" />
          </Button>
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete message"
              title="Delete"
              className="hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete message?"
        description="The message moves to Trash and can be restored for 30 days."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(message.id);
          toast.success('Message deleted');
        }}
      />
    </article>
  );
});

function QuotedPreview({
  quoted,
  onJumpTo,
}: {
  quoted: NonNullable<QuotedMessage>;
  onJumpTo: (replyId: string) => void;
}) {
  if (quoted.kind === 'unknown') {
    return (
      <p className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground italic">
        <CornerUpLeftIcon className="size-3 -scale-x-100" aria-hidden="true" />
        Replying to an earlier message
      </p>
    );
  }
  const { message } = quoted;
  const text =
    excerpt(message.body) || (message.attachments.length > 0 ? 'Sent a file' : 'Empty message');
  return (
    <button
      type="button"
      data-testid="chat-quote"
      onClick={() => onJumpTo(message.id)}
      className="mb-0.5 flex max-w-full min-w-0 items-center gap-1.5 rounded text-left text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-label={`Replying to ${message.author?.name ?? 'deleted user'}: ${text}. Go to that message`}
    >
      <CornerUpLeftIcon className="size-3 shrink-0 -scale-x-100" aria-hidden="true" />
      <ActorAvatar user={message.author} size="xs" />
      <span className="shrink-0 font-medium">{message.author?.name ?? 'Deleted user'}</span>
      <span className="truncate">{text}</span>
    </button>
  );
}
