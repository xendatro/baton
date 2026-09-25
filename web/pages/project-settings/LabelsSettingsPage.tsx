import { PencilIcon, PlusIcon, SearchIcon, TagsIcon, Trash2Icon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { COLOR_PALETTE, LIMITS } from '@shared/constants';
import {
  createLabelInputSchema,
  type CreateLabelInput,
  type Label as LabelEntity,
} from '@shared/schemas/projects';
import { FormError, FormField } from '@web/components/auth/FormField';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { LabelChip } from '@web/components/common/LabelChip';
import { Spinner } from '@web/components/common/Spinner';
import { ColorPicker } from '@web/components/pickers/ColorPicker';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import { Input } from '@web/components/ui/input';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage, isApiError } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { fieldErrors } from '@web/lib/forms';
import { useTeamAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { useCreateLabel, useDeleteLabel, useLabels, useUpdateLabel } from '../projects/queries';
import { ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/**
 * Project settings → Labels: the labels its issues and tasks share, with how often each is used.
 * Create and edit in a dialog; deleting asks first and says how many items lose the label.
 */
export default function LabelsSettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Labels', project?.name]);
  if (!team || !project) return null;
  return <Labels key={project.id} teamId={team.id} projectId={project.id} />;
}

type Editing = { mode: 'create' } | { mode: 'edit'; label: LabelEntity } | null;

function usage(label: LabelEntity): string {
  const parts = [];
  if (label.issueCount) parts.push(pluralize(label.issueCount, 'issue'));
  if (label.taskCount) parts.push(pluralize(label.taskCount, 'task'));
  return parts.length ? parts.join(' · ') : 'Not used yet';
}

function Labels({ teamId, projectId }: { teamId: string; projectId: string }) {
  const access = useTeamAccess(teamId);
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

function nextColor(existing: readonly LabelEntity[]): string {
  const used = new Set(existing.map((label) => label.color));
  return (COLOR_PALETTE.find((color) => !used.has(color.hex)) ?? COLOR_PALETTE[0]).hex;
}

function LabelDialog({
  projectId,
  editing,
  existing,
  onClose,
}: {
  projectId: string;
  editing: Editing;
  existing: LabelEntity[];
  onClose: () => void;
}) {
  return (
    <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {editing ? (
          <LabelForm
            projectId={projectId}
            editing={editing}
            existing={existing}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Field = 'name' | 'description' | 'color';

function LabelForm({
  projectId,
  editing,
  existing,
  onClose,
}: {
  projectId: string;
  editing: NonNullable<Editing>;
  existing: LabelEntity[];
  onClose: () => void;
}) {
  const create = useCreateLabel(projectId);
  const update = useUpdateLabel(projectId);
  const initial = editing.mode === 'edit' ? editing.label : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? nextColor(existing));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const input: CreateLabelInput = { name, description, color };
    const parsed = createLabelInputSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors<Field>(parsed.error));
      return;
    }
    setErrors({});
    const onError = (cause: Error) => {
      if (isApiError(cause) && cause.code === 'conflict') setErrors({ name: cause.message });
      else setFormError(errorMessage(cause));
    };
    if (initial) {
      update.mutate(
        { id: initial.id, input: parsed.data },
        {
          onSuccess: (label) => {
            toast.success(`Saved ${label.name}`);
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(parsed.data, {
        onSuccess: (label) => {
          toast.success(`Created ${label.name}`);
          onClose();
        },
        onError,
      });
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{initial ? 'Edit label' : 'New label'}</DialogTitle>
        <DialogDescription>
          {initial
            ? `Changes apply everywhere ${initial.name} is used.`
            : 'Available to every issue and task in this project.'}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-10 items-center justify-center rounded-md border border-dashed bg-muted/30 px-3 py-3">
        <LabelChip label={{ name: name.trim() || 'Label preview', color }} />
      </div>
      <div className="flex items-end gap-3">
        <FormField label="Name" error={errors.name} className="min-w-0 flex-1">
          {(field) => (
            <Input
              {...field}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={LIMITS.labelName.max}
              placeholder="bug"
              autoFocus
              autoComplete="off"
            />
          )}
        </FormField>
        <div className="grid gap-1.5 pb-px">
          <span className="text-sm leading-none font-medium" aria-hidden="true">
            Color
          </span>
          <ColorPicker value={color} onChange={setColor} label="Label color">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Label color: ${color}`}
            >
              <span className="size-4 rounded-full border" style={{ backgroundColor: color }} />
            </Button>
          </ColorPicker>
        </div>
      </div>
      <FormField
        label="Description"
        error={errors.description}
        hint={`Optional · shown when hovering the label (${description.length}/${LIMITS.labelDescription.max})`}
      >
        {(field) => (
          <Input
            {...field}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={LIMITS.labelDescription.max}
            placeholder="Something isn’t working"
            autoComplete="off"
          />
        )}
      </FormField>
      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? <Spinner /> : null}
          {initial ? 'Save label' : 'Create label'}
        </Button>
      </DialogFooter>
    </form>
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
