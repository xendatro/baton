import { useQueryClient } from '@tanstack/react-query';
import { PencilIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Attachment } from '@shared/schemas/core';
import type { Issue } from '@shared/schemas/issues';
import { AttachmentList } from '@web/components/attachments/AttachmentList';
import { AttachmentUploader } from '@web/components/attachments/AttachmentUploader';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { Kbd } from '@web/components/common/Kbd';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { ReactionBar } from '@web/components/reactions/ReactionBar';
import { useDeleteAttachment } from '@web/components/replies/queries';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage } from '@web/lib/api';
import { formatDateTime } from '@web/lib/format';
import type { TeamAccess } from '@web/lib/permissions';
import { queryKeys } from '@web/lib/queryKeys';
import { UnsavedChangesGuard } from '@web/pages/projects/UnsavedChangesGuard';
import { useUpdateIssue } from './queries';

/**
 * The original post: author, time, "edited" marker, the markdown body (edited in place by the
 * author or `EDIT_ANY_CONTENT`) and the issue's files. Images shown in the body are not listed
 * again as files.
 */
export function IssuePost({
  issue,
  access,
  editing,
  onEditingChange,
}: {
  issue: Issue;
  access: TeamAccess;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const canEdit = access.canEdit(issue.author?.id);
  const deleteAttachment = useDeleteAttachment({ type: 'issue', id: issue.id });
  const files = issue.attachments.filter(
    (attachment) => !(attachment.isImage && issue.body.includes(attachment.url)),
  );
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.issues.detail(issue.projectId, issue.number),
    });

  return (
    <article
      aria-label={`Issue by ${issue.author?.name ?? 'deleted user'}`}
      className="rounded-lg border bg-card"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2.5 text-sm">
        <ActorAvatar user={issue.author} agentName={issue.via?.agentName} size="md" />
        <UserName user={issue.author} via={issue.via} />
        <span className="text-muted-foreground">opened</span>
        <RelativeTime value={issue.createdAt} className="text-sm" />
        {issue.editedAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground" tabIndex={0}>
                (edited)
              </span>
            </TooltipTrigger>
            <TooltipContent>Edited {formatDateTime(issue.editedAt)}</TooltipContent>
          </Tooltip>
        ) : null}
        {canEdit && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7"
            onClick={() => onEditingChange(true)}
          >
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        ) : null}
      </header>
      {editing ? (
        <BodyEditor issue={issue} onClose={() => onEditingChange(false)} />
      ) : (
        <div className="space-y-4 px-4 py-4">
          {issue.body.trim() ? (
            <MarkdownView markdown={issue.body} teamId={issue.teamId} />
          ) : (
            <p className="text-sm text-muted-foreground italic">No description provided.</p>
          )}
          {files.length > 0 || canEdit ? (
            <div className="space-y-2">
              <AttachmentList
                attachments={files}
                canDelete={(attachment) => access.canDelete(attachment.uploader?.id)}
                onDelete={async (attachment) => {
                  await deleteAttachment.mutateAsync(attachment.id);
                  await refresh();
                  toast.success(`${attachment.filename} moved to Trash`);
                }}
              />
              {canEdit ? (
                <AttachmentUploader
                  teamId={issue.teamId}
                  parentType="issue"
                  parentId={issue.id}
                  onUploaded={() => void refresh()}
                />
              ) : null}
            </div>
          ) : null}
          <ReactionBar
            targetType="issue"
            targetId={issue.id}
            teamId={issue.teamId}
            reactions={issue.reactions}
            queryKey={queryKeys.issues.detail(issue.projectId, issue.number)}
          />
        </div>
      )}
    </article>
  );
}

function BodyEditor({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const update = useUpdateIssue(issue);
  const [draft, setDraft] = useState(issue.body);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = draft.trim() !== issue.body.trim() || files.length > 0;

  const save = () => {
    if (update.isPending) return;
    if (!dirty) {
      onClose();
      return;
    }
    update.mutate(
      {
        body: draft.trim(),
        ...(files.length > 0 ? { attachmentIds: files.map((file) => file.id) } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Issue updated');
          onClose();
        },
      },
    );
  };
  const cancel = () => (dirty ? setConfirmDiscard(true) : onClose());

  return (
    <div className="space-y-3 p-3">
      <UnsavedChangesGuard when={dirty} what="edits" />
      <RichTextEditor
        value={draft}
        onChange={setDraft}
        onSubmit={save}
        teamId={issue.teamId}
        onAttach={(attachment) => setFiles((current) => [...current, attachment])}
        variant="full"
        autoFocus
        label="Description"
        placeholder="Describe the issue… Type / for blocks, @ to mention, paste or drop images."
        className="min-h-48"
      />
      <AttachmentList
        attachments={files}
        removeMode="draft"
        canDelete={() => true}
        onDelete={(attachment) =>
          setFiles((current) => current.filter((item) => item.id !== attachment.id))
        }
      />
      {update.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(update.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <Kbd keys="mod+enter" /> to save
        </span>
        <Button variant="outline" size="sm" onClick={cancel} disabled={update.isPending}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? <Spinner /> : null}
          Save
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your edits?"
        description="Your changes to the description haven’t been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={onClose}
      />
    </div>
  );
}
