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
  ChevronDownIcon,
  CopyIcon,
  CopyPlusIcon,
  GripVerticalIcon,
  KanbanSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
  ZapIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { LIMITS, nextNewStageName } from '@shared/constants';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import { statusNameSchema, type Status } from '@shared/schemas/projects';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { Spinner } from '@web/components/common/Spinner';
import { FinishedMark } from '@web/components/common/FinishedMark';
import { SoftWarning } from '@web/components/common/SoftWarning';
import {
  NoStagesNotice,
  NoStartStageNotice,
  StartHereSwitch,
} from '@web/components/common/NewTaskStages';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { STATUS_ICON_SHAPES } from '@web/components/common/statusIcons';
import { StatusIconPicker } from '@web/components/pickers/StatusIconPicker';
import { Button } from '@web/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
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
import { errorMessage } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { pluralize } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import { acceptsNewTasks } from '@web/lib/newTaskStages';
import {
  useCreateStatus,
  useDeleteStatus,
  useReorderStatuses,
  useStatuses,
  usePipelines,
  useUpdateStatus,
} from '../projects/queries';
import { BoardBackLink, ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';
import { CopyPipelineDialog } from './CopyPipelineDialog';
import { CreateFromExistingDialog } from './CreateFromExistingDialog';
import { useDifficulties } from '../projects/difficultyQueries';
import { PipelineDiagram } from './PipelineDiagram';
import { PipelinesBar } from './PipelinesBar';
import { usePrincipalOptions } from './pipelineQueries';
import { StatusDialog, type StatusDialogState } from './StatusDialog';
import { countRules, suggestColor } from './stageRules';

/**
 * Project settings → Pipelines (the section was "Statuses"; `settings/statuses` redirects here):
 * the project's pipelines (every task is in a stage of one), then the selected pipeline's stages,
 * the board's columns. Drag to reorder (or use the keyboard:
 * focus a handle, Space, arrows, Space), rename in place, pick an icon (shape and color), choose
 * the default for new tasks and delete (moving the tasks elsewhere). "New stage" creates a plain
 * stage at once and focuses its name; its menu also offers "Create and edit…" (the status dialog:
 * basics, instructions, arrival, while here, exit criteria, moving on, as each row's edit button
 * opens it) and "Create from existing…" (basics, then a stage whose settings it copies). "Copy
 * pipeline from…" copies another project's statuses and rules.
 * `?status=<id>` (a board column's "Edit stage") scrolls to that status and highlights it;
 * `?new=pipeline` (the board's "New pipeline") opens the New pipeline dialog.
 */

export default function StatusesSettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Pipelines', project?.name]);
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
  const canManageAll = access.has('MANAGE_STATUSES');
  const statuses = useStatuses(projectId);
  const pipelines = usePipelines(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const targetId = searchParams.get('status');
  // The pipeline whose stages are shown (BAT-25): `?pipeline=`, the targeted status's, or the default.
  const allStatuses = statuses.data ?? [];
  const pipelineList = pipelines.data ?? [];
  const selected =
    pipelineList.find((pipeline) => pipeline.id === searchParams.get('pipeline')) ??
    pipelineList.find(
      (pipeline) =>
        pipeline.id === allStatuses.find((status) => status.id === targetId)?.pipelineId,
    ) ??
    pipelineList.find((pipeline) => pipeline.isDefault) ??
    pipelineList[0];
  const canManage = selected ? selected.canManage : canManageAll;
  const selectPipeline = (pipelineId: string) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('pipeline', pipelineId);
        next.delete('status');
        return next;
      },
      { replace: true },
    );
  const reorder = useReorderStatuses(projectId);
  const update = useUpdateStatus(projectId);
  const [deleting, setDeleting] = useState<Status | null>(null);
  const [dialog, setDialog] = useState<StatusDialogState>(null);
  const create = useCreateStatus(projectId);
  const [copying, setCopying] = useState(false);
  const [creatingFrom, setCreatingFrom] = useState(false);
  /** The stage "Create" just added: its name is focused for renaming once it shows. */
  const [renameId, setRenameId] = useState<string | null>(null);
  // After "Create" from the menu, the new stage's name takes the focus, not the menu's trigger.
  const keepMenuFocus = useRef(false);
  const principals = usePrincipalOptions(teamId, projectId);
  const difficulties = useDifficulties(projectId);
  const me = useMe();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const header = (
    <SettingsHeader
      title="Pipelines"
      description={
        <>
          Every task sits in a stage of a pipeline: teams → projects → pipelines → stages → tasks.
          Each pipeline has its own board. Its stages are the columns, in order, and their{' '}
          <strong>rules</strong> say what happens there: who gets the task, whether entering it
          resolves fixed issues or releases the claim, whether its tasks still block others or can
          be claimed, and what it takes to move on.
        </>
      }
      actions={
        canManageAll ? (
          <Button variant="outline" size="sm" onClick={() => setCopying(true)}>
            <CopyIcon aria-hidden="true" />
            Copy pipeline from…
          </Button>
        ) : null
      }
    />
  );
  const items = allStatuses.filter(
    (status) => !selected || !status.pipelineId || status.pipelineId === selected.id,
  );
  // "Create": a plain stage at the end, named "New stage" (2, 3…), renamed in place.
  const createNow = () => {
    const name = nextNewStageName(items.map((status) => status.name));
    create.mutate(
      {
        name,
        color: suggestColor(items),
        ...(selected ? { pipelineId: selected.id } : {}),
      },
      {
        onSuccess: (created) => {
          setRenameId(created.id);
          toast.success(`Added ${created.name}: type its name`);
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  };
  const newStage = canManage ? (
    <div className="flex">
      <Button
        size="sm"
        onClick={createNow}
        disabled={create.isPending}
        className="rounded-r-none"
        title="Add a plain stage at the end and rename it here"
      >
        {create.isPending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
        New stage
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            className="rounded-l-none border-l border-l-primary-foreground/25 px-2"
            aria-label="More ways to create a stage"
          >
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-72"
          onCloseAutoFocus={(event) => {
            if (keepMenuFocus.current) event.preventDefault();
            keepMenuFocus.current = false;
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              keepMenuFocus.current = true;
              createNow();
            }}
          >
            <ZapIcon aria-hidden="true" />
            <span className="grid">
              <span>Create</span>
              <span className="text-xs text-muted-foreground">
                A plain stage at the end; name it in the list
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog({ mode: 'create' })}>
            <PencilIcon aria-hidden="true" />
            <span className="grid">
              <span>Create and edit…</span>
              <span className="text-xs text-muted-foreground">
                Set its name and every rule step by step
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCreatingFrom(true)}>
            <CopyPlusIcon aria-hidden="true" />
            <span className="grid">
              <span>Create from existing…</span>
              <span className="text-xs text-muted-foreground">
                Copy the settings of a stage here or in another pipeline
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : null;

  if (statuses.isError) {
    return (
      <>
        {header}
        <ErrorState
          title="Couldn’t load the stages"
          error={statuses.error}
          onRetry={() => void statuses.refetch()}
        />
      </>
    );
  }

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
      {pipelineList.length > 0 ? (
        <PipelinesBar
          projectId={projectId}
          pipelines={pipelineList}
          selectedId={selected?.id}
          onSelect={selectPipeline}
          canAdd={canManageAll}
          statuses={allStatuses}
          options={principals.options}
          startCreating={searchParams.get('new') === 'pipeline' && canManageAll}
          onCreatingChange={(creating) => {
            if (!creating && searchParams.has('new')) {
              setSearchParams(
                (current) => {
                  const next = new URLSearchParams(current);
                  next.delete('new');
                  return next;
                },
                { replace: true },
              );
            }
          }}
        />
      ) : null}
      {canManage ? null : <ReadOnlyNotice permission="Manage statuses" />}
      {/* BAT-34: without a stage that accepts new tasks, none can be created. */}
      {statuses.isSuccess && selected && items.length === 0 ? (
        <NoStagesNotice
          pipelineName={pipelineList.length > 1 ? selected.name : undefined}
          className="mb-5"
        />
      ) : null}
      {statuses.isSuccess && items.length > 0 && !items.some(acceptsNewTasks) ? (
        <NoStartStageNotice
          pipelineName={pipelineList.length > 1 ? selected?.name : undefined}
          className="mb-5"
        />
      ) : null}
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {selected ? `Stages of ${selected.name}` : 'Stages'}
        </h3>
        {newStage}
      </div>
      <SettingsCard>
        <div className="hidden grid-cols-[2rem_2rem_minmax(0,1fr)_4.5rem_5.5rem_4.5rem_4.5rem] items-center gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
          <span />
          <span />
          <span>Name</span>
          <span className="text-center">Default</span>
          <span className="text-center">Start here</span>
          <span className="text-right">Tasks</span>
          <span />
        </div>
        {statuses.isPending ? (
          <StatusesSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            icon={KanbanSquareIcon}
            title="No stages"
            description="Add a stage to give this pipeline's board a column."
            action={newStage ?? undefined}
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
                      renaming={status.id === renameId}
                      onRenamed={() => setRenameId(null)}
                      onDelete={() => setDeleting(status)}
                      onEditRules={() => setDialog({ mode: 'edit', status })}
                    />
                  ))}
                </ul>
              </RadioGroup>
            </SortableContext>
          </DndContext>
        )}
      </SettingsCard>
      <PipelineDiagram statuses={items} />
      <DeleteStatusDialog
        projectId={projectId}
        status={deleting}
        statuses={allStatuses}
        pipelineName={(id) =>
          pipelineList.length > 1
            ? pipelineList.find((pipeline) => pipeline.id === id)?.name
            : undefined
        }
        onClose={() => setDeleting(null)}
      />
      <StatusDialog
        state={dialog}
        statuses={items}
        options={principals.options}
        teamId={teamId}
        canManage={canManage}
        onClose={() => setDialog(null)}
        onCreate={(input) =>
          create.mutateAsync({ ...input, ...(selected ? { pipelineId: selected.id } : {}) })
        }
        onUpdate={(id, input) => update.mutateAsync({ id, input })}
        difficulties={difficulties.data}
      />
      <CreateFromExistingDialog
        open={creatingFrom}
        onOpenChange={setCreatingFrom}
        projectId={projectId}
        pipelineId={selected?.id}
        pipelineName={selected?.name}
        statuses={items}
        teams={me.data?.teams ?? []}
        onCreate={(input) =>
          create.mutateAsync({ ...input, ...(selected ? { pipelineId: selected.id } : {}) })
        }
      />
      <CopyPipelineDialog
        open={copying}
        onOpenChange={setCopying}
        projectId={projectId}
        pipelineId={selected?.id}
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
  renaming = false,
  onRenamed,
  onDelete,
  onEditRules,
}: {
  status: Status;
  projectId: string;
  canManage: boolean;
  isOnly: boolean;
  /** Linked to with `?status=`: scrolled into view, briefly highlighted, name focused. */
  targeted: boolean;
  /** Just added by "Create": its name is focused and selected for renaming. */
  renaming?: boolean;
  onRenamed?: () => void;
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

  useEffect(() => {
    if (!renaming) return;
    const input = nameRef.current;
    input?.scrollIntoView?.({ block: 'nearest' });
    input?.focus({ preventScroll: true });
    input?.select();
    onRenamed?.();
  }, [renaming, onRenamed]);

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
        'grid grid-cols-[2rem_2rem_minmax(0,1fr)_4.5rem] items-center gap-x-2 gap-y-2 border-b bg-card px-3 py-2 last:border-b-0 sm:grid-cols-[2rem_2rem_minmax(0,1fr)_4.5rem_5.5rem_4.5rem_4.5rem]',
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
      <StatusIconPicker
        value={{ icon: status.icon, color: status.color }}
        onChange={(input) => update.mutate({ id: status.id, input })}
        label={`${status.name} icon`}
        disabled={!canManage}
      >
        <button
          type="button"
          disabled={!canManage}
          aria-label={`${status.name} icon: ${STATUS_ICON_SHAPES[status.icon].label}, ${status.color}`}
          className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
        >
          <StatusIcon status={status} className="size-4" />
        </button>
      </StatusIconPicker>
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
          aria-label={`Edit ${status.name}${ruleCount ? ` (${ruleCount} rules set)` : ''}`}
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
                disabled={!canManage}
                aria-label={`Delete ${status.name}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          {isOnly && canManage ? (
            <TooltipContent>
              The last stage: deleting it leaves the pipeline with none
            </TooltipContent>
          ) : null}
        </Tooltip>
      </div>
      <div className="col-span-4 flex flex-wrap items-center gap-x-4 gap-y-2 pl-[4.5rem] sm:contents sm:pl-0">
        <label className="flex items-center gap-2 text-sm sm:justify-center">
          <RadioGroupItem
            value={status.id}
            className="border-muted-foreground/40"
            aria-label={`Make ${status.name} the default status`}
          />
          <span className="text-muted-foreground sm:sr-only">Default</span>
        </label>
        {/* BAT#20: "New tasks can start here" (the stage rule `allowCreate`); several may be on. */}
        <StartHereSwitch
          status={status}
          name={status.name}
          disabled={!canManage}
          // Optimistic; a failure rolls back and toasts (the query client's mutation handler).
          onCheckedChange={(allowCreate) =>
            update.mutate({ id: status.id, input: { rules: { allowCreate } } })
          }
          className="sm:justify-center"
        />
        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums sm:justify-end">
          <FinishedMark status={status} />
          <span className="sm:hidden">{pluralize(status.taskCount, 'task')}</span>
          <span className="hidden sm:inline" aria-label={pluralize(status.taskCount, 'task')}>
            {status.taskCount}
          </span>
        </span>
      </div>
    </li>
  );
}

function DeleteStatusDialog({
  projectId,
  status,
  statuses,
  pipelineName,
  onClose,
}: {
  projectId: string;
  status: Status | null;
  statuses: Status[];
  /** A status's pipeline name, when the project has several (BAT-25). */
  pipelineName: (pipelineId: string | undefined) => string | undefined;
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
            pipelineName={pipelineName}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The Move tasks to choice for a stage without tasks: delete it without moving anything. */
const NO_MOVE = '__none__';

function DeleteStatusForm({
  projectId,
  status,
  others,
  pipelineName,
  onClose,
}: {
  projectId: string;
  status: Status;
  others: Status[];
  pipelineName: (pipelineId: string | undefined) => string | undefined;
  onClose: () => void;
}) {
  const remove = useDeleteStatus(projectId);
  const selectId = useId();
  const same = others.filter((other) => other.pipelineId === status.pipelineId);
  // Its pipeline's last stage: allowed once no task is left in it (a task always has a stage).
  const isLast = same.length === 0;
  const empty = status.taskCount === 0;
  // The column before it in its pipeline (tasks step back one stage), else the one after; with no
  // tasks and no other stage in its pipeline, nothing needs to move.
  const [moveTo, setMoveTo] = useState(() => {
    if (isLast && empty) return NO_MOVE;
    return (
      (
        [...same].reverse().find((other) => other.position < status.position) ??
        same[0] ??
        others[0]
      )?.id ?? ''
    );
  });
  const labelOf = (other: Status) => {
    const pipeline = pipelineName(other.pipelineId);
    return pipeline ? `${pipeline} / ${other.name}` : other.name;
  };
  const [error, setError] = useState<string | null>(null);
  const target = others.find((other) => other.id === moveTo);
  const ready = target !== undefined || (empty && moveTo === NO_MOVE);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    remove.mutate(
      { id: status.id, moveTo: target?.id },
      {
        onSuccess: (result) => {
          toast.success(
            result.movedTasks > 0 && target
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
            : isLast
              ? 'No tasks are in this status.'
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
            {empty ? <SelectItem value={NO_MOVE}>Nowhere (no tasks to move)</SelectItem> : null}
            {others.map((other) => (
              <SelectItem key={other.id} value={other.id}>
                <StatusIcon status={other} />
                {labelOf(other)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status.isDefault && target ? (
          <p className="text-xs text-muted-foreground">
            {status.name} is the default status, so {target.name} becomes the default for new tasks.
          </p>
        ) : null}
        {target && status.taskCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            The tasks enter {target.name}: its hand-off and on-enter rules apply to them.
          </p>
        ) : null}
      </div>
      {isLast ? (
        <SoftWarning title="Last stage.">
          {pipelineName(status.pipelineId) ?? 'This pipeline'} will have no stages: its board stays
          empty and no task can be created in it until you add one.
        </SoftWarning>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={remove.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={!ready || remove.isPending}>
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
