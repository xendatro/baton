import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  deleteDifficultyResponseSchema,
  difficultyListResponseSchema,
  difficultySchema,
  type CreateDifficultyInput,
  type UpdateDifficultyInput,
} from '@shared/schemas/projects';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** A project's difficulty levels (BAT-24), easiest first, and the changes to them. */

const enc = encodeURIComponent;

export function useDifficulties(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projects.difficulties(projectId),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/difficulties`, {
        schema: difficultyListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
  });
}

/** After a change: the levels, the project and every task view (cards show the level). */
function refresh(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.difficulties(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId), exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
  ]);
}

export function useCreateDifficulty(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDifficultyInput) =>
      api.post(`/api/projects/${enc(projectId)}/difficulties`, input, {
        schema: difficultySchema,
      }),
    onSuccess: () => refresh(queryClient, projectId),
    meta: { suppressErrorToast: true },
  });
}

export function useUpdateDifficulty(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateDifficultyInput }) =>
      api.patch(`/api/difficulties/${enc(id)}`, input, { schema: difficultySchema }),
    onSuccess: () => refresh(queryClient, projectId),
  });
}

export function useReorderDifficulties(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (difficultyIds: string[]) =>
      api.put(
        `/api/projects/${enc(projectId)}/difficulties/order`,
        { difficultyIds },
        { schema: difficultyListResponseSchema },
      ),
    onSuccess: () => refresh(queryClient, projectId),
  });
}

export function useDeleteDifficulty(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/difficulties/${enc(id)}`, { schema: deleteDifficultyResponseSchema }),
    onSuccess: () => refresh(queryClient, projectId),
  });
}
