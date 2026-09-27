import type { UniqueIdentifier } from '@dnd-kit/core';
import { PRIORITIES } from '@shared/constants';
import type { Status } from '@shared/schemas/projects';
import type { BoardResponse, TaskCard } from '@shared/schemas/tasks';
import type { ListGroup } from './filters';
import type { MoveVariables } from './queries';

/** Pure helpers of the board, the list and the claim panel (unit-tested in helpers.test.ts). */

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

export const COLUMN_PREFIX = 'column:';

export type Layout = Record<string, string[]>;

export function layoutOf(board: BoardResponse): Layout {
  return Object.fromEntries(
    board.columns.map((column) => [column.status.id, column.tasks.map((task) => task.id)]),
  );
}

export function columnOfItem(layout: Layout, id: UniqueIdentifier): string | undefined {
  const value = String(id);
  if (value.startsWith(COLUMN_PREFIX)) return value.slice(COLUMN_PREFIX.length);
  return Object.keys(layout).find((statusId) => layout[statusId]?.includes(value));
}

/**
 * The move a drop makes: the card's column and neighbours in `layout` (the arrangement after the
 * drag), or null when it ends where it started.
 */
export function dropTarget(
  before: Layout,
  after: Layout,
  taskId: string,
): Omit<MoveVariables, 'taskId'> | null {
  const statusId = columnOfItem(after, taskId);
  if (!statusId) return null;
  const column = after[statusId] ?? [];
  const index = column.indexOf(taskId);
  const from = columnOfItem(before, taskId);
  if (from === statusId && (before[statusId] ?? []).indexOf(taskId) === index) return null;
  const afterId = index > 0 ? column[index - 1] : undefined;
  const beforeId = afterId === undefined ? column[index + 1] : undefined;
  return { statusId, index, afterId, beforeId };
}

// ---------------------------------------------------------------------------------------------
// List groups
// ---------------------------------------------------------------------------------------------

export interface TaskGroup {
  key: string;
  label: string;
  /** Leading visual of the group heading. */
  kind: 'status' | 'priority' | 'user' | 'role' | 'none';
  color?: string | null;
  status?: Status;
  priority?: number;
  tasks: TaskCard[];
}

/** Groups tasks for the list; empty groups are left out. Exported for tests. */
export function groupTasks(
  tasks: readonly TaskCard[],
  group: ListGroup,
  statuses: readonly Status[],
): TaskGroup[] {
  if (group === 'none')
    return [{ key: 'all', label: 'All tasks', kind: 'none', tasks: [...tasks] }];
  if (group === 'status') {
    const known = statuses.map((status) => ({
      key: status.id,
      label: status.name,
      kind: 'status' as const,
      status,
      tasks: tasks.filter((task) => task.status.id === status.id),
    }));
    return known.filter((entry) => entry.tasks.length > 0);
  }
  if (group === 'priority') {
    return [...PRIORITIES]
      .reverse()
      .map((priority) => ({
        key: String(priority.value),
        label: priority.label,
        kind: 'priority' as const,
        priority: priority.value,
        tasks: tasks.filter((task) => task.priority === priority.value),
      }))
      .filter((entry) => entry.tasks.length > 0);
  }
  const groups = new Map<string, TaskGroup>();
  const unassigned: TaskCard[] = [];
  for (const task of tasks) {
    const { users, roles } = task.assignees;
    if (users.length === 0 && roles.length === 0) unassigned.push(task);
    for (const user of users) {
      const entry = groups.get(`user:${user.id}`) ?? {
        key: `user:${user.id}`,
        label: user.name,
        kind: 'user' as const,
        tasks: [],
      };
      entry.tasks.push(task);
      groups.set(entry.key, entry);
    }
    for (const role of roles) {
      const entry = groups.get(`role:${role.id}`) ?? {
        key: `role:${role.id}`,
        label: role.name,
        kind: 'role' as const,
        color: role.color,
        tasks: [],
      };
      entry.tasks.push(task);
      groups.set(entry.key, entry);
    }
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'user' ? -1 : 1) || a.label.localeCompare(b.label),
  );
  return unassigned.length
    ? [...sorted, { key: 'unassigned', label: 'Unassigned', kind: 'none', tasks: unassigned }]
    : sorted;
}

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

/** "Claimed just now", "Claimed 12m ago", "Claimed 3h ago", "Claimed 2d ago". */
export function claimedAgo(claimedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(claimedAt)) / 60_000);
  if (minutes < 1) return 'Claimed just now';
  if (minutes < 60) return `Claimed ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Claimed ${hours}h ago` : `Claimed ${Math.floor(hours / 24)}d ago`;
}
