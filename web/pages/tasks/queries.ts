import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { okResponseSchema } from '@shared/schemas/common';
import {
  subscriptionResponseSchema,
  type RoleSummary,
  type UserSummary,
} from '@shared/schemas/core';
import {
  boardResponseSchema,
  taskListResponseSchema,
  taskSchema,
  type BoardResponse,
  type ClaimTaskInput,
  type CreateTaskInput,
  type MoveTaskInput,
  type Task,
  type TaskCard,
  type UpdateTaskInput,
} from '@shared/schemas/tasks';
import { api } from '@web/lib/api';
import { queryKeys, type KeyParams } from '@web/lib/queryKeys';
import { useMembers, useRoles } from '../teams/api';

/**
 * Data hooks of the tasks module (`/api/projects/:id/board|tasks`, `/api/tasks/:id`). Every task
 * query lives under `queryKeys.tasks.all(projectId)`, which live events invalidate; mutations
 * update the caches right away (board drags and simple edits are optimistic, with rollback).
 */

const enc = encodeURIComponent;

/** Query-string params of the board and list requests (see filters.ts). */
export type TaskQueryParams = Record<string, string | undefined>;

function cleanParams(params: TaskQueryParams): KeyParams {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

export const boardKey = (projectId: string, params: TaskQueryParams) =>
  queryKeys.tasks.list(projectId, { view: 'board', ...cleanParams(params) });

export function useBoard(projectId: string, params: TaskQueryParams, enabled = true) {
  return useQuery({
    queryKey: boardKey(projectId, params),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/board`, {
        query: params,
        schema: boardResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTaskList(projectId: string, params: TaskQueryParams, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.list(projectId, { view: 'list', ...cleanParams(params) }),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/tasks`, {
        query: { ...params, limit: '200' },
        schema: taskListResponseSchema,
        signal,
      }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Tasks of the project matching `q` (pickers: blockers). */
export function useTaskSearch(projectId: string, q: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tasks.list(projectId, { view: 'search', q }),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/tasks`, {
        query: { q: q || undefined, sort: 'updatedAt', order: 'desc', limit: '20' },
        schema: taskListResponseSchema,
        signal,
      }),
    enabled,
    placeholderData: keepPreviousData,
    select: (data) => data.items,
  });
}

export function useTask(projectId: string, number: number) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(projectId, number),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/tasks/${number}`, { schema: taskSchema, signal }),
    retry: (count, error) =>
      count < 2 && !(error instanceof Error && 'status' in error && error.status === 404),
  });
}

/** Members and roles that tasks can be assigned to (`@everyone` excluded). */
export function useAssignables(teamId: string) {
  const members = useMembers(teamId);
  const roles = useRoles(teamId);
  const users: UserSummary[] = members.data?.items.map((member) => member.user) ?? [];
  const assignableRoles: RoleSummary[] =
    roles.data?.items
      .filter((role) => !role.isEveryone)
      .map(({ id, slug, name, color }) => ({ id, slug, name, color })) ?? [];
  return { users, roles: assignableRoles, isPending: members.isPending || roles.isPending };
}

// ---------------------------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------------------------

function refreshTasks(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId), exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.statuses(projectId) }),
  ]);
}

/** Writes a fresh task into its detail query and every board/list that shows it. */
export function storeTask(queryClient: QueryClient, task: Task) {
  queryClient.setQueryData(queryKeys.tasks.detail(task.projectId, task.number), task);
}

/** Every cached board of the project, for optimistic moves. */
function boardQueries(queryClient: QueryClient, projectId: string) {
  return queryClient.getQueriesData<BoardResponse>({
    queryKey: queryKeys.tasks.list(projectId, { view: 'board' }).slice(0, 4),
    predicate: (query) => {
      const params = query.queryKey[4] as KeyParams | undefined;
      return params?.view === 'board';
    },
  });
}

/** Restores snapshots taken before an optimistic update. */
function restore(queryClient: QueryClient, snapshots: ReadonlyArray<[QueryKey, unknown]>) {
  for (const [key, data] of snapshots) queryClient.setQueryData(key, data);
}

/**
 * The board with `taskId` moved to `statusId` at `index` (0-based among the column's other
 * cards). Counts follow the card. Exported for tests.
 */
export function moveOnBoard(
  board: BoardResponse,
  taskId: string,
  statusId: string,
  index: number,
): BoardResponse {
  let moving: TaskCard | undefined;
  const columns = board.columns.map((column) => {
    const at = column.tasks.findIndex((task) => task.id === taskId);
    if (at === -1) return column;
    moving = column.tasks[at];
    return {
      ...column,
      count: column.count - 1,
      tasks: column.tasks.filter((task) => task.id !== taskId),
    };
  });
  if (!moving) return board;
  const card = moving;
  return {
    ...board,
    columns: columns.map((column) => {
      if (column.status.id !== statusId) return column;
      const tasks = [...column.tasks];
      const status = {
        id: column.status.id,
        name: column.status.name,
        color: column.status.color,
        category: column.status.category,
      };
      tasks.splice(Math.max(0, Math.min(index, tasks.length)), 0, { ...card, status });
      return { ...column, count: column.count + 1, tasks };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      api.post(`/api/projects/${enc(projectId)}/tasks`, input, { schema: taskSchema }),
    onSuccess: async (task) => {
      storeTask(queryClient, task);
      await refreshTasks(queryClient, projectId);
    },
    meta: { suppressErrorToast: true },
  });
}

export interface MoveVariables extends MoveTaskInput {
  taskId: string;
  /** Where the card lands on cached boards (for the optimistic update). */
  statusId: string;
  index: number;
}

/** Board drags: the card moves at once on every cached board and snaps back on failure. */
export function useMoveTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, statusId, afterId, beforeId }: MoveVariables) =>
      api.post(
        `/api/tasks/${enc(taskId)}/move`,
        { statusId, afterId, beforeId },
        { schema: taskSchema },
      ),
    onMutate: async ({ taskId, statusId, index }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all(projectId) });
      const snapshots = boardQueries(queryClient, projectId);
      for (const [key, board] of snapshots) {
        if (board) queryClient.setQueryData(key, moveOnBoard(board, taskId, statusId, index));
      }
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      if (context) restore(queryClient, context.snapshots);
    },
    onSuccess: (task) => storeTask(queryClient, task),
    onSettled: () => refreshTasks(queryClient, projectId),
  });
}

/**
 * Task page edits. `optimistic` patches the cached task at once (status, priority, due date,
 * assignees, labels); the server's answer replaces it, and a failure rolls it back.
 */
export function useUpdateTask(task: Pick<Task, 'id' | 'projectId' | 'number'>) {
  const queryClient = useQueryClient();
  const key = queryKeys.tasks.detail(task.projectId, task.number);
  return useMutation({
    mutationFn: ({ input }: { input: UpdateTaskInput; optimistic?: Partial<Task> }) =>
      api.patch(`/api/tasks/${enc(task.id)}`, input, { schema: taskSchema }),
    onMutate: async ({ optimistic }) => {
      if (!optimistic) return { previous: undefined };
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Task>(key);
      if (previous) queryClient.setQueryData(key, { ...previous, ...optimistic });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (updated) => storeTask(queryClient, updated),
    onSettled: () => refreshTasks(queryClient, task.projectId),
  });
}

export function useDeleteTask(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      api.delete(`/api/tasks/${enc(taskId)}`, { schema: okResponseSchema }),
    onSuccess: () => refreshTasks(queryClient, projectId),
  });
}

/**
 * Restores a deleted task (the Undo of a delete). A plain function rather than a hook: the page
 * that deleted the task has usually unmounted by the time Undo is pressed.
 */
export async function restoreDeletedTask(queryClient: QueryClient, task: Pick<Task, 'id'>) {
  const restored = await api.post(`/api/tasks/${enc(task.id)}/restore`, {}, { schema: taskSchema });
  storeTask(queryClient, restored);
  await refreshTasks(queryClient, restored.projectId);
  return restored;
}

/** The viewer's reply-notification toggle, shown on the task page. */
export function useTaskSubscription(task: Pick<Task, 'id' | 'projectId' | 'number'>) {
  const queryClient = useQueryClient();
  const key = queryKeys.tasks.detail(task.projectId, task.number);
  return useMutation({
    mutationFn: (subscribed: boolean) =>
      api.post(
        '/api/subscriptions',
        { entityType: 'task', entityId: task.id, subscribed },
        { schema: subscriptionResponseSchema },
      ),
    onMutate: (subscribed) => {
      const previous = queryClient.getQueryData<Task>(key);
      if (previous) queryClient.setQueryData(key, { ...previous, subscribed });
      return { previous };
    },
    onError: (_error, _subscribed, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
  });
}

export type ClaimAction =
  | { kind: 'claim'; input?: ClaimTaskInput }
  | { kind: 'renew' }
  | { kind: 'release'; note?: string };

/** Claim, take over (force), renew and release from the web ("ethan (web)"). */
export function useClaimAction(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: ClaimAction) => {
      const base = `/api/tasks/${enc(task.id)}`;
      switch (action.kind) {
        case 'claim':
          return api.post(`${base}/claim`, action.input ?? {}, { schema: taskSchema });
        case 'renew':
          return api.post(`${base}/claim/renew`, {}, { schema: taskSchema });
        case 'release':
          return api.post(`${base}/release`, { note: action.note }, { schema: taskSchema });
      }
    },
    onSuccess: (updated) => storeTask(queryClient, updated),
    onSettled: () => refreshTasks(queryClient, task.projectId),
  });
}
