import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CopyIcon,
  GripVerticalIcon,
  KanbanSquareIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { COLOR_PALETTE, LIMITS, type StatusCategory } from '@shared/constants';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import { statusNameSchema, type Status } from '@shared/schemas/projects';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { StatusIcon } from '@web/components/common/StatusBadge';
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
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { errorMessage, isApiError } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import {
  useCreateStatus,
  useDeleteStatus,
  useReorderStatuses,
  useStatuses,
  useUpdateStatus,
} from '../projects/queries';
import { BoardBackLink, ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';
import { CopyPipelineDialog } from './CopyPipelineDialog';
import { usePrincipalOptions } from './pipelineQueries';
import { StageRulesDialog } from './StageRulesDialog';
import { countRules } from './stageRules';

/**
 * Project settings → Statuses: the board's columns. Drag to reorder (or use the keyboard: focus a
 * handle, Space, arrows, Space), rename in place, pick a color and a category, choose the default
 * for new tasks, add and delete (moving the tasks elsewhere). Each status's pipeline rules (design
 * §5) open in a dialog, and "Copy pipeline from…" copies another project's statuses and rules.
 * `?status=<id>` (a board column's "Edit statuses") scrolls to that status and highlights it.
 */

const CATEGORY_LABELS: Record<StatusCategory, string> = { open: 'Open', done: 'Done' };

export default function StatusesSettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Statuses', project?.name]);
  if (!team || !project) return null;
  return (
    <>
      <BoardBackLink team={team} project={project} />
      <Statuses key={project.id} teamId={team.id} projectId={project.id} />
    </>
  );
}

function Statuses({ teamId, projectId }: { teamId: string; projectId: string }) {
  const access = useProjectAccess(teamId, projectId);
  const canManage = access.has('MANAGE_STATUSES');
  const statuses = useStatuses(projectId);
  const reorder = useReorderStatuses(projectId);
  const update = useUpdateStatus(projectId);
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [editingRules, setEditingRules] = useState<Status | null>(null);
  const [copying, setCopying] = useState(false);
  const principals = usePrincipalOptions(teamId, projectId);
  const me = useMe();
  const [searchParams] = useSearchParams();
  const targetId = searchParams.get('status');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const header = (
    <SettingsHeader
      title="Statuses"
      description={
        <>
          The columns of the board, in order. Tasks in a <strong>Done</strong> status count as
          finished: they aren’t overdue, can’t be claimed, and resolve the issues they fix. Each
          status can have pipeline rules: hand-offs, exit criteria, approvals.
        </>
      }
      actions={
        canManage ? (
          <Button variant="outline" size="sm" onClick={() => setCopying(true)}>
            <CopyIcon aria-hidden="true" />
            Copy pipeline from…
          </Button>
        ) : null
      }
    />
  );

  if (statuses.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="Couldn’t load the statuses"
          error={statuses.error}
          onRetry={() => void statuses.refetch()}
        />
      </>
    );
  }

  const items = statuses.data ?? [];
  const defaultId = items.find((status) => status.isDefault)?.id ?? '';

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((status) => status.id === active.id);
    const to = items.findIndex((status) => status.id === over.id);
    if (from < 0 || to < 0) return;
    reorder.mutate(arrayMove(items, from, to).map((status) => status.id));
  };

  return (
    <div>
      {header}
      {canManage ? null : <ReadOnlyNotice permission="Manage statuses" />}
      <SettingsCard>
        <div className="hidden grid-cols-[2rem_2rem_minmax(0,1fr)_7.5rem_4.5rem_5rem_4.5rem] items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
          <span />
          <span />
          <span>Name</span>
          <span>Category</span>
          <span className="text-center">Default</span>
          <span className="text-right">Tasks</span>
          <span />
        </div>
        {statuses.isPending ? (
          <StatusesSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            icon={KanbanSquareIcon}
            title="No statuses"
            description="Add a status to give the board a column."
            className="m-4"
          />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{
              screenReaderInstructions: {
                draggable:
                  'To reorder a status, press Space or Enter to pick it up, use the arrow keys to move it, and press Space or Enter again to drop it. Press Escape to cancel.',
              },
            }}
          >
            <SortableContext
              items={items.map((status) => status.id)}
              strategy={verticalListSortingStrategy}
            >
              {/* The radio group wraps the list (a radiogroup can't be the list itself: its items
                  would lose their list parent). */}
              <RadioGroup
                value={defaultId}
                onValueChange={(id) => update.mutate({ id, input: { isDefault: true } })}
                aria-label="Default status for new tasks"
                disabled={!canManage}
                className="gap-0"
              >
                <ul>
                  {items.map((status) => (
                    <StatusRow
                      key={status.id}
                      status={status}
                      projectId={projectId}
                      canManage={canManage}
                      isOnly={items.length === 1}
                      targeted={status.id === targetId}
                      onDelete={() => setDeleting(status)}
                      onEditRules={() => setEditingRules(status)}
                    />
                  ))}
                </ul>
              </RadioGroup>
            </SortableContext>
          </DndContext>
        )}
        {canManage ? <AddStatus projectId={projectId} existing={items} /> : null}
      </SettingsCard>
      <DeleteStatusDialog
        projectId={projectId}
        status={deleting}
        statuses={items}
        onClose={() => setDeleting(null)}
      />
      <StageRulesDialog
        status={editingRules}
        statuses={items}
        options={principals.options}
        canManage={canManage}
        onClose={() => setEditingRules(null)}
        onSave={(rules) =>
          editingRules
            ? update.mutateAsync({ id: editingRules.id, input: { rules } })
            : Promise.resolve()
        }
      />
      <CopyPipelineDialog
        open={copying}
        onOpenChange={setCopying}
        projectId={projectId}
        teams={me.data?.teams ?? []}
        options={principals.options}
      />
    </div>
  );
}

function StatusRow({
  status,
  projectId,
  canManage,
  isOnly,
  targeted,
  onDelete,
  onEditRules,
}: {
  status: Status;
  projectId: string;
  canManage: boolean;
  isOnly: boolean;
  /** Linked to with `?status=`: scrolled into view, briefly highlighted, name focused. */
  targeted: boolean;
  onDelete: () => void;
  onEditRules: () => void;
}) {
  const ruleCount = countRules(status.rules ?? DEFAULT_STAGE_RULES);
  const update = useUpdateStatus(projectId);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id, disabled: !canManage });
  const [name, setName] = useState(status.name);
  const [savedName, setSavedName] = useState(status.name);
  if (status.name !== savedName) {
    setSavedName(status.name);
    setName(status.name);
  }
  const nameRef = useRef<HTMLInputElement>(null);
  const [highlight, setHighlight] = useState(targeted);
  useEffect(() => {
    if (!targeted) return;
    const input = nameRef.current;
    input?.scrollIntoView?.({ block: 'center' });
    // Focus the name for keyboard and mouse users; on touch screens that would pop the keyboard.
    if (canManage && window.matchMedia?.('(pointer: fine)').matches) {
      input?.focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => setHighlight(false), 2500);
    return () => window.clearTimeout(timer);
  }, [targeted, canManage]);

  const commitName = () => {
    const parsed = statusNameSchema.safeParse(name);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid name');
      setName(status.name);
      return;
    }
    if (parsed.data === status.name) {
      setName(status.name);
      return;
    }
    update.mutate(
      { id: status.id, input: { name: parsed.data } },
      { onError: () => setName(status.name) },
    );
  };

  const onNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      setName(status.name);
      event.currentTarget.blur();
    }
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'grid grid-cols-[2rem_2rem_minmax(0,1fr)_4.5rem] items-center gap-x-2 gap-y-2 border-b bg-card px-3 py-2 last:border-b-0 sm:grid-cols-[2rem_2rem_minmax(0,1fr)_7.5rem_4.5rem_5rem_4.5rem]',
        isDragging && 'relative z-10 rounded-md shadow-lg ring-1 ring-border',
        highlight && 'bg-primary/5 ring-2 ring-primary/40 ring-inset',
      )}
      data-testid="status-row"
      data-targeted={targeted || undefined}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={!canManage}
        aria-label={`Reorder ${status.name}`}
        className="flex size-8 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <GripVerticalIcon className="size-4" aria-hidden="true" />
      </button>
      <ColorPicker
        value={status.color}
        onChange={(color) => update.mutate({ id: status.id, input: { color } })}
        label={`${status.name} color`}
        disabled={!canManage}
      >
        <button
          type="button"
          disabled={!canManage}
          aria-label={`${status.name} color: ${status.color}`}
          className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
        >
          <StatusIcon status={status} className="size-4" />
        </button>
      </ColorPicker>
      <Input
        ref={nameRef}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={onNameKeyDown}
        disabled={!canManage}
        maxLength={LIMITS.statusName.max}
        aria-label={`Name of status ${status.name}`}
        className="h-8 border-transparent bg-transparent px-2 shadow-none hover:border-input focus-visible:border-ring disabled:cursor-default disabled:opacity-100 dark:bg-transparent"
      />
      <div className="flex items-center justify-end gap-0.5 sm:order-last">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onEditRules}
          aria-label={`Rules of ${status.name}${ruleCount ? ` (${ruleCount} set)` : ''}`}
          className={cn('h-8 gap-1 px-1.5 text-muted-foreground', ruleCount > 0 && 'text-primary')}
        >
          <WorkflowIcon aria-hidden="true" />
          {ruleCount > 0 ? (
            <span className="text-xs tabular-nums" aria-hidden="true">
              {ruleCount}
            </span>
          ) : null}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onDelete}
                disabled={!canManage || isOnly}
                aria-label={`Delete ${status.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          {isOnly && canManage ? (
            <TooltipContent>A project needs at least one status</TooltipContent>
          ) : null}
        </Tooltip>
      </div>
      <div className="col-span-4 flex flex-wrap items-center gap-x-4 gap-y-2 pl-[4.5rem] sm:contents sm:pl-0">
        <Select
          value={status.category}
          onValueChange={(category) =>
            update.mutate({ id: status.id, input: { category: category as StatusCategory } })
          }
          disabled={!canManage}
        >
          <SelectTrigger size="sm" className="w-28" aria-label={`Category of ${status.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{CATEGORY_LABELS.open}</SelectItem>
            <SelectItem value="done">{CATEGORY_LABELS.done}</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm sm:justify-center">
          <RadioGroupItem
            value={status.id}
            className="border-muted-foreground/40"
            aria-label={`Make ${status.name} the default status`}
          />
          <span className="text-muted-foreground sm:sr-only">Default</span>
        </label>
        <span className="text-sm text-muted-foreground tabular-nums sm:text-right">
          <span className="sm:hidden">{pluralize(status.taskCount, 'task')}</span>
          <span className="hidden sm:inline" aria-label={pluralize(status.taskCount, 'task')}>
            {status.taskCount}
          </span>
        </span>
      </div>
    </li>
  );
}

function suggestColor(existing: readonly Status[]): string {
  const used = new Set(existing.map((status) => status.color));
  return (COLOR_PALETTE.slice(1).find((color) => !used.has(color.hex)) ?? COLOR_PALETTE[0]).hex;
}

function AddStatus({ projectId, existing }: { projectId: string; existing: Status[] }) {
  const inputId = useId();
  const create = useCreateStatus(projectId);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<StatusCategory>('open');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = statusNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid name');
      return;
    }
    setError(null);
    create.mutate(
      { name: parsed.data, category, color: suggestColor(existing) },
      {
        onSuccess: (status) => {
          setName('');
          toast.success(`Added ${status.name}`);
        },
        onError: (cause) => setError(isApiError(cause) ? cause.message : errorMessage(cause)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="border-t bg-muted/30 px-3 py-3" noValidate>
      <Label htmlFor={inputId} className="sr-only">
        New status name
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Add a status, e.g. In review"
          maxLength={LIMITS.statusName.max}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="h-8 min-w-0 flex-1 basis-48"
          autoComplete="off"
        />
        <Select value={category} onValueChange={(value) => setCategory(value as StatusCategory)}>
          <SelectTrigger size="sm" className="w-28" aria-label="Category of the new status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{CATEGORY_LABELS.open}</SelectItem>
            <SelectItem value="done">{CATEGORY_LABELS.done}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
          {create.isPending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
          Add status
        </Button>
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function DeleteStatusDialog({
  projectId,
  status,
  statuses,
  onClose,
}: {
  projectId: string;
  status: Status | null;
  statuses: Status[];
  onClose: () => void;
}) {
  return (
    <Dialog open={status !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {status ? (
          <DeleteStatusForm
            projectId={projectId}
            status={status}
            others={statuses.filter((candidate) => candidate.id !== status.id)}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeleteStatusForm({
  projectId,
  status,
  others,
  onClose,
}: {
  projectId: string;
  status: Status;
  others: Status[];
  onClose: () => void;
}) {
  const remove = useDeleteStatus(projectId);
  const selectId = useId();
  const [moveTo, setMoveTo] = useState(
    () => (others.find((other) => other.category === status.category) ?? others[0])?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const target = others.find((other) => other.id === moveTo);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return;
    setError(null);
    remove.mutate(
      { id: status.id, moveTo: target.id },
      {
        onSuccess: (result) => {
          toast.success(
            result.movedTasks > 0
              ? `Deleted ${status.name} and moved ${pluralize(result.movedTasks, 'task')} to ${target.name}`
              : `Deleted ${status.name}`,
          );
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Delete {status.name}?</DialogTitle>
        <DialogDescription>
          {status.taskCount > 0
            ? `Its ${pluralize(status.taskCount, 'task')} will move to the status you choose.`
            : 'No tasks are in this status. Choose where tasks would go anyway.'}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>Move tasks to</Label>
        <Select value={moveTo} onValueChange={setMoveTo}>
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue placeholder="Choose a status" />
          </SelectTrigger>
          <SelectContent>
            {others.map((other) => (
              <SelectItem key={other.id} value={other.id}>
                <StatusIcon status={other} />
                {other.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status.isDefault && target ? (
          <p className="text-xs text-muted-foreground">
            {status.name} is the default status, so {target.name} becomes the default for new tasks.
          </p>
        ) : null}
        {target && target.category !== status.category ? (
          <p className="text-xs text-muted-foreground">
            {target.name} is {target.category === 'done' ? 'a Done' : 'an Open'} status: moved tasks
            will count as {target.category === 'done' ? 'finished' : 'not finished'}.
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={!target || remove.isPending}>
          {remove.isPending ? <Spinner /> : null}
          Delete status
        </Button>
      </DialogFooter>
    </form>
  );
}

function StatusesSkeleton() {
  return (
    <div role="status" aria-label="Loading statuses">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0">
          <Skeleton className="size-5" />
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-5 flex-1" />
          <Skeleton className="hidden h-7 w-28 sm:block" />
        </div>
      ))}
    </div>
  );
}
