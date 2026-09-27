import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGE_RULES } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import type { BoardResponse, TaskCard } from '@shared/schemas/tasks';
import {
  activeFilterCount,
  EMPTY_FILTERS,
  filtersToQuery,
  parseFilters,
  parseListOptions,
  writeFilters,
  writeListOptions,
} from './filters';
import { claimedAgo, dropTarget, groupTasks } from './helpers';
import { moveOnBoard } from './queries';

const status = (id: string, name: string, position: number, finished = false) =>
  ({
    id,
    projectId: 'p',
    name,
    color: '#6b7280',
    icon: finished ? ('check-circle' as const) : ('circle' as const),
    position,
    isDefault: position === 0,
    taskCount: 0,
    rules: finished
      ? { ...DEFAULT_STAGE_RULES, blocksDependents: false, claimable: false }
      : DEFAULT_STAGE_RULES,
  }) satisfies Status;

const open = status('s-open', 'Open', 0);
const done = status('s-done', 'Done', 1, true);

function card(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    ref: `API-${id}`,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Task ${id}`,
    projectId: 'p',
    teamId: 't',
    status: { id: open.id, name: open.name, color: open.color, icon: open.icon },
    priority: 0,
    dueDate: null,
    labels: [],
    assignees: { users: [], roles: [] },
    claim: null,
    blocked: false,
    replyCount: 0,
    updatedAt: '2030-01-01T00:00:00.000Z',
    position: 'a0',
    blockers: [],
    createdAt: '2030-01-01T00:00:00.000Z',
    completedAt: null,
    path: `/t/acme/p/API/tasks/${id}`,
    ...overrides,
  };
}

describe('filters in the URL', () => {
  it('parses valid values and drops malformed ones', () => {
    const params = new URLSearchParams(
      'q=login&status=a,b,bad id&assignee=me,user:01ABC,role:,nobody&priority=4,9,0&due=soon&claimed=mine&blocked=yes',
    );
    expect(parseFilters(params)).toEqual({
      q: 'login',
      status: ['a', 'b'],
      assignee: ['me', 'user:01ABC'],
      label: [],
      priority: ['4', '0'],
      due: null,
      claimed: 'mine',
      blocked: 'yes',
    });
  });

  it('writes filters back, removing empty ones and keeping other params', () => {
    const params = writeFilters(new URLSearchParams('sort=title&q=old'), {
      ...EMPTY_FILTERS,
      status: ['a', 'b'],
      due: 'overdue',
    });
    expect(params.toString()).toBe('sort=title&status=a%2Cb&due=overdue');
    expect(activeFilterCount(parseFilters(params))).toBe(2);
  });

  it('sends the viewer’s date with due filters only', () => {
    const now = new Date(2030, 0, 15, 23, 30);
    expect(filtersToQuery({ ...EMPTY_FILTERS, due: 'today' }, now).today).toBe('2030-01-15');
    expect(filtersToQuery({ ...EMPTY_FILTERS, q: '  ' }, now)).toEqual({
      q: undefined,
      status: undefined,
      assignee: undefined,
      label: undefined,
      priority: undefined,
      due: undefined,
      claimed: undefined,
      blocked: undefined,
      today: undefined,
    });
  });

  it('keeps default list options out of the URL', () => {
    expect(parseListOptions(new URLSearchParams('sort=nope&group=priority&order=desc'))).toEqual({
      sort: 'status',
      order: 'desc',
      group: 'priority',
    });
    const params = writeListOptions(new URLSearchParams('q=x'), {
      sort: 'status',
      order: 'asc',
      group: 'status',
    });
    expect(params.toString()).toBe('q=x');
  });
});

describe('board drops', () => {
  const before = { [open.id]: ['a', 'b', 'c'], [done.id]: [] as string[] };

  it('places a card after its new upper neighbour, or before the first card', () => {
    expect(dropTarget(before, { ...before, [open.id]: ['b', 'a', 'c'] }, 'a')).toEqual({
      statusId: open.id,
      index: 1,
      afterId: 'b',
      beforeId: undefined,
    });
    expect(dropTarget(before, { ...before, [open.id]: ['c', 'a', 'b'] }, 'c')).toEqual({
      statusId: open.id,
      index: 0,
      afterId: undefined,
      beforeId: 'a',
    });
  });

  it('moves into another (empty) column, and ignores drops in place', () => {
    expect(dropTarget(before, { [open.id]: ['a', 'b'], [done.id]: ['c'] }, 'c')).toEqual({
      statusId: done.id,
      index: 0,
      afterId: undefined,
      beforeId: undefined,
    });
    expect(dropTarget(before, before, 'b')).toBeNull();
  });

  it('moves a card on a cached board optimistically, with its status and counts', () => {
    const board: BoardResponse = {
      total: 3,
      columns: [
        { status: open, count: 2, tasks: [card('1'), card('2')] },
        { status: done, count: 1, tasks: [card('3', { status: { ...done } })] },
      ],
    };
    const moved = moveOnBoard(board, '1', done.id, 1);
    expect(
      moved.columns.map((column) => [column.count, column.tasks.map((task) => task.id)]),
    ).toEqual([
      [1, ['2']],
      [2, ['3', '1']],
    ]);
    expect(moved.columns[1]?.tasks[1]?.status.name).toBe('Done');
    // Done doesn't block its dependents, so the moved card counts as completed at once.
    expect(moved.columns[1]?.tasks[1]?.completedAt).not.toBeNull();
    expect(moveOnBoard(moved, '1', open.id, 0).columns[0]?.tasks[0]?.completedAt).toBeNull();
    expect(moveOnBoard(board, 'missing', done.id, 0)).toBe(board);
  });
});

describe('list groups', () => {
  const alice = { id: 'u1', username: 'alice', name: 'Alice', image: null };
  const role = { id: 'r1', slug: 'backend', name: 'Backend', color: '#3b82f6' };
  const tasks = [
    card('1', { priority: 4, assignees: { users: [alice], roles: [role] } }),
    card('2', { priority: 0, status: { ...done } }),
    card('3', { priority: 4 }),
  ];

  it('groups by status in column order, skipping empty statuses', () => {
    const groups = groupTasks(tasks, 'status', [open, done, status('s-x', 'Later', 2)]);
    expect(groups.map((group) => [group.label, group.tasks.map((task) => task.id)])).toEqual([
      ['Open', ['1', '3']],
      ['Done', ['2']],
    ]);
  });

  it('groups by priority (urgent first) and by assignee (people, roles, then unassigned)', () => {
    expect(groupTasks(tasks, 'priority', []).map((group) => group.label)).toEqual([
      'Urgent',
      'No priority',
    ]);
    expect(
      groupTasks(tasks, 'assignee', []).map((group) => [group.label, group.tasks.length]),
    ).toEqual([
      ['Alice', 1],
      ['Backend', 1],
      ['Unassigned', 2],
    ]);
    expect(groupTasks(tasks, 'none', [])[0]?.tasks).toHaveLength(3);
  });
});

describe('claim wording', () => {
  const now = Date.parse('2030-01-01T12:00:00Z');
  it('describes the claim age', () => {
    expect(claimedAgo('2030-01-01T11:59:50Z', now)).toBe('Claimed just now');
    expect(claimedAgo('2030-01-01T11:48:00Z', now)).toBe('Claimed 12m ago');
  });
});
