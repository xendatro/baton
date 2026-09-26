import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { okResponseSchema } from '@shared/schemas/common';
import { subscriptionResponseSchema } from '@shared/schemas/core';
import {
  issueListResponseSchema,
  issueSchema,
  type CreateIssueInput,
  type Issue,
  type IssueSort,
  type IssueState,
  type LabelMatch,
  type UpdateIssueInput,
} from '@shared/schemas/issues';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Data hooks of the issues module (`/api/projects/:projectId/issues`, `/api/issues/:id`). Live
 * events refresh them through `issues.all` (web/lib/live.ts); mutations write the returned issue
 * into the cache at once so the page never waits for the event.
 */

const enc = encodeURIComponent;

export const ISSUE_PAGE_SIZE = 25;

/** Filters of the issue list, as the list query key and the request carry them. */
export interface IssueListParams {
  state: IssueState;
  /** Label ids. */
  labels: readonly string[];
  labelMatch: LabelMatch;
  /** Author user id. */
  author: string | null;
  q: string;
  sort: IssueSort;
}

export function useIssueList(projectId: string, params: IssueListParams, enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.issues.list(projectId, { ...params }),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/projects/${enc(projectId)}/issues`, {
        query: {
          state: params.state,
          labels: params.labels,
          labelMatch: params.labels.length > 1 ? params.labelMatch : undefined,
          author: params.author,
          q: params.q,
          sort: params.sort,
          limit: ISSUE_PAGE_SIZE,
          cursor: pageParam,
        },
        schema: issueListResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
}

/** The issue page's data. `enabled: false` while the viewer deletes it (no refetch into a 404). */
export function useIssue(projectId: string, number: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.issues.detail(projectId, number),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/issues/${number}`, { schema: issueSchema, signal }),
    enabled,
  });
}

/** Writes a fresh issue into the page's cache and refreshes the lists (counts, order, rows). */
function storeIssue(queryClient: QueryClient, issue: Issue) {
  queryClient.setQueryData(queryKeys.issues.detail(issue.projectId, issue.number), issue);
  void queryClient.invalidateQueries({
    queryKey: [...queryKeys.issues.all(issue.projectId), 'list'],
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.activity('issue', issue.id),
  });
}

/** Applies `update` to the cached issue now; returns the rollback. */
function optimisticIssue(queryClient: QueryClient, issue: Issue, update: (issue: Issue) => Issue) {
  const key = queryKeys.issues.detail(issue.projectId, issue.number);
  const previous = queryClient.getQueryData<Issue>(key);
  if (previous) queryClient.setQueryData(key, update(previous));
  return () => {
    if (previous) queryClient.setQueryData(key, previous);
  };
}

export function useCreateIssue(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateIssueInput) =>
      api.post(`/api/projects/${enc(projectId)}/issues`, input, { schema: issueSchema }),
    onSuccess: (issue) => storeIssue(queryClient, issue),
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateIssue(issue: Issue) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateIssueInput) =>
      api.patch(`/api/issues/${enc(issue.id)}`, input, { schema: issueSchema }),
    onSuccess: (updated) => storeIssue(queryClient, updated),
    meta: { suppressErrorToast: true },
  });
}

/** Sets the issue's labels, showing them at once and rolling back if the request fails. */
export function useSetIssueLabels(issue: Issue, labels: ReadonlyArray<Issue['labels'][number]>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (labelIds: string[]) =>
      api.patch(
        `/api/issues/${enc(issue.id)}`,
        { labels: { set: labelIds } },
        { schema: issueSchema },
      ),
    onMutate: async (labelIds) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.issues.detail(issue.projectId, issue.number),
      });
      return {
        rollback: optimisticIssue(queryClient, issue, (current) => ({
          ...current,
          labels: labels
            .filter((label) => labelIds.includes(label.id))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
        })),
      };
    },
    onError: (_error, _labelIds, context) => context?.rollback(),
    onSuccess: (updated) => storeIssue(queryClient, updated),
  });
}

/** Resolves (`true`) or reopens (`false`) the issue, optimistically. */
export function useSetResolved(issue: Issue) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (resolved: boolean) =>
      api.post(`/api/issues/${enc(issue.id)}/${resolved ? 'resolve' : 'reopen'}`, undefined, {
        schema: issueSchema,
      }),
    onMutate: async (resolved) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.issues.detail(issue.projectId, issue.number),
      });
      return {
        rollback: optimisticIssue(queryClient, issue, (current) => ({ ...current, resolved })),
      };
    },
    onError: (_error, _resolved, context) => context?.rollback(),
    onSuccess: (updated) => storeIssue(queryClient, updated),
  });
}

/** Subscribe toggle for reply notifications (optimistic). */
export function useSetIssueSubscription(issue: Issue) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (subscribed: boolean) =>
      api.post(
        '/api/subscriptions',
        { entityType: 'issue', entityId: issue.id, subscribed },
        { schema: subscriptionResponseSchema },
      ),
    onMutate: (subscribed) => ({
      rollback: optimisticIssue(queryClient, issue, (current) => ({ ...current, subscribed })),
    }),
    onError: (_error, _subscribed, context) => context?.rollback(),
  });
}

export function useDeleteIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issue: Pick<Issue, 'id' | 'projectId' | 'teamId'>) =>
      api.delete(`/api/issues/${enc(issue.id)}`, { schema: okResponseSchema }),
    onSuccess: (_result, issue) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(issue.projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.teams.trash(issue.teamId) }),
      ]),
    // The confirm dialog shows the error.
    meta: { suppressErrorToast: true },
  });
}

export function useRestoreIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (issueId: string) =>
      api.post(`/api/issues/${enc(issueId)}/restore`, undefined, { schema: issueSchema }),
    onSuccess: (issue) => {
      storeIssue(queryClient, issue);
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams.trash(issue.teamId) });
    },
  });
}

/**
 * `POST /api/projects/:projectId/tasks/from-issue` (tasks module): creates a task from the issue
 * (title, a link back, labels) linked with kind `fixes`. Only the new task's number is needed here.
 */
const createdTaskSchema = z.object({ number: z.number().int().positive(), ref: z.string() });

export function useCreateTaskFromIssue(issue: Issue) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post(
        `/api/projects/${enc(issue.projectId)}/tasks/from-issue`,
        { issueId: issue.id },
        { schema: createdTaskSchema },
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(issue.projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(issue.projectId) }),
      ]),
  });
}
