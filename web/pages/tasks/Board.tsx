import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PlusIcon } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { BoardColumn, BoardResponse, TaskCard } from '@shared/schemas/tasks';
import { StatusIcon } from '@web/components/common/StatusBadge';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { cn } from '@web/lib/utils';
import { columnOfItem, COLUMN_PREFIX, dropTarget, layoutOf, type Layout } from './helpers';
import type { MoveVariables } from './queries';
import { TaskCardBody } from './TaskCard';

/**
 * The board (SPEC §1.9): a column per status, cards in board order. Cards are dragged within and
 * between columns with the mouse, touch or keyboard (focus a card, Space to pick it up, arrows to
 * move, Space to drop, Escape to cancel); Enter opens the task. Moves are optimistic.
 */

/** Sizes the board to the rest of the viewport, so columns scroll on their own. */
function useFillViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      setHeight(Math.max(360, window.innerHeight - top - 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return { ref, height };
}

export interface BoardProps {
  board: BoardResponse;
  canMove: boolean;
  canCreate: boolean;
  onMove: (move: MoveVariables) => void;
  onQuickAdd: (statusId: string) => void;
  /** True while filters are applied (empty columns say "No matching tasks"). */
  filtered: boolean;
}

export function Board({ board, canMove, canCreate, onMove, onQuickAdd, filtered }: BoardProps) {
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const layout = dragLayout ?? layoutOf(board);
  const cards = useMemo(
    () => new Map(board.columns.flatMap((column) => column.tasks.map((task) => [task.id, task]))),
    [board],
  );
  const statusNames = useMemo(
    () => new Map(board.columns.map((column) => [column.status.id, column.status.name])),
    [board],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter opens the task; Space picks it up and drops it.
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const { ref, height } = useFillViewport();

  const describe = (id: UniqueIdentifier) => cards.get(String(id))?.ref ?? 'task';
  const place = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return 'nowhere';
    const statusId = columnOfItem(layout, id);
    const column = statusId ? (layout[statusId] ?? []) : [];
    const position = column.indexOf(String(id)) + 1;
    const name = statusId ? statusNames.get(statusId) : undefined;
    return name ? `${name}${position > 0 ? `, position ${position} of ${column.length}` : ''}` : '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describe(active.id)} in ${place(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${describe(active.id)} is now in ${place(active.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${describe(active.id)} in ${place(active.id)}.`
        : `Dropped ${describe(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${describe(active.id)}.`,
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setDragLayout(layoutOf(board));
  };

  // Moving across columns while dragging keeps the card under the pointer.
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setDragLayout((current) => {
      const base = current ?? layoutOf(board);
      const from = columnOfItem(base, active.id);
      const to = columnOfItem(base, over.id);
      if (!from || !to || from === to) return base;
      const source = (base[from] ?? []).filter((id) => id !== String(active.id));
      const target = [...(base[to] ?? [])];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex === -1 ? target.length : overIndex, 0, String(active.id));
      return { ...base, [from]: source, [to]: target };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const before = layoutOf(board);
    let after = dragLayout ?? before;
    if (over) {
      const statusId = columnOfItem(after, active.id);
      const column = statusId ? (after[statusId] ?? []) : [];
      const from = column.indexOf(String(active.id));
      const to = column.indexOf(String(over.id));
      if (statusId && from !== -1 && to !== -1 && from !== to) {
        const next = [...column];
        next.splice(from, 1);
        next.splice(to, 0, String(active.id));
        after = { ...after, [statusId]: next };
      }
    }
    setActiveId(null);
    setDragLayout(null);
    if (!over) return;
    const move = dropTarget(before, after, String(active.id));
    if (move) onMove({ taskId: String(active.id), ...move });
  };

  const active = activeId ? cards.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setDragLayout(null);
      }}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'Press Enter to open the task. To move it, press Space, use the arrow keys to move between cards and columns, then press Space again to drop it, or Escape to cancel.',
        },
      }}
    >
      <div
        ref={ref}
        style={height ? { height } : undefined}
        className="relative flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-3 sm:snap-none sm:px-6"
        role="region"
        aria-label="Board"
      >
        {board.columns.map((column) => (
          <Column
            key={column.status.id}
            column={column}
            ids={layout[column.status.id] ?? []}
            cards={cards}
            canMove={canMove}
            canCreate={canCreate}
            onQuickAdd={onQuickAdd}
            filtered={filtered}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {active ? (
          <div className="w-[17rem] rotate-1 cursor-grabbing rounded-lg border bg-card p-3 shadow-lg">
            <TaskCardBody task={active} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface ColumnProps {
  column: BoardColumn;
  ids: string[];
  cards: Map<string, TaskCard>;
  canMove: boolean;
  canCreate: boolean;
  onQuickAdd: (statusId: string) => void;
  filtered: boolean;
}

function Column({ column, ids, cards, canMove, canCreate, onQuickAdd, filtered }: ColumnProps) {
  const { status } = column;
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${status.id}` });
  const hidden = column.count - column.tasks.length;
  const headingId = `column-${status.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex max-h-full w-[85vw] max-w-[18.5rem] shrink-0 snap-start flex-col rounded-xl bg-muted/50 sm:w-72 dark:bg-muted/30"
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <StatusIcon status={status} />
        <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold">
          {status.name}
        </h2>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          aria-label={`${column.count} tasks`}
        >
          {column.count}
        </span>
        {canCreate ? (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7 text-muted-foreground"
            onClick={() => onQuickAdd(status.id)}
            aria-label={`New task in ${status.name}`}
          >
            <PlusIcon aria-hidden="true" />
          </Button>
        ) : null}
      </header>
      <SortableContext id={status.id} items={ids} strategy={verticalListSortingStrategy}>
        <ol
          ref={setNodeRef}
          className={cn(
            'relative flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-b-xl px-2 pb-2',
            isOver && ids.length === 0 && 'bg-primary/5',
          )}
        >
          {ids.map((id) => {
            const card = cards.get(id);
            return card ? <SortableCard key={id} task={card} disabled={!canMove} /> : null;
          })}
          {ids.length === 0 ? (
            <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {filtered ? 'No matching tasks' : 'No tasks'}
            </li>
          ) : null}
          {hidden > 0 ? (
            <li className="px-2 py-1 text-center text-xs text-muted-foreground">
              {hidden} more — switch to the list or narrow the filters
            </li>
          ) : null}
        </ol>
      </SortableContext>
    </section>
  );
}

function SortableCard({ task, disabled }: { task: TaskCard; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  // Keep the link semantics (Enter opens it); dnd-kit's role="button" would hide them.
  const { role: _role, ...dragAttributes } = attributes;
  return (
    <li
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
    >
      <Link
        ref={setNodeRef}
        to={task.path}
        {...dragAttributes}
        {...listeners}
        className={cn(
          'block rounded-lg border bg-card p-3 shadow-xs transition-colors outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring',
          !disabled && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <TaskCardBody task={task} />
      </Link>
    </li>
  );
}

export function BoardSkeleton() {
  return (
    <div
      className="flex gap-3 overflow-hidden px-4 sm:px-6"
      role="status"
      aria-label="Loading board"
    >
      {[5, 3, 4, 2].map((count, index) => (
        <div
          key={index}
          className="flex w-[85vw] max-w-[18.5rem] shrink-0 flex-col gap-2 rounded-xl bg-muted/50 p-2 sm:w-72"
        >
          <Skeleton className="m-1 h-5 w-24" />
          {Array.from({ length: count }, (_, card) => (
            <Skeleton key={card} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}
