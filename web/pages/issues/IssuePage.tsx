import {
  CheckCircle2Icon,
  CircleDotIcon,
  LinkIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PencilIcon,
  SearchXIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import { titleSchema } from '@shared/schemas/common';
import type { Issue } from '@shared/schemas/issues';
import { Conversation, ConversationModeMenuItem } from '@web/components/chat/Conversation';
import { BackLink } from '@web/components/common/BackLink';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { ItemPageFrame, ItemRailToggle } from '@web/components/itemRail/ItemPageFrame';
import { PageContainer } from '@web/components/common/PageContainer';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { ViewportFill } from '@web/components/common/ViewportFill';
import { Spinner } from '@web/components/common/Spinner';
import { UserName } from '@web/components/common/UserName';
import { usePaletteCommands } from '@web/components/palette/registry';
import { ActivitySheet } from '@web/components/replies/ActivitySheet';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@web/components/ui/sheet';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage, isApiError } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { useHotkey } from '@web/lib/hotkeys';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useMediaQuery } from '@web/lib/useMediaQuery';
import { cn } from '@web/lib/utils';
import { useMarkItemRead } from '@web/pages/inbox/useMarkItemRead';
import { copyText } from '@web/pages/teams/clipboard';
import { IssuePost } from './IssuePost';
import { IssueRail } from './IssueRail';
import { IssueSidebar } from './IssueSidebar';
import { IssueStateBadge } from './IssueState';
import {
  useDeleteIssue,
  useIssue,
  useRestoreIssue,
  useSetResolved,
  useUpdateIssue,
} from './queries';

/**
 * Issue page (`/t/:team/p/:key/issues/:number`): the header (title edited in place, state, author),
 * the original post, the reply timeline with the composer, and a sidebar with labels, the tasks
 * addressing it and the subscription toggle. Resolve/reopen, copy link and delete (with Undo) sit
 * in the header; `e` edits the title, `l` opens the labels and `u` goes back to the issue list.
 */
/** The details sidebar sits beside a chat issue from here; narrower, it opens as a sheet. */
const DETAILS_BESIDE_QUERY = '(min-width: 1024px)';

export default function IssuePage() {
  const { team, project } = useRouteContext();
  const params = useParams();
  const number = Number(params.number);
  if (!team || !project) return null;
  const valid = Number.isSafeInteger(number) && number >= 1;
  // BAT-44: the rail stays mounted while the viewer switches issues (it keeps its scroll).
  return (
    <ItemPageFrame
      label="Issues"
      rail={<IssueRail team={team} project={project} currentNumber={number} />}
    >
      {valid ? (
        <IssueView key={`${project.id}:${number}`} team={team} project={project} number={number} />
      ) : (
        <IssueMissing team={team} project={project} />
      )}
    </ItemPageFrame>
  );
}

function IssueView({
  team,
  project,
  number,
}: {
  team: MeTeam;
  project: MeProject;
  number: number;
}) {
  // While the viewer deletes the issue its query must not refetch (the live event would 404).
  const [deleting, setDeleting] = useState(false);
  const issue = useIssue(project.id, number, !deleting);
  useDocumentTitle(
    issue.data
      ? [issue.data.title, `Issue #${number}`, project.name]
      : [`Issue #${number}`, project.name],
  );

  if (issue.isPending) return <IssueSkeleton team={team} project={project} />;
  if (issue.isError && isApiError(issue.error) && issue.error.status === 404) {
    return <IssueMissing team={team} project={project} />;
  }
  if (issue.isError) {
    return (
      <PageContainer>
        <ErrorState
          title="Couldn’t load this issue"
          error={issue.error}
          onRetry={() => void issue.refetch()}
        />
      </PageContainer>
    );
  }
  return (
    <IssueDetail issue={issue.data} team={team} project={project} onDeletingChange={setDeleting} />
  );
}

function IssueDetail({
  issue,
  team,
  project,
  onDeletingChange,
}: {
  issue: Issue;
  team: MeTeam;
  project: MeProject;
  onDeletingChange: (deleting: boolean) => void;
}) {
  const navigate = useNavigate();
  const access = useProjectAccess(team.id, project.id);
  const base = `/t/${team.slug}/p/${project.key}`;
  const authorId = issue.author?.id ?? null;
  const canEdit = access.canEdit(authorId);
  const canDelete = access.canDelete(authorId);
  const canTriage = authorId === access.userId || access.has('RESOLVE_ISSUES');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // BAT-43: a chat issue is one screen tall; below lg its details open as a sheet.
  const chat = issue.conversationMode === 'chat';
  const wide = useMediaQuery(DETAILS_BESIDE_QUERY);
  const detailsInSheet = chat && !wide;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const setResolved = useSetResolved(issue);
  const remove = useDeleteIssue();
  const restore = useRestoreIssue();
  useMarkItemRead('issue', issue);
  const link = `${window.location.origin}${issue.path}`;

  const toggleResolved = () =>
    setResolved.mutate(!issue.resolved, {
      onSuccess: (updated) =>
        toast.success(updated.resolved ? `${issue.ref} resolved` : `${issue.ref} reopened`),
    });

  const deleteIssue = async () => {
    onDeletingChange(true);
    try {
      await remove.mutateAsync(issue);
    } catch (error) {
      onDeletingChange(false);
      throw error;
    }
    void navigate(`${base}/issues`);
    toast.success(`${issue.ref} moved to Trash`, {
      action: {
        label: 'Undo',
        onClick: () =>
          void restore
            .mutateAsync(issue.id)
            .then((restored) => navigate(restored.path))
            .catch((error: unknown) => toast.error(errorMessage(error, 'Couldn’t restore it.'))),
      },
    });
  };

  useHotkey('e', () => setEditingTitle(true), {
    description: 'Edit the title',
    group: 'Issue',
    enabled: canEdit && !editingTitle,
  });
  useHotkey(
    'l',
    () => {
      if (detailsInSheet) setDetailsOpen(true);
      setLabelsOpen(true);
    },
    {
      description: 'Edit labels',
      group: 'Issue',
      enabled: canTriage,
    },
  );
  usePaletteCommands([
    {
      id: `issue.${issue.id}.copy-link`,
      label: `Copy link to ${issue.ref}`,
      group: 'Issue',
      icon: LinkIcon,
      keywords: ['copy issue link', 'url', 'share'],
      perform: () => void copyText(link),
    },
    ...(canTriage
      ? [
          {
            id: `issue.${issue.id}.resolve`,
            label: issue.resolved ? `Reopen ${issue.ref}` : `Resolve ${issue.ref}`,
            group: 'Issue',
            icon: issue.resolved ? CircleDotIcon : CheckCircle2Icon,
            keywords: issue.resolved
              ? ['reopen issue', 'open']
              : ['resolve issue', 'close', 'done'],
            perform: toggleResolved,
          },
        ]
      : []),
  ]);

  const header = (
    <header className={cn('flex flex-col gap-3 border-b', chat ? 'shrink-0 pb-3' : 'pb-4')}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        {editingTitle ? (
          <TitleEditor issue={issue} onClose={() => setEditingTitle(false)} />
        ) : (
          <h1 className="min-w-0 grow basis-full text-xl leading-snug font-semibold tracking-tight break-words sm:basis-0 sm:text-2xl">
            {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
          </h1>
        )}
        {editingTitle ? null : (
          <div className="flex shrink-0 items-center gap-2">
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingTitle(true)}
                aria-keyshortcuts="e"
              >
                <PencilIcon aria-hidden="true" />
                <span className="sr-only sm:not-sr-only">Edit title</span>
              </Button>
            ) : null}
            {canTriage ? (
              <Button
                variant="outline"
                size="sm"
                onClick={toggleResolved}
                disabled={setResolved.isPending}
              >
                {issue.resolved ? (
                  <CircleDotIcon aria-hidden="true" className="text-primary" />
                ) : (
                  <CheckCircle2Icon
                    aria-hidden="true"
                    className="text-emerald-600 dark:text-emerald-400"
                  />
                )}
                {issue.resolved ? 'Reopen' : 'Resolve'}
              </Button>
            ) : null}
            <ActivitySheet
              parentType="issue"
              parentId={issue.id}
              itemRef={issue.ref}
              group="Issue"
              className="h-8"
            />
            {detailsInSheet ? (
              <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)}>
                <PanelRightIcon aria-hidden="true" />
                Details
              </Button>
            ) : null}
            <IssueMenu
              issue={issue}
              canEdit={canEdit}
              canDelete={canDelete}
              onCopyLink={() => void copyText(link)}
              onCopyRef={() => void copyText(issue.ref, 'Reference')}
              onDelete={() => setConfirmDelete(true)}
            />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
        <IssueStateBadge resolved={issue.resolved} className="mr-1" />
        <UserName user={issue.author} via={issue.via} />
        <span>opened this issue</span>
        <RelativeTime value={issue.createdAt} className="text-sm" />
        <span aria-hidden="true">·</span>
        <span>{pluralize(issue.replyCount, 'reply', 'replies')}</span>
        {issue.resolved && issue.resolvedAt ? (
          <>
            <span aria-hidden="true">·</span>
            <span>resolved by</span>
            <UserName user={issue.resolvedBy} />
            <RelativeTime value={issue.resolvedAt} className="text-sm" />
          </>
        ) : null}
      </div>
    </header>
  );

  const sidebar = (
    <IssueSidebar
      issue={issue}
      access={access}
      canTriage={canTriage}
      labelsOpen={labelsOpen}
      onLabelsOpenChange={setLabelsOpen}
    />
  );
  const conversation = (
    <Conversation
      parentType="issue"
      parentId={issue.id}
      teamId={team.id}
      projectId={issue.projectId}
      mode={issue.conversationMode}
      item={issue}
      fill={chat}
      forumHeading={
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessagesSquareIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          Conversation
        </h2>
      }
    />
  );
  const post = (
    <IssuePost
      issue={issue}
      access={access}
      editing={editingBody}
      onEditingChange={setEditingBody}
      collapsible={chat}
    />
  );
  const dialogs = (
    <>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${issue.ref}?`}
        description="The issue, its replies and files move to Trash. You can restore it for 30 days."
        confirmLabel="Delete issue"
        destructive
        onConfirm={deleteIssue}
      />
    </>
  );

  if (chat) {
    // BAT-43: exactly one screen below the app header. The post is cut to a few lines ("Read
    // more"); the chat takes the rest, scrolls on its own and keeps its composer at the bottom.
    return (
      <ViewportFill
        className="mx-auto flex h-[calc(100dvh-3rem)] w-full max-w-6xl flex-col px-4 pt-3 pb-3 sm:px-6"
        data-testid="issue-chat-layout"
      >
        <div className="flex shrink-0 items-center gap-1">
          <ItemRailToggle className="-ml-1.5" />
          <IssuesBackLink team={team} project={project} className="mb-0" />
        </div>
        {header}
        <div className="mt-4 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-x-8">
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            <div className="max-h-[60%] min-h-0 shrink overflow-y-auto">{post}</div>
            <section aria-label="Conversation" className="flex min-h-56 min-w-0 flex-1 flex-col">
              {conversation}
            </section>
          </div>
          {detailsInSheet ? null : (
            <aside aria-label="Issue details" className="min-h-0 overflow-y-auto pb-2">
              {sidebar}
            </aside>
          )}
        </div>
        {detailsInSheet ? (
          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetContent side="right" className="w-80 overflow-y-auto p-4 pt-12">
              <SheetTitle className="sr-only">Issue details</SheetTitle>
              <SheetDescription className="sr-only">
                Labels, the tasks addressing it and notifications.
              </SheetDescription>
              <aside aria-label="Issue details">{sidebar}</aside>
            </SheetContent>
          </Sheet>
        ) : null}
        {dialogs}
      </ViewportFill>
    );
  }

  return (
    <PageContainer>
      <div className="flex items-center gap-1">
        <ItemRailToggle className="mb-3 -ml-1.5" />
        <IssuesBackLink team={team} project={project} />
      </div>
      {header}

      <div className="mt-6 grid gap-6 [grid-template-areas:'post'_'side'_'thread'] lg:grid-cols-[minmax(0,1fr)_16rem] lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:[grid-template-areas:'post_side'_'thread_side']">
        <div className="min-w-0 [grid-area:post]">{post}</div>
        <aside aria-label="Issue details" className="[grid-area:side] lg:self-start">
          {sidebar}
        </aside>
        <section aria-label="Conversation" className="min-w-0 [grid-area:thread]">
          {conversation}
        </section>
      </div>
      {dialogs}
    </PageContainer>
  );
}

function IssueMenu({
  issue,
  canEdit,
  canDelete,
  onCopyLink,
  onCopyRef,
  onDelete,
}: {
  issue: Issue;
  canEdit: boolean;
  canDelete: boolean;
  onCopyLink: () => void;
  onCopyRef: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="More actions">
          <MoreHorizontalIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={onCopyLink}>
          <LinkIcon aria-hidden="true" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyRef}>
          <span aria-hidden="true" className="w-4 text-center font-mono text-xs">
            #
          </span>
          Copy reference
        </DropdownMenuItem>
        {canEdit ? (
          <ConversationModeMenuItem
            parentType="issue"
            parentId={issue.id}
            projectId={issue.projectId}
            mode={issue.conversationMode}
          />
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon aria-hidden="true" />
              Delete issue
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TitleEditor({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const update = useUpdateIssue(issue);
  const [title, setTitle] = useState(issue.title);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (update.isPending) return;
    const parsed = titleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Required');
      return;
    }
    if (parsed.data === issue.title) {
      onClose();
      return;
    }
    update.mutate(
      { title: parsed.data },
      {
        onSuccess: () => {
          toast.success('Title updated');
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          aria-label="Title"
          aria-invalid={error ? true : undefined}
          className="h-9 min-w-0 flex-1 text-base font-semibold sm:text-lg"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function IssueMissing({ team, project }: { team: MeTeam; project: MeProject }) {
  return (
    <PageContainer>
      <EmptyState
        icon={SearchXIcon}
        title="Issue not found"
        description="It may have been deleted (look in Trash), or the link is wrong."
        action={
          <Button asChild variant="outline">
            <Link to={`/t/${team.slug}/p/${project.key}/issues`}>Back to issues</Link>
          </Button>
        }
        className="py-16"
      />
    </PageContainer>
  );
}

/** "← Issues": back to the issue list the issue was opened from, filters and scroll included. */
function IssuesBackLink({
  team,
  project,
  className,
}: {
  team: MeTeam;
  project: MeProject;
  className?: string;
}) {
  return (
    <BackLink to={`/t/${team.slug}/p/${project.key}/issues`} label="Issues" className={className} />
  );
}

function IssueSkeleton({ team, project }: { team: MeTeam; project: MeProject }) {
  return (
    <PageContainer>
      <IssuesBackLink team={team} project={project} />
      <div role="status" aria-label="Loading issue" className="grid gap-6">
        <div className="grid gap-3 border-b pb-4">
          <Skeleton className="h-7 w-2/3 max-w-lg" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-x-8">
          <div className="grid gap-4">
            <Skeleton className="h-40 rounded-lg" />
            <Skeleton className="h-20 rounded-lg" />
          </div>
          <div className="grid content-start gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
