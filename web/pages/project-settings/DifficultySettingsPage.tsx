import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GaugeIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { COLOR_PALETTE, LIMITS } from '@shared/constants';
import { createDifficultyInputSchema, type Difficulty } from '@shared/schemas/projects';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { DifficultyBadge } from '@web/components/common/DifficultyBadge';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
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
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { easiestFirstIds, hardestFirst } from '@web/lib/difficulty';
import { pluralize } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';
import {
  useCreateDifficulty,
  useDeleteDifficulty,
  useDifficulties,
  useReorderDifficulties,
  useUpdateDifficulty,
} from '../projects/difficultyQueries';
import { BoardBackLink, ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/**
 * Project settings → Difficulty (BAT-24): the project's difficulty levels, shown hardest at the top
 * (BAT-30; stored easiest first). A task has one level or none; each person maps levels to the
 * models their agent runs in their own settings for the project (BAT-29, linked from the header).
 * Rename and recolor in place, drag the grip (or use its arrow keys) to reorder, add and delete.
 */
export default function DifficultySettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Difficulty', project?.name]);
  if (!team || !project) return null;
  return (
    <>
      <BoardBackLink team={team} project={project} />
      <Levels
        key={project.id}
        teamId={team.id}
        projectId={project.id}
        mySettingsPath={`/t/${team.slug}/p/${project.key}/me`}
      />
    </>
  );
}

function Levels({
  teamId,
  projectId,
  mySettingsPath,
}: {
  teamId: string;
  projectId: string;
  /** Your settings for this project (BAT-29), where each person maps levels to models. */
  mySettingsPath: string;
}) {
  const access = useProjectAccess(teamId, projectId);
  const canManage = access.has('MANAGE_LABELS');
  const levels = useDifficulties(projectId);
  const reorder = useReorderDifficulties(projectId);
  const remove = useDeleteDifficulty(projectId);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Difficulty | null>(null);
  const items = levels.data ?? [];
  const shown = hardestFirst(items);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = shown.findIndex((level) => level.id === active.id);
    const to = shown.findIndex((level) => level.id === over.id);
    if (from < 0 || to < 0) return;
    const ids = arrayMove(shown, from, to).map((level) => level.id);
    reorder.mutate(easiestFirstIds(ids));
  };

  const newButton = canManage ? (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden="true" />
      New level
    </Button>
  ) : null;

  return (
    <div>
      <SettingsHeader
        title="Difficulty"
        description={
          <>
            How hard a task is, hardest at the top. Each person picks which model their agent uses
            for each level in{' '}
            <Link
              to={mySettingsPath}
              className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
            >
              Your settings for this project
            </Link>{' '}
            (Models by difficulty); a task without a level uses their default.
          </>
        }
        actions={items.length > 0 ? newButton : null}
      />
      {canManage ? null : <ReadOnlyNotice permission="Manage labels" />}
      {levels.isError ? (
        <ErrorState
          title="Couldn’t load the difficulty levels"
          error={levels.error}
          onRetry={() => void levels.refetch()}
        />
      ) : levels.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading difficulty levels">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={GaugeIcon}
          title="No difficulty levels"
          description="Add levels like Easy, Normal and Hard so agents can pick a model to match."
          action={newButton}
        />
      ) : (
        <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
          <DirectionRail />
          <div className="grid gap-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">Hardest</p>
            <SettingsCard>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
                accessibility={{
                  announcements: announcements(shown),
                  screenReaderInstructions: {
                    draggable:
                      'To reorder a level, press Space or Enter to pick it up, use the arrow keys to move it (up is harder), and press Space or Enter again to drop it. Press Escape to cancel.',
                  },
                }}
              >
                <SortableContext
                  items={shown.map((level) => level.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol aria-label="Difficulty levels, hardest first">
                    {shown.map((level) => (
                      <LevelRow
                        key={level.id}
                        level={level}
                        projectId={projectId}
                        canManage={canManage}
                        onDelete={() => setDeleting(level)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </SettingsCard>
            <p className="px-1 text-xs font-medium text-muted-foreground">Easiest</p>
          </div>
        </div>
      )}
      <CreateLevelDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        existing={items}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={`Delete ${deleting?.name ?? 'this level'}?`}
        description={
          deleting?.taskCount
            ? `${pluralize(deleting.taskCount, 'task')} will have no difficulty.`
            : 'No task uses it.'
        }
        confirmLabel="Delete level"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(`Deleted ${deleting.name}`);
          setDeleting(null);
        }}
      />
    </div>
  );
}

/** What screen readers hear while a level is dragged, by name rather than by id. */
function announcements(levels: readonly Difficulty[]): Announcements {
  const name = (id: UniqueIdentifier | undefined) =>
    levels.find((level) => level.id === id)?.name ?? 'the level';
  const at = (active: UniqueIdentifier, over: UniqueIdentifier | undefined) =>
    over === undefined || over === active
      ? `${name(active)} is in its original place.`
      : `${name(active)} is at ${name(over)}’s place.`;
  return {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
    onDragOver: ({ active, over }) => at(active.id, over?.id),
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id
        ? `Dropped ${name(active.id)} at ${name(over.id)}’s place.`
        : `Dropped ${name(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled. ${name(active.id)} stays where it was.`,
  };
}

/** A thin gradient bar beside the list, dark (hardest) at the top fading to light (easiest). */
function DirectionRail() {
  return (
    <div aria-hidden="true" className="flex flex-col items-center py-1.5">
      <span className="size-1.5 rounded-full bg-muted-foreground" />
      <span className="w-0.5 flex-1 rounded-full bg-gradient-to-b from-muted-foreground to-muted-foreground/15" />
      <span className="size-1.5 rounded-full bg-muted-foreground/15" />
    </div>
  );
}

function LevelRow({
  level,
  projectId,
  canManage,
  onDelete,
}: {
  level: Difficulty;
  projectId: string;
  canManage: boolean;
  onDelete: () => void;
}) {
  const update = useUpdateDifficulty(projectId);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: level.id, disabled: !canManage });
  const [name, setName] = useState(level.name);
  const [saved, setSaved] = useState(level.name);
  if (level.name !== saved) {
    setSaved(level.name);
    setName(level.name);
  }
  const commit = () => {
    const next = name.trim();
    if (!next || next === level.name) {
      setName(level.name);
      return;
    }
    update.mutate(
      { id: level.id, input: { name: next } },
      {
        onError: (cause) => {
          toast.error(errorMessage(cause));
          setName(level.name);
        },
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setName(level.name);
      event.currentTarget.blur();
    }
  };
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'flex items-center gap-2 border-b bg-card px-3 py-2 last:border-b-0',
        isDragging && 'relative z-10 rounded-md shadow-lg ring-1 ring-border',
      )}
      data-testid="difficulty-row"
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={!canManage}
        aria-label={`Reorder ${level.name}`}
        className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <GripVerticalIcon className="size-4" aria-hidden="true" />
      </button>
      <ColorPicker
        value={level.color}
        onChange={(color) => update.mutate({ id: level.id, input: { color } })}
        label={`${level.name} color`}
        disabled={!canManage}
      >
        <button
          type="button"
          disabled={!canManage}
          aria-label={`${level.name} color: ${level.color}`}
          className="flex size-8 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
        >
          <DifficultyBadge difficulty={{ name: '', color: level.color }} />
        </button>
      </ColorPicker>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        disabled={!canManage}
        maxLength={LIMITS.labelName.max}
        aria-label={`Name of level ${level.name}`}
        className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 shadow-none hover:border-input focus-visible:border-ring disabled:cursor-default disabled:opacity-100 dark:bg-transparent"
      />
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {pluralize(level.taskCount, 'task')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!canManage}
        aria-label={`Delete ${level.name}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={onDelete}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    </li>
  );
}

function CreateLevelDialog({
  open,
  onOpenChange,
  projectId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The current levels, easiest first (API order). */
  existing: readonly Difficulty[];
}) {
  const create = useCreateDifficulty(projectId);
  const reorder = useReorderDifficulties(projectId);
  const nameId = useId();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [at, setAt] = useState<'easiest' | 'hardest'>('easiest');
  const [error, setError] = useState<string | null>(null);
  const suggested =
    COLOR_PALETTE.find((option) => !existing.some((level) => level.color === option.hex))?.hex ??
    COLOR_PALETTE[0].hex;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = createDifficultyInputSchema.safeParse({ name, color: color || suggested });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the name');
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (level) => {
        toast.success(`Added ${level.name}`);
        // The server adds a level as the hardest; move it to the easiest end unless asked not to.
        if (at === 'easiest' && existing.length > 0) {
          reorder.mutate([level.id, ...existing.map((item) => item.id)]);
        }
        setName('');
        setColor('');
        setAt('easiest');
        setError(null);
        onOpenChange(false);
      },
      onError: (cause) => setError(errorMessage(cause)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New difficulty level</DialogTitle>
            <DialogDescription>
              Drag it elsewhere in the list afterwards if needed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <div className="flex items-center gap-2">
              <ColorPicker value={color || suggested} onChange={setColor} label="Level color">
                <button
                  type="button"
                  aria-label={`Color: ${color || suggested}`}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md border outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <DifficultyBadge difficulty={{ name: '', color: color || suggested }} />
                </button>
              </ColorPicker>
              <Input
                id={nameId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={LIMITS.labelName.max}
                placeholder="e.g. Expert"
                autoFocus
                aria-invalid={error ? true : undefined}
              />
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Add as</legend>
            <RadioGroup
              value={at}
              onValueChange={(next) => setAt(next === 'hardest' ? 'hardest' : 'easiest')}
              className="flex gap-4"
            >
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="easiest" />
                Easiest
              </Label>
              <Label className="flex items-center gap-2 font-normal">
                <RadioGroupItem value="hardest" />
                Hardest
              </Label>
            </RadioGroup>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? <Spinner /> : null}
              Add level
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
