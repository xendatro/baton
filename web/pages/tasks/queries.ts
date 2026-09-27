import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { okResponseSchema } from '@shared/schemas/common';
import type { ApprovalInput, EvidenceInput } from '@shared/schemas/pipelines';
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
import type { AssigneeToggle } from '@web/components/pickers/AssigneePicker';
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

/**
 * Writes a fresh task into its detail query. A refetch still in flight (e.g. started by the live
 * event of an earlier move) is cancelled first: it would otherwise land after this answer and put
 * the older stage back, so the stage buttons would act on the stage the task already left.
 */
export async function storeTask(queryClient: QueryClient, task: Task) {
  const key = queryKeys.tasks.detail(task.projectId, task.number);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  queryClient.setQueryData(key, task);
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
        icon: column.status.icon,
      };
      // Completed while in a stage that doesn't block its dependents.
      const blocks = column.status.rules?.blocksDependents ?? true;
      const completedAt = blocks ? null : (card.completedAt ?? new Date().toISOString());
      tasks.splice(Math.max(0, Math.min(index, tasks.length)), 0, {
        ...card,
        status,
        completedAt,
      });
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
      void storeTask(queryClient, task);
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
    mutationFn: ({ taskId, statusId, afterId, beforeId, reason, difficultyId }: MoveVariables) =>
      api.post(
        `/api/tasks/${enc(taskId)}/move`,
        {
          statusId,
          afterId,
          beforeId,
          ...(reason ? { reason } : {}),
          ...(difficultyId !== undefined ? { difficultyId } : {}),
        },
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

/** The task with one toggle applied to its assignees (idempotent). */
export function applyAssigneeToggle(task: Task, toggle: AssigneeToggle): Task {
  const { users, roles } = task.assignees;
  const without = <T extends { id: string }>(list: readonly T[]) =>
    list.filter((item) => item.id !== toggle.assignee.id);
  const assignees =
    toggle.kind === 'user'
      ? { users: toggle.add ? [...without(users), toggle.assignee] : without(users), roles }
      : { users, roles: toggle.add ? [...without(roles), toggle.assignee] : without(roles) };
  return { ...task, assignees };
}

/**
 * Adds or removes one assignee of the task's current stage right away: each toggle is its own
 * `{add}` / `{remove}` request, so it never overwrites assignees someone else added meanwhile.
 * Optimistic, and a failed toggle undoes only itself. While several toggles are in flight, only
 * the last one to settle writes the server's task and refreshes, so earlier responses can't hide
 * later toggles.
 */
export function useToggleAssignee(task: Pick<Task, 'id' | 'projectId' | 'number'>) {
  const queryClient = useQueryClient();
  const key = queryKeys.tasks.detail(task.projectId, task.number);
  const mutationKey = ['tasks', task.id, 'assignees'];
  const lastInFlight = () => queryClient.isMutating({ mutationKey }) === 1;
  return useMutation({
    mutationKey,
    mutationFn: (toggle: AssigneeToggle) =>
      api.patch(
        `/api/tasks/${enc(task.id)}`,
        {
          [toggle.kind === 'user' ? 'assigneeUsers' : 'assigneeRoles']: toggle.add
            ? { add: [toggle.assignee.id] }
            : { remove: [toggle.assignee.id] },
        } satisfies UpdateTaskInput,
        { schema: taskSchema },
      ),
    onMutate: async (toggle) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<Task>(key, (previous) =>
        previous ? applyAssigneeToggle(previous, toggle) : previous,
      );
    },
    onError: (_error, toggle) => {
      queryClient.setQueryData<Task>(key, (previous) =>
        previous ? applyAssigneeToggle(previous, { ...toggle, add: !toggle.add }) : previous,
      );
    },
    onSuccess: (updated) => {
      if (lastInFlight()) void storeTask(queryClient, updated);
    },
    onSettled: () => (lastInFlight() ? refreshTasks(queryClient, task.projectId) : undefined),
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
  void storeTask(queryClient, restored);
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

/** Evidence for the current stage's exit criteria (design §5): criterion id → text. */
export function useSaveEvidence(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evidence: EvidenceInput) =>
      api.put(`/api/tasks/${enc(task.id)}/evidence`, { evidence }, { schema: taskSchema }),
    onSuccess: (updated) => storeTask(queryClient, updated),
    onSettled: () => refreshTasks(queryClient, task.projectId),
    meta: { suppressErrorToast: true },
  });
}

/**
 * The task page's stage moves (BAT-27): on to the next stage, or back to an earlier one with a
 * reason (`POST /move`, audited as `task.moved`).
 */
export function useStageMove(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveTaskInput & { statusId: string }) =>
      api.post(`/api/tasks/${enc(task.id)}/move`, input, { schema: taskSchema }),
    onSuccess: (updated) => storeTask(queryClient, updated),
    onSettled: () => refreshTasks(queryClient, task.projectId),
    meta: { suppressErrorToast: true },
  });
}

/** Approve / Request changes on the task's stage (design §5). */
export function useDecideApproval(task: Pick<Task, 'id' | 'projectId'>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApprovalInput) =>
      api.post(`/api/tasks/${enc(task.id)}/approvals`, input, { schema: taskSchema }),
    onSuccess: (updated) => storeTask(queryClient, updated),
    onSettled: () => refreshTasks(queryClient, task.projectId),
    meta: { suppressErrorToast: true },
  });
}
