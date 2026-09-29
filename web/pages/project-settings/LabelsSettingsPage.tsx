import { PencilIcon, PlusIcon, SearchIcon, TagsIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Label as LabelEntity } from '@shared/schemas/projects';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { LabelChip } from '@web/components/common/LabelChip';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { pluralize } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useDeleteLabel, useLabels } from '../projects/queries';
import { LabelDialog, type LabelEditing as Editing } from './LabelDialog';
import { BoardBackLink, ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/**
 * Project settings → Labels: the labels its issues and tasks share, with how often each is used.
 * Create and edit in a dialog; deleting asks first and says how many items lose the label.
 */
export default function LabelsSettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Labels', project?.name]);
  if (!team || !project) return null;
  return (
    <>
      <BoardBackLink team={team} project={project} />
      <Labels key={project.id} teamId={team.id} projectId={project.id} />
    </>
  );
}

function usage(label: LabelEntity): string {
  const parts = [];
  if (label.issueCount) parts.push(pluralize(label.issueCount, 'issue'));
  if (label.taskCount) parts.push(pluralize(label.taskCount, 'task'));
  return parts.length ? parts.join(' · ') : 'Not used yet';
}

function Labels({ teamId, projectId }: { teamId: string; projectId: string }) {
  const access = useProjectAccess(teamId, projectId);
  const canManage = access.has('MANAGE_LABELS');
  const labels = useLabels(projectId);
  const remove = useDeleteLabel(projectId);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<LabelEntity | null>(null);
  const [filter, setFilter] = useState('');

  const items = labels.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? items.filter(
        (label) =>
          label.name.toLowerCase().includes(needle) ||
          label.description.toLowerCase().includes(needle),
      )
    : items;

  const newButton = canManage ? (
    <Button onClick={() => setEditing({ mode: 'create' })}>
      <PlusIcon aria-hidden="true" />
      New label
    </Button>
  ) : null;

  return (
    <div>
      <SettingsHeader
        title="Labels"
        description="Labels are shared by the project’s issues and tasks. Use them to group and filter work."
        actions={items.length > 0 ? newButton : null}
      />
      {canManage ? null : <ReadOnlyNotice permission="Manage labels" />}

      {labels.isError ? (
        <ErrorState
          title="Couldn’t load the labels"
          error={labels.error}
          onRetry={() => void labels.refetch()}
        />
      ) : labels.isPending ? (
        <LabelsSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={TagsIcon}
          title="No labels yet"
          description={
            canManage
              ? 'Create labels like “bug” or “design” to sort issues and tasks.'
              : 'Nobody has created a label in this project yet.'
          }
          action={newButton}
        />
      ) : (
        <>
          {items.length > 5 ? (
            <div className="relative mb-3 max-w-xs">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter labels"
                aria-label="Filter labels"
                className="h-8 pl-8"
              />
            </div>
          ) : null}
          <SettingsCard>
            <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
              {pluralize(items.length, 'label')}
            </div>
            {shown.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No labels match “{filter.trim()}”.
              </p>
            ) : (
              <ul>
                {shown.map((label) => (
                  <li
                    key={label.id}
                    className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0 sm:grid-cols-[10rem_minmax(0,1fr)_8rem_auto]"
                    data-testid="label-row"
                  >
                    <div className="min-w-0">
                      <LabelChip label={{ ...label, description: null }} />
                    </div>
                    <p
                      className="col-span-2 row-start-2 min-w-0 truncate text-sm text-muted-foreground sm:col-span-1 sm:row-start-auto"
                      title={label.description || undefined}
                    >
                      {label.description || <span className="italic">No description</span>}
                      <span className="text-xs sm:hidden"> · {usage(label)}</span>
                    </p>
                    <span className="hidden text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:block">
                      {usage(label)}
                    </span>
                    {canManage ? (
                      <div className="col-start-2 row-start-1 flex shrink-0 gap-1 sm:col-start-auto sm:row-start-auto">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${label.name}`}
                          onClick={() => setEditing({ mode: 'edit', label })}
                        >
                          <PencilIcon aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${label.name}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleting(label)}
                        >
                          <Trash2Icon aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </SettingsCard>
        </>
      )}

      <LabelDialog
        projectId={projectId}
        editing={editing}
        existing={items}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={`Delete the label “${deleting?.name ?? ''}”?`}
        description={
          deleting && deleting.issueCount + deleting.taskCount > 0
            ? `It will be removed from ${[
                deleting.issueCount ? pluralize(deleting.issueCount, 'issue') : null,
                deleting.taskCount ? pluralize(deleting.taskCount, 'task') : null,
              ]
                .filter(Boolean)
                .join(' and ')}. This can’t be undone.`
            : 'No issues or tasks use it. This can’t be undone.'
        }
        confirmLabel="Delete label"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`Deleted ${deleting.name}`);
        }}
      />
    </div>
  );
}

function LabelsSkeleton() {
  return (
    <div className="rounded-lg border" role="status" aria-label="Loading labels">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
