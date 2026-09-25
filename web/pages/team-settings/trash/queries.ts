import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  restoreTrashResponseSchema,
  trashPageSchema,
  type TeamTrashType,
  type TrashPage,
} from '@shared/schemas/admin';
import type { TrashItem } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Data hooks of the Trash page (`GET /api/teams/:teamId/trash`, `POST /api/trash/restore`). */

const PAGE_SIZE = 50;

type TrashFeed = InfiniteData<TrashPage, string | undefined>;

export function useTrash(teamId: string, type: TeamTrashType | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.teams.trash(teamId, { type }),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/teams/${encodeURIComponent(teamId)}/trash`, {
        query: { type, limit: PAGE_SIZE, cursor: pageParam },
        schema: trashPageSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Restores an item. The row leaves every loaded trash list at once and comes back if the server
 * refuses (the error is toasted by the query client).
 */
export function useRestoreItem(teamId: string) {
  const queryClient = useQueryClient();
  const prefix = queryKeys.teams.trash(teamId);
  return useMutation({
    mutationFn: (item: Pick<TrashItem, 'type' | 'id'>) =>
      api.post(
        '/api/trash/restore',
        { type: item.type, id: item.id },
        {
          schema: restoreTrashResponseSchema,
        },
      ),
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: prefix });
      const snapshot = queryClient.getQueriesData<TrashFeed>({ queryKey: prefix });
      queryClient.setQueriesData<TrashFeed>({ queryKey: prefix }, (feed) =>
        feed
          ? {
              ...feed,
              pages: feed.pages.map((page) => ({
                ...page,
                items: page.items.filter(
                  (candidate) => !(candidate.type === item.type && candidate.id === item.id),
                ),
              })),
            }
          : feed,
      );
      return { snapshot };
    },
    onError: (_error, _item, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: prefix }),
  });
}
