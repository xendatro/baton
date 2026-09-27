import {
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
 *
 * Touch drags start with a press-and-hold (TOUCH_DRAG_DELAY_MS), so a swipe still scrolls the board
 * and its columns: a pointer sensor would lose every touch to the browser's pan gesture.
 */

/** Hold time before a touch starts dragging a card, and how far the finger may drift meanwhile. */
export const TOUCH_DRAG_DELAY_MS = 250;
const TOUCH_DRAG_TOLERANCE_PX = 8;

/** How long after a keyboard drop the moved card gets focus back as the board re-renders. */
const REFOCUS_WINDOW_MS = 3000;

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
  // BAT-7: after a drop the dropped layout stays until the board data changes. The optimistic
  // move lands a tick later, and meanwhile the card rendered in its old column, so the drop
  // animation flew a ghost of it back there.
  const [settling, setSettling] = useState<{ layout: Layout; board: BoardResponse } | null>(null);
  const layout =
    dragLayout ?? (settling?.board === board ? settling.layout : null) ?? layoutOf(board);
  const cards = useMemo(
    () => new Map(board.columns.flatMap((column) => column.tasks.map((task) => [task.id, task]))),
    [board],
  );
  const statusNames = useMemo(
    () => new Map(board.columns.map((column) => [column.status.id, column.status.name])),
    [board],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: TOUCH_DRAG_DELAY_MS, tolerance: TOUCH_DRAG_TOLERANCE_PX },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter opens the task; Space picks it up and drops it.
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const movedColumn = useRef(false);
  useEffect(() => {
    if (!movedColumn.current) return;
    const frame = requestAnimationFrame(() => {
      movedColumn.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [dragLayout]);
  const { ref, height } = useFillViewport();
  const refocus = useRefocusMovedCard(ref);

  const describe = (id: UniqueIdentifier) => cards.get(String(id))?.ref ?? 'task';
  const place = (id: UniqueIdentifier) => {
    const statusId = columnOfItem(layout, id);
    const column = statusId ? (layout[statusId] ?? []) : [];
    const position = column.indexOf(String(id)) + 1;
    const name = statusId ? (statusNames.get(statusId) ?? '') : '';
    return position > 0 ? `${name}, position ${position} of ${column.length}` : name;
  };
  /** What the card is over: another card ("RKT-2 in Open") or a column ("the Done column"). */
  const target = (id: UniqueIdentifier) => {
    const value = String(id);
    if (value.startsWith(COLUMN_PREFIX)) {
      return `the ${statusNames.get(value.slice(COLUMN_PREFIX.length)) ?? ''} column`;
    }
    const statusId = columnOfItem(layout, id);
    return `${describe(id)} in ${statusId ? (statusNames.get(statusId) ?? '') : ''}`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describe(active.id)} in ${place(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over && over.id !== active.id
        ? `${describe(active.id)} is over ${target(over.id)}.`
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${describe(active.id)} on ${target(over.id)}.`
        : `Dropped ${describe(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled moving ${describe(active.id)}.`,
  };

  /**
   * Where a dragged card is: the card under it (pointer first, else the largest overlap, which is
   * what keyboard moves produce) or, over a column's empty space, the column's nearest card.
   */
  const collisionDetection: CollisionDetection = (args) => {
    // BAT-17: right after the card moved to another column, keep it where it is until that layout
    // has painted. Otherwise the shifted cards can put it "over" the old column again, and the two
    // moves repeat on every render until React stops with "Maximum update depth exceeded" (#185).
    if (movedColumn.current && args.active) return [{ id: args.active.id }];
    const pointer = pointerWithin(args);
    const hits = pointer.length > 0 ? pointer : rectIntersection(args);
    const overId = getFirstCollision(hits, 'id');
    if (overId === null) return [];
    const value = String(overId);
    if (value.startsWith(COLUMN_PREFIX)) {
      const items = layout[value.slice(COLUMN_PREFIX.length)] ?? [];
      if (items.length > 0) {
        const nearest = closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter((container) =>
            items.includes(String(container.id)),
          ),
        });
        return nearest.length > 0 ? nearest.slice(0, 1) : [{ id: overId }];
      }
    }
    return [{ id: overId }];
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setSettling(null);
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
      movedColumn.current = true;
      const source = (base[from] ?? []).filter((id) => id !== String(active.id));
      const target = [...(base[to] ?? [])];
      const overIndex = target.indexOf(String(over.id));
      target.splice(overIndex === -1 ? target.length : overIndex, 0, String(active.id));
      return { ...base, [from]: source, [to]: target };
    });
  };

  const onDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    // A keyboard move re-renders the card in its new column (a new element), which drops focus.
    if (activatorEvent instanceof KeyboardEvent) refocus(String(active.id));
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
    const move = over ? dropTarget(before, after, String(active.id)) : null;
    setSettling(move ? { layout: after, board } : null);
    if (move) onMove({ taskId: String(active.id), ...move });
  };

  const active = activeId ? cards.get(activeId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={({ active, activatorEvent }) => {
        if (activatorEvent instanceof KeyboardEvent) refocus(String(active.id));
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
      {/* No rotation or scaling: keyboard moves compare the overlay's rect with the cards'. */}
      <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
        {active ? (
          <div className="w-[17rem] cursor-grabbing rounded-lg border bg-card p-3 shadow-lg ring-2 ring-primary/30">
            <TaskCardBody task={active} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Keeps focus on a card moved with the keyboard. The card is re-created in each column it passes
 * through and again when the optimistic move lands, and focus falls to <body> each time the
 * focused copy unmounts; for a moment after the drop, focus follows the card instead. Anything
 * else the viewer focuses meanwhile wins.
 */
function useRefocusMovedCard(board: RefObject<HTMLElement | null>) {
  const pending = useRef<{ id: string; until: number } | null>(null);
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    if (Date.now() > target.until) {
      pending.current = null;
      return;
    }
    const card = board.current?.querySelector<HTMLElement>(
      `[data-task-id="${globalThis.CSS.escape(target.id)}"]`,
    );
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (card && card !== active && lost) card.focus();
  });
  // Every move of the card is a render of the board, so the effect above sees each one.
  return (id: string) => {
    pending.current = { id, until: Date.now() + REFOCUS_WINDOW_MS };
  };
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
        data-task-id={task.id}
        {...dragAttributes}
        {...listeners}
        // Holding a card on a touch screen picks it up: no link menu over the drag.
        onContextMenu={isDragging ? (event) => event.preventDefault() : undefined}
        className={cn(
          'block rounded-lg border bg-card p-3 shadow-xs transition-colors outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring',
          !disabled &&
            'cursor-grab touch-manipulation select-none [-webkit-touch-callout:none] active:cursor-grabbing',
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
