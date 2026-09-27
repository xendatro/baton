import { MoreHorizontalIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Reply } from '@shared/schemas/core';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserName } from '@web/components/common/UserName';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { ReactionBar } from '@web/components/reactions/ReactionBar';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { formatDateTime } from '@web/lib/format';
import { useTeamAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { useDeleteAttachment, useDeleteReply, useUpdateReply } from './queries';

export interface ReplyItemProps {
  reply: Reply;
  /** Actions under the reply, such as Reply in a threaded view (BAT-13). */
  footer?: ReactNode;
}

/** One reply: author (+ via key), time, "edited" marker, body, attachments, edit and delete. */
export function ReplyItem({ reply, footer }: ReplyItemProps) {
  const access = useTeamAccess(reply.teamId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(reply.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useUpdateReply(reply.parentType, reply.parentId);
  const remove = useDeleteReply(reply.parentType, reply.parentId);
  const deleteAttachment = useDeleteAttachment();
  const authorId = reply.author?.id;
  const canEdit = access.canEdit(authorId);
  const canDelete = access.canDelete(authorId);

  const save = () => {
    const body = draft.trim();
    if (!body || update.isPending) return;
    update.mutate(
      { id: reply.id, body },
      {
        onSuccess: () => {
          setEditing(false);
          toast.success('Reply updated');
        },
      },
    );
  };

  return (
    <article
      id={`reply-${reply.id}`}
      tabIndex={-1}
      className="group/reply flex scroll-mt-20 gap-3 rounded-lg border bg-card p-3 outline-none"
      aria-label={`Reply by ${reply.author?.name ?? 'deleted user'}`}
    >
      <ActorAvatar
        user={reply.author}
        agentName={reply.via?.agentName}
        size="lg"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <UserName user={reply.author} via={reply.via} />
          <RelativeTime value={reply.createdAt} className="text-xs" />
          {reply.editedAt ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-muted-foreground" tabIndex={0}>
                  (edited)
                </span>
              </TooltipTrigger>
              <TooltipContent>Edited {formatDateTime(reply.editedAt)}</TooltipContent>
            </Tooltip>
          ) : null}
          {(canEdit || canDelete) && !editing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto opacity-100 data-[state=open]:opacity-100 sm:opacity-0 sm:group-focus-within/reply:opacity-100 sm:group-hover/reply:opacity-100"
                  aria-label="Reply actions"
                >
                  <MoreHorizontalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDraft(reply.body);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                    <Trash2Icon aria-hidden="true" />
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>
        {editing ? (
          <div className="space-y-2">
            <RichTextEditor
              value={draft}
              onChange={setDraft}
              variant="compact"
              teamId={reply.teamId}
              autoFocus
              onSubmit={save}
              label="Edit reply"
            />
            {update.error ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(update.error)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={!draft.trim() || update.isPending}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <MarkdownView markdown={reply.body} teamId={reply.teamId} />
        )}
        <AttachmentList
          // Images shown inline in the body are not listed again.
          attachments={reply.attachments.filter(
            (attachment) => !(attachment.isImage && reply.body.includes(attachment.url)),
          )}
          canDelete={(attachment) => access.canDelete(attachment.uploader?.id)}
          onDelete={async (attachment) => {
            await deleteAttachment.mutateAsync(attachment.id);
            toast.success('Attachment moved to Trash');
          }}
        />
        {editing ? null : footer}
        <ReactionBar
          targetType="reply"
          targetId={reply.id}
          teamId={reply.teamId}
          reactions={reply.reactions}
          queryKey={queryKeys.replies.list(reply.parentType, reply.parentId)}
        />
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete reply?"
        description="The reply moves to Trash and can be restored for 30 days."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(reply.id);
          toast.success('Reply deleted');
        }}
      />
    </article>
  );
}
