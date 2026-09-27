import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  KanbanSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  Settings2Icon,
  TagsIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import type { Project } from '@shared/schemas/projects';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { GitHubIcon } from '@web/components/common/GitHubIcon';
import { FinishedMark } from '@web/components/common/FinishedMark';
import { Kbd } from '@web/components/common/Kbd';
import { LabelChip } from '@web/components/common/LabelChip';
import { PageContainer } from '@web/components/common/PageContainer';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { UserName } from '@web/components/common/UserName';
import { RichTextEditor } from '@web/components/editor/RichTextEditor';
import { MarkdownView } from '@web/components/markdown/MarkdownView';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { useConfig } from '@web/lib/auth';
import { useHotkey } from '@web/lib/hotkeys';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { pluralize } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { GithubReadme } from './GithubReadme';
import { pipelineBoardPath } from '../tasks/pipelineTab';
import { useProject, useUpdateProject } from './queries';
import { ReadmeSourceDialog } from './ReadmeSourceDialog';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';

/**
 * Project overview (`/t/:team/p/:key`): the README (rendered, or edited in place with the full
 * editor) and a side panel with the description, quick stats, the workflow and labels.
 */
export default function ProjectOverviewPage() {
  const { team, project } = useRouteContext();
  // The project layout only renders its pages once both are resolved.
  if (!team || !project) return null;
  return <Overview key={project.id} team={team} project={project} />;
}

function Overview({ team, project }: { team: MeTeam; project: MeProject }) {
  const details = useProject(project.id);
  const access = useProjectAccess(team.id, project.id);
  const canEdit = access.has('MANAGE_PROJECTS');
  const [editing, setEditing] = useState(false);
  const [choosingSource, setChoosingSource] = useState(false);
  const githubReadmes = useConfig().data?.githubReadmes === true;
  const fromGithub = Boolean(details.data?.readmeSource);
  const base = `/t/${team.slug}/p/${project.key}`;
  useDocumentTitle(['Overview', project.name]);
  useHotkey('e', () => (fromGithub ? setChoosingSource(true) : setEditing(true)), {
    description: 'Edit the README',
    group: 'Project',
    enabled: canEdit && !editing && details.isSuccess,
  });

  if (details.isError) {
    return (
      <PageContainer>
        <ErrorState
          title="Couldn’t load this project"
          error={details.error}
          onRetry={() => void details.refetch()}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="readme-heading" className="min-w-0">
          {details.data ? (
            details.data.readmeSource ? (
              <GithubReadme
                project={details.data}
                canEdit={canEdit}
                onChangeSource={() => setChoosingSource(true)}
              />
            ) : editing ? (
              <ReadmeEditor
                project={details.data}
                teamId={team.id}
                onClose={() => setEditing(false)}
              />
            ) : (
              <Readme
                project={details.data}
                canEdit={canEdit}
                onEdit={() => setEditing(true)}
                onChooseSource={githubReadmes ? () => setChoosingSource(true) : undefined}
              />
            )
          ) : (
            <ReadmeSkeleton />
          )}
        </section>
        <aside className="grid content-start gap-4" aria-label="Project details">
          {details.data ? (
            <>
              <AboutCard project={details.data} />
              <StatsCard project={details.data} base={base} />
              <PipelinesCard project={details.data} base={base} />
              <LabelsCard project={details.data} base={base} />
            </>
          ) : (
            <>
              <Skeleton className="h-36 rounded-lg" />
              <Skeleton className="h-44 rounded-lg" />
            </>
          )}
        </aside>
      </div>
      {details.data && canEdit ? (
        <ReadmeSourceDialog
          open={choosingSource}
          onOpenChange={setChoosingSource}
          project={details.data}
          teamSlug={team.slug}
        />
      ) : null}
    </PageContainer>
  );
}

function SectionHeader({
  id,
  title,
  actions,
}: {
  id?: string;
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 border-b px-4 py-2">
      <h2 id={id} className="flex items-center gap-2 text-sm font-semibold">
        <BookOpenIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h2>
      {actions}
    </div>
  );
}

function Readme({
  project,
  canEdit,
  onEdit,
  onChooseSource,
}: {
  project: Project;
  canEdit: boolean;
  onEdit: () => void;
  /** Offered when the server can show READMEs from GitHub. */
  onChooseSource?: (() => void) | undefined;
}) {
  if (!project.readme.trim()) {
    return (
      <EmptyState
        icon={BookOpenIcon}
        title="No README yet"
        description={
          canEdit
            ? 'Describe the goals, links and conventions of this project, for teammates and their agents.'
            : 'Nobody has written a README for this project yet.'
        }
        action={
          canEdit ? (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onEdit}>
                <PencilIcon aria-hidden="true" />
                Write a README
              </Button>
              {onChooseSource ? (
                <Button variant="outline" onClick={onChooseSource}>
                  <GitHubIcon />
                  Show one from GitHub
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
        className="py-16"
      />
    );
  }
  return (
    <div className="rounded-lg border bg-card">
      <SectionHeader
        id="readme-heading"
        title="README"
        actions={
          canEdit ? (
            <div className="flex items-center gap-1">
              {onChooseSource ? (
                <Button variant="ghost" size="sm" onClick={onChooseSource}>
                  <Settings2Icon aria-hidden="true" />
                  Source
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={onEdit} aria-keyshortcuts="e">
                <PencilIcon aria-hidden="true" />
                Edit
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="px-4 py-5 sm:px-6">
        <MarkdownView markdown={project.readme} teamId={project.teamId} />
      </div>
    </div>
  );
}

function ReadmeEditor({
  project,
  teamId,
  onClose,
}: {
  project: Project;
  teamId: string;
  onClose: () => void;
}) {
  const update = useUpdateProject(project.id);
  const [draft, setDraft] = useState(project.readme);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = draft.trim() !== project.readme.trim();

  const save = () => {
    if (update.isPending) return;
    if (!dirty) {
      onClose();
      return;
    }
    update.mutate(
      { readme: draft.trim() },
      {
        onSuccess: () => {
          toast.success('README saved');
          onClose();
        },
      },
    );
  };
  const cancel = () => (dirty ? setConfirmDiscard(true) : onClose());

  return (
    <div className="rounded-lg border bg-card">
      <SectionHeader id="readme-heading" title="Editing README" />
      <div className="p-2 sm:p-3">
        <RichTextEditor
          value={draft}
          onChange={setDraft}
          onSubmit={save}
          teamId={teamId}
          variant="full"
          autoFocus
          label="README"
          placeholder="Write the README… Type / for blocks, @ to mention, paste or drop images."
          className="min-h-72"
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
        <span className="mr-auto hidden text-xs text-muted-foreground sm:inline">
          <Kbd keys="mod+enter" /> to save
        </span>
        <Button variant="outline" onClick={cancel} disabled={update.isPending}>
          Cancel
        </Button>
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? <Spinner /> : null}
          Save README
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your README changes?"
        description="Your edits haven’t been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        destructive
        onConfirm={onClose}
      />
      <UnsavedChangesGuard when={dirty && !update.isPending} what="README changes" />
    </div>
  );
}

function ReadmeSkeleton() {
  return (
    <div className="rounded-lg border" role="status" aria-label="Loading README">
      <div className="border-b px-4 py-3">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="grid gap-3 px-6 py-5">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function AboutCard({ project }: { project: Project }) {
  return (
    <Card title="About">
      <p
        className={cn(
          'text-sm break-words',
          project.description ? 'text-foreground' : 'text-muted-foreground italic',
        )}
      >
        {project.description || 'No description.'}
      </p>
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Key</dt>
        <dd className="min-w-0 truncate">
          <span className="font-mono">{project.key}</span>
          {project.keyAliases.length > 0 ? (
            <span
              className="text-muted-foreground"
              title="Previous keys still resolve in refs and links"
            >
              {' '}
              (was {project.keyAliases.join(', ')})
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5">
          <RelativeTime value={project.createdAt} className="text-foreground" />
          {project.createdBy ? (
            <>
              <span className="text-muted-foreground">by</span>
              <UserName user={project.createdBy} />
            </>
          ) : null}
        </dd>
      </dl>
    </Card>
  );
}

function StatLink({
  to,
  icon: Icon,
  label,
  value,
  tone,
}: {
  to: string;
  icon: typeof CircleDotIcon;
  label: string;
  value: number;
  tone: 'open' | 'done';
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-1 rounded-md border px-3 py-2 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon
          className={cn(
            'size-3.5',
            tone === 'done' ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary',
          )}
          aria-hidden="true"
        />
        {label}
      </span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </Link>
  );
}

function StatsCard({ project, base }: { project: Project; base: string }) {
  const { tasks: totalTasks, assignedTasks, openIssues, resolvedIssues } = project.counts;
  const withTasks = project.statuses.filter((status) => status.taskCount > 0);
  return (
    <Card title="Progress">
      <div className="grid grid-cols-2 gap-2">
        <StatLink
          to={`${base}/tasks`}
          icon={KanbanSquareIcon}
          label="Tasks"
          value={totalTasks}
          tone="open"
        />
        <StatLink
          to={`${base}/tasks`}
          icon={CircleDotIcon}
          label="Assigned tasks"
          value={assignedTasks}
          tone="open"
        />
        <StatLink
          to={`${base}/issues`}
          icon={CircleDotIcon}
          label="Open issues"
          value={openIssues}
          tone="open"
        />
        <StatLink
          to={`${base}/issues`}
          icon={CheckCircle2Icon}
          label="Resolved"
          value={resolvedIssues}
          tone="done"
        />
      </div>
      <div className="mt-4">
        <p className="mb-1.5 text-xs text-muted-foreground">Tasks by status</p>
        {totalTasks === 0 || withTasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tasks yet</p>
        ) : (
          <>
            <div
              className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={withTasks
                .map((status) => `${status.name}: ${status.taskCount}`)
                .join(', ')}
            >
              {withTasks.map((status) => (
                <div
                  key={status.id}
                  className="h-full"
                  style={{
                    width: `${(status.taskCount / totalTasks) * 100}%`,
                    backgroundColor: status.color,
                  }}
                />
              ))}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-hidden="true">
              {withTasks.map((status) => (
                <li key={status.id} className="flex items-center gap-1">
                  <StatusIcon status={status} className="size-3" />
                  <span className="text-muted-foreground">{status.name}</span>
                  <FinishedMark status={status} className="size-3.5" />
                  <span className="tabular-nums">{status.taskCount}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="mt-4 grid gap-1.5">
        <Button asChild variant="outline" size="sm" className="justify-between">
          <Link to={`${base}/tasks`}>
            <span className="flex items-center gap-2">
              <KanbanSquareIcon aria-hidden="true" />
              Open the board
            </span>
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="justify-between">
          <Link to={`${base}/issues`}>
            <span className="flex items-center gap-2">
              <MessagesSquareIcon aria-hidden="true" />
              Browse issues
            </span>
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

/**
 * The project's pipelines (teams → projects → pipelines → stages → tasks): each one links to its
 * board, with its task count and its stages as chips (with their task counts).
 */
function PipelinesCard({ project, base }: { project: Project; base: string }) {
  const pipelines = project.pipelines ?? [];
  return (
    <Card
      title="Pipelines"
      action={
        <Link
          to={`${base}/settings/pipelines`}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Edit
        </Link>
      }
    >
      {pipelines.length === 0 ? (
        <StageChips statuses={project.statuses} />
      ) : (
        <ul className="grid gap-3">
          {pipelines.map((pipeline) => (
            <li key={pipeline.id} className="grid gap-1.5">
              <Link
                to={pipelineBoardPath(base, pipeline.id)}
                className="flex items-center gap-1.5 rounded-sm text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <WorkflowIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{pipeline.name}</span>
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {pluralize(pipeline.taskCount, 'task')}
                </span>
              </Link>
              <StageChips
                statuses={project.statuses.filter((status) => status.pipelineId === pipeline.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StageChips({ statuses }: { statuses: Project['statuses'] }) {
  if (statuses.length === 0) {
    return <p className="text-xs text-muted-foreground">No stages yet.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Stages">
      {statuses.map((status) => (
        <li
          key={status.id}
          className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
          title={`${status.name}: ${pluralize(status.taskCount, 'task')}${status.isDefault ? ' (default for new tasks)' : ''}`}
        >
          <StatusIcon status={status} />
          <span className="max-w-28 truncate">{status.name}</span>
          <span className="text-muted-foreground tabular-nums">{status.taskCount}</span>
        </li>
      ))}
    </ul>
  );
}

function LabelsCard({ project, base }: { project: Project; base: string }) {
  const shown = project.labels.slice(0, 12);
  return (
    <Card
      title="Labels"
      action={
        <Link
          to={`${base}/settings/labels`}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Manage
        </Link>
      }
    >
      {shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <TagsIcon className="size-4" aria-hidden="true" />
          No labels yet.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
          {project.labels.length > shown.length ? (
            <span className="text-xs text-muted-foreground">
              +{project.labels.length - shown.length} more
            </span>
          ) : null}
        </div>
      )}
    </Card>
  );
}
