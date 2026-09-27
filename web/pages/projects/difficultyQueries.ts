import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  deleteDifficultyResponseSchema,
  difficultyListResponseSchema,
  difficultySchema,
  type CreateDifficultyInput,
  type Difficulty,
  type DifficultyListResponse,
  type UpdateDifficultyInput,
} from '@shared/schemas/projects';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * A project's difficulty levels (BAT-24), easiest first as the API sends them (show them with
 * `hardestFirst` from `@web/lib/difficulty`), and the changes to them.
 */

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
    // Show the new order at once, so a dragged row doesn't jump back until the server answers.
    onMutate: async (difficultyIds) => {
      const key = queryKeys.projects.difficulties(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DifficultyListResponse>(key);
      if (previous) {
        const byId = new Map(previous.items.map((level) => [level.id, level]));
        const items = difficultyIds
          .map((id, position) => {
            const level = byId.get(id);
            return level ? { ...level, position } : null;
          })
          .filter((level): level is Difficulty => level !== null);
        if (items.length === previous.items.length) queryClient.setQueryData(key, { items });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.projects.difficulties(projectId), context.previous);
      }
    },
    onSettled: () => refresh(queryClient, projectId),
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
