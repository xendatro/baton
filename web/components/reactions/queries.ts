import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ReactionTargetType } from '@shared/constants';
import { reactionListResponseSchema } from '@shared/schemas/core';
import { api } from '@web/lib/api';

export interface ReactionChange {
  emoji: string;
  /** Remove the viewer's reaction instead of adding it. */
  remove: boolean;
}

/**
 * `PUT` / `DELETE /api/reactions` for one target. Refreshes `queryKey` (the query holding the
 * target's reactions) afterwards; other viewers refresh through the `reaction.changed` event.
 */
export function useReactionMutation(
  targetType: ReactionTargetType,
  targetId: string,
  queryKey: QueryKey,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ emoji, remove }: ReactionChange) =>
      remove
        ? api.delete('/api/reactions', {
            query: { targetType, targetId, emoji },
            schema: reactionListResponseSchema,
          })
        : api.put(
            '/api/reactions',
            { targetType, targetId, emoji },
            { schema: reactionListResponseSchema },
          ),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}
