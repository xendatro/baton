import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import {
  assigneeFilterSchema,
  TASK_BLOCKED_FILTERS,
  TASK_CLAIM_FILTERS,
  TASK_DUE_FILTERS,
  TASK_SORTS,
  type TaskBlockedFilter,
  type TaskClaimFilter,
  type TaskDueFilter,
  type TaskSort,
} from '@shared/schemas/tasks';
import { todayIso } from '@web/lib/format';
import type { TaskQueryParams } from './queries';

/**
 * Board/list state. Filters, sort and grouping live in the URL (shareable, back/forward work);
 * the board/list choice is remembered per project in localStorage (SPEC §1.9).
 */

export interface TaskFilterState {
  q: string;
  status: string[];
  /** `me`, `unassigned`, `user:<id>`, `role:<id>`. */
  assignee: string[];
  label: string[];
  /** `0`–`4`. */
  priority: string[];
  due: TaskDueFilter | null;
  claimed: TaskClaimFilter | null;
  blocked: TaskBlockedFilter | null;
}

export const LIST_GROUPS = ['status', 'priority', 'assignee', 'none'] as const;
export type ListGroup = (typeof LIST_GROUPS)[number];

export interface ListOptions {
  sort: TaskSort;
  order: 'asc' | 'desc';
  group: ListGroup;
}

export const EMPTY_FILTERS: TaskFilterState = {
  q: '',
  status: [],
  assignee: [],
  label: [],
  priority: [],
  due: null,
  claimed: null,
  blocked: null,
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function list(params: URLSearchParams, key: string, valid: (value: string) => boolean): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part && valid(part)),
    ),
  ];
}

function oneOf<T extends string>(value: string | null, options: readonly T[]): T | null {
  return value !== null && (options as readonly string[]).includes(value) ? (value as T) : null;
}

/** Reads the filters from the URL, dropping anything malformed. */
export function parseFilters(params: URLSearchParams): TaskFilterState {
  return {
    q: params.get('q')?.slice(0, 200) ?? '',
    status: list(params, 'status', (value) => ID.test(value)),
    assignee: list(params, 'assignee', (value) => assigneeFilterSchema.safeParse(value).success),
    label: list(params, 'label', (value) => ID.test(value)),
    priority: list(params, 'priority', (value) => /^[0-4]$/.test(value)),
    due: oneOf(params.get('due'), TASK_DUE_FILTERS),
    claimed: oneOf(params.get('claimed'), TASK_CLAIM_FILTERS),
    blocked: oneOf(params.get('blocked'), TASK_BLOCKED_FILTERS),
  };
}

export function parseListOptions(params: URLSearchParams): ListOptions {
  return {
    sort: oneOf(params.get('sort'), TASK_SORTS) ?? 'status',
    order: params.get('order') === 'desc' ? 'desc' : 'asc',
    group: oneOf(params.get('group'), LIST_GROUPS) ?? 'status',
  };
}

/** Query-string params of the board and list requests. */
export function filtersToQuery(filters: TaskFilterState, now: Date = new Date()): TaskQueryParams {
  const join = (values: string[]) => (values.length ? values.join(',') : undefined);
  return {
    q: filters.q.trim() || undefined,
    status: join(filters.status),
    assignee: join(filters.assignee),
    label: join(filters.label),
    priority: join(filters.priority),
    due: filters.due ?? undefined,
    claimed: filters.claimed ?? undefined,
    blocked: filters.blocked ?? undefined,
    // "Today" is the viewer's calendar date.
    today: filters.due ? todayIso(now) : undefined,
  };
}

export function activeFilterCount(filters: TaskFilterState): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    (filters.status.length ? 1 : 0) +
    (filters.assignee.length ? 1 : 0) +
    (filters.label.length ? 1 : 0) +
    (filters.priority.length ? 1 : 0) +
    (filters.due ? 1 : 0) +
    (filters.claimed ? 1 : 0) +
    (filters.blocked ? 1 : 0)
  );
}

const FILTER_KEYS = [
  'q',
  'status',
  'assignee',
  'label',
  'priority',
  'due',
  'claimed',
  'blocked',
] as const;

/** Writes filters into URL params (empty filters are removed); other params are kept. */
export function writeFilters(params: URLSearchParams, filters: TaskFilterState): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    const text = Array.isArray(value) ? value.join(',') : (value ?? '');
    if (text.trim()) next.set(key, text);
    else next.delete(key);
  }
  return next;
}

export function writeListOptions(params: URLSearchParams, options: ListOptions): URLSearchParams {
  const next = new URLSearchParams(params);
  if (options.sort === 'status') next.delete('sort');
  else next.set('sort', options.sort);
  if (options.order === 'asc') next.delete('order');
  else next.set('order', 'desc');
  if (options.group === 'status') next.delete('group');
  else next.set('group', options.group);
  return next;
}

/** The filters and list options of the current URL, and setters that replace the URL entry. */
export function useTaskFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const listOptions = useMemo(() => parseListOptions(params), [params]);
  const setFilters = useCallback(
    (update: (current: TaskFilterState) => TaskFilterState) =>
      setParams((current) => writeFilters(current, update(parseFilters(current))), {
        replace: true,
      }),
    [setParams],
  );
  const setListOptions = useCallback(
    (update: Partial<ListOptions>) =>
      setParams(
        (current) => writeListOptions(current, { ...parseListOptions(current), ...update }),
        { replace: true },
      ),
    [setParams],
  );
  return { filters, listOptions, setFilters, setListOptions };
}

// ---------------------------------------------------------------------------------------------
// Last tasks view per project (in memory): Esc on a task page returns to it with its filters
// ---------------------------------------------------------------------------------------------

const lastTasksSearch = new Map<string, string>();

/** Remembers the tasks view's query string (filters, list options) while it is shown. */
export function useRememberTasksSearch(projectId: string): void {
  const [params] = useSearchParams();
  const search = params.toString();
  useEffect(() => {
    lastTasksSearch.set(projectId, search);
  }, [projectId, search]);
}

/** The tasks view of a project as the viewer last left it: `/t/team/p/KEY/tasks?…`. */
export function tasksViewPath(projectBase: string, projectId: string): string {
  const search = lastTasksSearch.get(projectId);
  return `${projectBase}/tasks${search ? `?${search}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Board / list choice (per project, localStorage)
// ---------------------------------------------------------------------------------------------

export type TaskView = 'board' | 'list';

const viewKey = (projectId: string) => `baton-task-view:${projectId}`;
const viewListeners = new Set<() => void>();

export function readView(projectId: string): TaskView {
  try {
    return localStorage.getItem(viewKey(projectId)) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function writeView(projectId: string, view: TaskView): void {
  try {
    localStorage.setItem(viewKey(projectId), view);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
  memory.set(projectId, view);
  for (const listener of viewListeners) listener();
}

/** Choices made while storage is unavailable. */
const memory = new Map<string, TaskView>();

/** The project's board/list choice, persisted per project. */
export function useTaskView(projectId: string): [TaskView, (view: TaskView) => void] {
  const view = useSyncExternalStore<TaskView>(
    (listener) => {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
    () => memory.get(projectId) ?? readView(projectId),
    () => 'board',
  );
  const setView = useCallback((next: TaskView) => writeView(projectId, next), [projectId]);
  return [view, setView];
}
