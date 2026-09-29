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
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CornerUpLeftIcon,
  FlagIcon,
  GripVerticalIcon,
  ListChecksIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  UserIcon,
} from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { DEFAULT_STAGE_RULES, type StageRules } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { backStagesOf, nextStageOf } from '@shared/stageMoves';
import { StatusIcon } from '@web/components/common/StatusBadge';
import type { PrincipalOptions } from '@web/components/pickers/principals';
import { pluralize } from '@web/lib/format';
import { acceptsNewTasks } from '@web/lib/newTaskStages';
import { cn } from '@web/lib/utils';
import { isAgentStage, stageAgents, whoSentence, whoSummary } from './simpleStage';
import { principalLabel } from '@web/components/pickers/principals';

/**
 * The visual pipeline editor (2026-09-29): one pipeline's stages left to right (top to bottom on
 * narrow screens), joined by arrows for the forward move. Each stage is a button showing who works
 * there, what it takes to move on and whether an agent does it; clicking it opens the stage panel.
 * A "+" between two stages (and after the last) adds a stage there. Drag a stage's handle (or focus
 * it and use Space and the arrow keys) to reorder; Left/Right move the focus between stages.
 */

export interface PipelineEditorProps {
  stages: readonly Status[];
  options: PrincipalOptions;
  canManage: boolean;
  /** The stage whose panel is open. */
  selectedId: string | null;
  onSelect: (status: Status) => void;
  /** Adds a stage at `index` (0 = first). */
  onAddAt: (index: number) => void;
  adding: boolean;
  onReorder: (statusIds: string[]) => void;
}

export function PipelineEditor({
  stages,
  options,
  canManage,
  selectedId,
  onSelect,
  onAddAt,
  adding,
  onReorder,
}: PipelineEditorProps) {
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const moves = stages.map((status) => ({
    ...status,
    nextStatusId: status.rules?.nextStatusId ?? null,
    sendBackTo: status.rules?.sendBackTo ?? [],
  }));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = stages.findIndex((status) => status.id === active.id);
    const to = stages.findIndex((status) => status.id === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove([...stages], from, to).map((status) => status.id));
  };

  const focusSibling = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : event.key === 'Home'
            ? -index
            : event.key === 'End'
              ? stages.length - 1 - index
              : 0;
    if (step === 0) return;
    const target = stages[Math.max(0, Math.min(stages.length - 1, index + step))];
    if (!target) return;
    event.preventDefault();
    nodeRefs.current.get(target.id)?.focus();
  };

  return (
    <section aria-label="Pipeline editor" data-testid="pipeline-editor">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              'To move a stage, press Space or Enter to pick it up, use the arrow keys to move it, and press Space or Enter again to drop it. Press Escape to cancel.',
          },
        }}
      >
        <SortableContext items={stages.map((status) => status.id)} strategy={rectSortingStrategy}>
          <ol className="flex flex-col items-stretch gap-0 sm:flex-row sm:flex-wrap sm:items-stretch sm:gap-y-4">
            {moves.map((stage, index) => {
              const next = nextStageOf(moves, stage);
              const following = moves[index + 1];
              return (
                <StageNode
                  key={stage.id}
                  status={stages[index] ?? stage}
                  index={index}
                  options={options}
                  canManage={canManage}
                  selected={stage.id === selectedId}
                  jumpTo={next && next.id !== following?.id ? next.name : null}
                  isLast={!next}
                  back={backStagesOf(moves, stage).map((item) => item.name)}
                  onSelect={() => onSelect(stages[index] ?? stage)}
                  onKeyDown={(event) => focusSibling(index, event)}
                  nodeRef={(node) => {
                    if (node) nodeRefs.current.set(stage.id, node);
                    else nodeRefs.current.delete(stage.id);
                  }}
                  connector={
                    <Connector
                      forward={Boolean(following && next?.id === following.id)}
                      last={!following}
                      canAdd={canManage}
                      adding={adding}
                      label={
                        following
                          ? `Add a stage between ${stage.name} and ${following.name}`
                          : `Add a stage after ${stage.name}`
                      }
                      toName={following?.name}
                      onAdd={() => onAddAt(index + 1)}
                    />
                  }
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      <p className="mt-3 text-xs text-muted-foreground">
        Click a stage to edit it.{' '}
        {canManage ? 'Drag the handle to reorder; + adds a stage there.' : null}
      </p>
    </section>
  );
}

function StageNode({
  status,
  index,
  options,
  canManage,
  selected,
  jumpTo,
  isLast,
  back,
  onSelect,
  onKeyDown,
  nodeRef,
  connector,
}: {
  status: Status;
  index: number;
  options: PrincipalOptions;
  canManage: boolean;
  selected: boolean;
  /** The forward move skips to a later stage: its name. */
  jumpTo: string | null;
  isLast: boolean;
  /** Earlier stages it can send tasks back to, nearest first. */
  back: string[];
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  nodeRef: (node: HTMLButtonElement | null) => void;
  connector: ReactNode;
}) {
  const rules: StageRules = status.rules ?? DEFAULT_STAGE_RULES;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id, disabled: !canManage });
  const agent = isAgentStage(rules, options);
  const agents = stageAgents(rules, options).map((principal) => principalLabel(principal, options));
  const criteria = rules.exitCriteria.length;
  const approvals = rules.approvals?.count ?? 0;
  const starts = acceptsNewTasks(status);
  const finished = !rules.blocksDependents;
  const summary = [
    `Stage ${index + 1}: ${status.name}`,
    agent ? `An agent does it: ${agents.join(', ')}` : whoSentence(rules, options),
    criteria ? pluralize(criteria, 'check') + ' to move on' : null,
    approvals ? `needs ${pluralize(approvals, 'approval')}` : null,
    rules.instructions.trim() ? 'has instructions' : null,
    starts ? 'new tasks can start here' : null,
    finished ? 'counts as finished' : null,
    jumpTo ? `moves on to ${jumpTo}` : null,
    back.length ? `can send back to ${back.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex flex-col items-stretch sm:flex-row', isDragging && 'relative z-10')}
      data-testid="stage-node"
    >
      <div
        className={cn(
          'group relative flex w-full rounded-lg border bg-card shadow-xs transition-colors sm:w-44',
          selected ? 'border-primary ring-2 ring-primary/30' : 'hover:border-foreground/25',
          isDragging && 'shadow-lg',
        )}
      >
        {canManage ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Move ${status.name}`}
            className="flex w-5 shrink-0 cursor-grab items-center justify-center rounded-l-lg text-muted-foreground/60 outline-none hover:bg-accent hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          ref={nodeRef}
          onClick={onSelect}
          onKeyDown={onKeyDown}
          aria-label={summary}
          aria-haspopup="dialog"
          data-selected={selected || undefined}
          className={cn(
            'grid min-w-0 flex-1 content-start gap-1.5 rounded-lg p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring',
            !canManage && 'pl-3',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            <StatusIcon status={status} className="size-4 shrink-0" />
            <span className="truncate">{status.name}</span>
            {starts ? (
              <PlayIcon
                className="ml-auto size-3 shrink-0 text-sky-600 dark:text-sky-400"
                aria-hidden="true"
              />
            ) : null}
            {finished ? (
              <FlagIcon
                className={cn(
                  'size-3 shrink-0 text-emerald-600 dark:text-emerald-400',
                  !starts && 'ml-auto',
                )}
                aria-hidden="true"
              />
            ) : null}
          </span>
          <span className="flex flex-wrap gap-1" aria-hidden="true">
            {agent ? (
              <Badge
                icon={BotIcon}
                className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                testId="badge-agent"
              >
                {agents.length === 1 ? agents[0] : `${agents.length} agents`}
              </Badge>
            ) : (
              <Badge icon={UserIcon} testId="badge-who">
                {whoSummary(rules, options)}
              </Badge>
            )}
            {criteria ? (
              <Badge icon={ListChecksIcon} testId="badge-criteria">
                {criteria}
              </Badge>
            ) : null}
            {approvals ? (
              <Badge
                icon={ShieldCheckIcon}
                className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                testId="badge-approval"
              >
                {approvals === 1 ? 'Approval' : `${approvals} approvals`}
              </Badge>
            ) : null}
          </span>
          {jumpTo ? (
            <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <ArrowRightIcon className="size-3" aria-hidden="true" />
              {jumpTo}
            </span>
          ) : null}
          {back.length ? (
            <span
              className="flex items-center gap-1 truncate text-xs text-muted-foreground"
              title={`Can send tasks back to ${back.join(', ')}`}
            >
              <CornerUpLeftIcon className="size-3 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="truncate">{back.join(', ')}</span>
            </span>
          ) : null}
          {isLast && finished ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2Icon className="size-3" aria-hidden="true" />
              Finished
            </span>
          ) : null}
        </button>
      </div>
      {connector}
    </li>
  );
}

function Badge({
  icon: Icon,
  className,
  testId,
  children,
}: {
  icon: typeof UserIcon;
  className?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-[0.7rem] leading-none font-medium text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The arrow to the next stage, with a "+" to add a stage there. */
function Connector({
  forward,
  last,
  canAdd,
  adding,
  label,
  toName,
  onAdd,
}: {
  /** The forward move goes to the next column (else it skips: a faded arrow). */
  forward: boolean;
  last: boolean;
  canAdd: boolean;
  adding: boolean;
  label: string;
  toName: string | undefined;
  onAdd: () => void;
}) {
  if (last && !canAdd) return null;
  return (
    <div className="flex items-center justify-center py-1 sm:w-10 sm:py-0">
      <div className="relative flex flex-col items-center gap-0.5 sm:flex-row">
        {!last ? (
          <>
            <ArrowDownIcon
              className={cn('size-4 sm:hidden', arrowClass(forward))}
              aria-hidden="true"
            />
            <ArrowRightIcon
              className={cn('hidden size-4 sm:block', arrowClass(forward))}
              aria-hidden="true"
            />
            <span className="sr-only">
              {forward ? `then ${toName ?? ''}` : `next column: ${toName ?? ''}`}
            </span>
          </>
        ) : null}
        {canAdd ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={adding}
            aria-label={label}
            title={label}
            className={cn(
              'flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground outline-none hover:border-primary hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              !last && 'sm:absolute sm:top-5 sm:left-1/2 sm:-translate-x-1/2',
            )}
          >
            <PlusIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function arrowClass(forward: boolean) {
  return forward ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40';
}
