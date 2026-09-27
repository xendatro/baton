import { ArrowDownIcon, ArrowUpIcon, GaugeIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
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
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { pluralize } from '@web/lib/format';
import { useProjectAccess } from '@web/lib/permissions';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import {
  useCreateDifficulty,
  useDeleteDifficulty,
  useDifficulties,
  useReorderDifficulties,
  useUpdateDifficulty,
} from '../projects/difficultyQueries';
import { BoardBackLink, ReadOnlyNotice, SettingsCard, SettingsHeader } from './common';

/**
 * Project settings → Difficulty (BAT-24): the project's difficulty levels, easiest first. A task
 * has one level or none; each person maps levels to the models their agent runs (Account
 * settings). Rename and recolor in place, move up and down, add and delete.
 */
export default function DifficultySettingsPage() {
  const { team, project } = useRouteContext();
  useDocumentTitle(['Difficulty', project?.name]);
  if (!team || !project) return null;
  return (
    <>
      <BoardBackLink team={team} project={project} />
      <Levels key={project.id} teamId={team.id} projectId={project.id} />
    </>
  );
}

function Levels({ teamId, projectId }: { teamId: string; projectId: string }) {
  const access = useProjectAccess(teamId, projectId);
  const canManage = access.has('MANAGE_LABELS');
  const levels = useDifficulties(projectId);
  const reorder = useReorderDifficulties(projectId);
  const remove = useDeleteDifficulty(projectId);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Difficulty | null>(null);
  const items = levels.data ?? [];

  const move = (index: number, by: -1 | 1) => {
    const ids = items.map((level) => level.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(index + by, 0, moved);
    reorder.mutate(ids, { onError: (cause) => toast.error(errorMessage(cause)) });
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
        description="How hard a task is, easiest first. Each person picks which model their agent uses for each level (Account settings → Agent); a task without a level uses their default."
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
        <SettingsCard>
          <ol aria-label="Difficulty levels, easiest first">
            {items.map((level, index) => (
              <LevelRow
                key={level.id}
                level={level}
                projectId={projectId}
                canManage={canManage}
                first={index === 0}
                last={index === items.length - 1}
                onMove={(by) => move(index, by)}
                onDelete={() => setDeleting(level)}
              />
            ))}
          </ol>
        </SettingsCard>
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

function LevelRow({
  level,
  projectId,
  canManage,
  first,
  last,
  onMove,
  onDelete,
}: {
  level: Difficulty;
  projectId: string;
  canManage: boolean;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const update = useUpdateDifficulty(projectId);
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
    <li className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
      <div className="flex flex-col">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5"
          disabled={!canManage || first}
          aria-label={`Move ${level.name} easier`}
          onClick={() => onMove(-1)}
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-5"
          disabled={!canManage || last}
          aria-label={`Move ${level.name} harder`}
          onClick={() => onMove(1)}
        >
          <ArrowDownIcon aria-hidden="true" />
        </Button>
      </div>
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
  existing: readonly Difficulty[];
}) {
  const create = useCreateDifficulty(projectId);
  const nameId = useId();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
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
        setName('');
        setColor('');
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
            <DialogDescription>It’s added as the hardest; move it afterwards.</DialogDescription>
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
