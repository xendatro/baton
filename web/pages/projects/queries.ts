import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { okResponseSchema } from '@shared/schemas/common';
import {
  DEFAULT_STAGE_RULES,
  type StageRules,
  type StageRulesPatch,
} from '@shared/schemas/pipelines';
import {
  deleteLabelResponseSchema,
  deleteStatusResponseSchema,
  labelListResponseSchema,
  labelSchema,
  projectKeyCheckResponseSchema,
  projectSchema,
  projectSummarySchema,
  statusListResponseSchema,
  statusSchema,
  type CreateLabelInput,
  type CreateProjectInput,
  type CreateStatusInput,
  type Label,
  type LabelListResponse,
  type Project,
  type Status,
  type StatusListResponse,
  type UpdateLabelInput,
  type UpdateProjectInput,
  type UpdateStatusInput,
} from '@shared/schemas/projects';
import type { MeResponse } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Data hooks of the projects module: projects (`/api/projects`), their statuses and labels.
 * Live events refresh these queries too (web/lib/live.ts); mutations update the cache right away
 * so the page never waits for the event.
 */

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

/**
 * Projects the viewer is deleting right now. Their pages stay mounted until the request returns,
 * while the `project.deleted` live event may arrive first: these projects must not be refetched
 * (a 404) or resolved as an old key in the meantime.
 */
const deleting = new Set<string>();
const deletingListeners = new Set<() => void>();
let deletingVersion = 0;

function setDeleting(projectId: string, value: boolean) {
  if (value) deleting.add(projectId);
  else deleting.delete(projectId);
  deletingVersion += 1;
  for (const listener of deletingListeners) listener();
}

/** Whether the viewer is deleting `projectId` (re-renders when that changes). */
export function useIsDeleting(projectId: string | null | undefined): boolean {
  useSyncExternalStore(
    (listener) => {
      deletingListeners.add(listener);
      return () => {
        deletingListeners.delete(listener);
      };
    },
    () => deletingVersion,
    () => deletingVersion,
  );
  return projectId ? deleting.has(projectId) : false;
}

export function useProject(projectId: string | null | undefined) {
  const beingDeleted = useIsDeleting(projectId);
  return useQuery({
    queryKey: queryKeys.projects.detail(projectId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId ?? '')}`, { schema: projectSchema, signal }),
    enabled: Boolean(projectId) && !beingDeleted,
  });
}

/** Resolves a key of the team that `me` doesn't list (a previous key) to the project. */
export function useProjectByKey(teamSlug: string, teamId: string, key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.teams.projectByKey(teamId, key),
    queryFn: ({ signal }) =>
      api.get('/api/projects/resolve', {
        query: { ref: `${teamSlug}/${key}` },
        schema: projectSummarySchema,
        signal,
      }),
    enabled,
    retry: false,
  });
}

/** Availability of a project key in a team (debounce `key` before passing it). */
export function useProjectKeyCheck(teamId: string | null, key: string, projectId?: string) {
  return useQuery({
    queryKey: queryKeys.teams.projectKeyCheck(teamId ?? '', key, projectId),
    queryFn: ({ signal }) =>
      api.get(`/api/teams/${enc(teamId ?? '')}/projects/key-check`, {
        query: { key, projectId },
        schema: projectKeyCheckResponseSchema,
        signal,
      }),
    enabled: Boolean(teamId) && key.length > 0,
    staleTime: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** Refreshes everything that shows a project's name, key, icon or color. */
function refreshProjectLists(queryClient: QueryClient, teamId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.teams.projects(teamId) }),
  ]);
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, input }: { teamId: string; input: CreateProjectInput }) =>
      api.post(`/api/teams/${enc(teamId)}/projects`, input, { schema: projectSchema }),
    onSuccess: async (project) => {
      queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
      await refreshProjectLists(queryClient, project.teamId);
    },
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) =>
      api.patch(`/api/projects/${enc(projectId)}`, input, { schema: projectSchema }),
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
      // The sidebar, breadcrumbs and the layout read name and key from `me`: patch it at once, so
      // a key change can navigate straight to the new URL.
      queryClient.setQueryData(
        queryKeys.me(),
        (me: MeResponse | undefined) =>
          me && {
            ...me,
            teams: me.teams.map((team) =>
              team.id !== project.teamId
                ? team
                : {
                    ...team,
                    projects: team.projects.map((item) =>
                      item.id === project.id
                        ? {
                            ...item,
                            name: project.name,
                            key: project.key,
                            icon: project.icon,
                            color: project.color,
                          }
                        : item,
                    ),
                  },
            ),
          },
      );
      void refreshProjectLists(queryClient, project.teamId);
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (project: Pick<Project, 'id' | 'teamId'>) =>
      api.delete(`/api/projects/${enc(project.id)}`, { schema: okResponseSchema }),
    onMutate: async (project) => {
      setDeleting(project.id, true);
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.detail(project.id) });
    },
    onError: (_error, project) => setDeleting(project.id, false),
    // Not awaited: the caller leaves the project's pages first (they have unmounted by the time
    // the guard is lifted).
    onSuccess: (_result, project) => {
      setTimeout(() => setDeleting(project.id, false), 2_000);
      void refreshProjectLists(queryClient, project.teamId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.teams.trash(project.teamId) });
    },
    meta: { suppressErrorToast: true },
  });
}

export function useRestoreProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post(`/api/projects/${enc(projectId)}/restore`, {}, { schema: projectSchema }),
    onSuccess: async (project) => {
      setDeleting(project.id, false);
      queryClient.setQueryData(queryKeys.projects.detail(project.id), project);
      await Promise.all([
        refreshProjectLists(queryClient, project.teamId),
        queryClient.invalidateQueries({ queryKey: queryKeys.teams.trash(project.teamId) }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------

export function useStatuses(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projects.statuses(projectId),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/statuses`, {
        schema: statusListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
  });
}

/** After a status change: the list, the project (counts, statuses) and every task view. */
function refreshStatuses(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.statuses(projectId) }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.detail(projectId),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
  ]);
}

/**
 * Applies `update` to the cached status list at once, rolling back if the request fails
 * (reordering, the default radio, icon and color changes feel instant).
 */
function optimisticStatuses(
  queryClient: QueryClient,
  projectId: string,
  update: (items: Status[]) => Status[],
) {
  const key = queryKeys.projects.statuses(projectId);
  const previous = queryClient.getQueryData<StatusListResponse>(key);
  if (previous) queryClient.setQueryData(key, { items: update(previous.items) });
  return () => {
    if (previous) queryClient.setQueryData(key, previous);
  };
}

/** The rules after a partial change (on-enter flags merge; everything else replaces). */
function mergeRules(current: StageRules | undefined, patch: StageRulesPatch): StageRules {
  const base = current ?? DEFAULT_STAGE_RULES;
  const { onEnter, ...rest } = patch;
  const defined = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as Partial<StageRules>;
  return { ...base, ...defined, onEnter: { ...base.onEnter, ...onEnter } };
}

export function useCreateStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStatusInput) =>
      api.post(`/api/projects/${enc(projectId)}/statuses`, input, { schema: statusSchema }),
    onSuccess: () => refreshStatuses(queryClient, projectId),
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateStatusInput }) =>
      api.patch(`/api/statuses/${enc(id)}`, input, { schema: statusSchema }),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.statuses(projectId) });
      return {
        rollback: optimisticStatuses(queryClient, projectId, (items) =>
          items.map((status) => {
            if (status.id === id) {
              return {
                ...status,
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.color !== undefined ? { color: input.color } : {}),
                ...(input.icon !== undefined ? { icon: input.icon } : {}),
                ...(input.isDefault ? { isDefault: true } : {}),
                ...(input.rules ? { rules: mergeRules(status.rules, input.rules) } : {}),
              };
            }
            return input.isDefault ? { ...status, isDefault: false } : status;
          }),
        ),
      };
    },
    onError: (_error, _variables, context) => context?.rollback(),
    onSettled: () => refreshStatuses(queryClient, projectId),
  });
}

export function useReorderStatuses(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (statusIds: string[]) =>
      api.put(
        `/api/projects/${enc(projectId)}/statuses/order`,
        { statusIds },
        { schema: statusListResponseSchema },
      ),
    onMutate: async (statusIds) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects.statuses(projectId) });
      return {
        rollback: optimisticStatuses(queryClient, projectId, (items) =>
          statusIds
            .map((id, position) => {
              const status = items.find((item) => item.id === id);
              return status ? { ...status, position } : null;
            })
            .filter((status): status is Status => status !== null),
        ),
      };
    },
    onError: (_error, _variables, context) => context?.rollback(),
    onSettled: () => refreshStatuses(queryClient, projectId),
  });
}

export function useDeleteStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, moveTo }: { id: string; moveTo: string }) =>
      api.delete(`/api/statuses/${enc(id)}`, {
        query: { moveTo },
        schema: deleteStatusResponseSchema,
      }),
    onSuccess: () => refreshStatuses(queryClient, projectId),
    meta: { suppressErrorToast: true },
  });
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export function useLabels(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projects.labels(projectId),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/labels`, {
        schema: labelListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
  });
}

/** After a label change: the list, the project and every issue and task view. */
function refreshLabels(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.labels(projectId) }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.projects.detail(projectId),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.all(projectId) }),
  ]);
}

function sortLabels(labels: Label[]): Label[] {
  return [...labels].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export function useCreateLabel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLabelInput) =>
      api.post(`/api/projects/${enc(projectId)}/labels`, input, { schema: labelSchema }),
    onSuccess: async (label) => {
      queryClient.setQueryData(
        queryKeys.projects.labels(projectId),
        (current: LabelListResponse | undefined) =>
          current && { items: sortLabels([...current.items, label]) },
      );
      await refreshLabels(queryClient, projectId);
    },
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateLabel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLabelInput }) =>
      api.patch(`/api/labels/${enc(id)}`, input, { schema: labelSchema }),
    onSuccess: async (label) => {
      queryClient.setQueryData(
        queryKeys.projects.labels(projectId),
        (current: LabelListResponse | undefined) =>
          current && {
            items: sortLabels(current.items.map((item) => (item.id === label.id ? label : item))),
          },
      );
      await refreshLabels(queryClient, projectId);
    },
    meta: { suppressErrorToast: true },
  });
}

export function useDeleteLabel(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/labels/${enc(id)}`, { schema: deleteLabelResponseSchema }),
    onSuccess: async (_result, id) => {
      queryClient.setQueryData(
        queryKeys.projects.labels(projectId),
        (current: LabelListResponse | undefined) =>
          current && { items: current.items.filter((item) => item.id !== id) },
      );
      await refreshLabels(queryClient, projectId);
    },
    meta: { suppressErrorToast: true },
  });
}
