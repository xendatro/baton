import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActivityEntityType, ReplyParentType } from '@shared/constants';
import { okResponseSchema } from '@shared/schemas/common';
import {
  activityListResponseSchema,
  replyListResponseSchema,
  replySchema,
  type CreateReplyInput,
  type Reply,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Data hooks for reply threads and per-item history (`/api/replies`, `/api/activity`). */

export function useReplies(parentType: ReplyParentType, parentId: string) {
  return useQuery({
    queryKey: queryKeys.replies.list(parentType, parentId),
    queryFn: ({ signal }) =>
      api.get('/api/replies', {
        query: { parentType, parentId },
        schema: replyListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
  });
}

export function useActivity(entityType: ActivityEntityType, entityId: string) {
  return useQuery({
    queryKey: queryKeys.activity(entityType, entityId),
    queryFn: ({ signal }) =>
      api.get('/api/activity', {
        query: { entityType, entityId },
        schema: activityListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
  });
}

/** Refreshes a thread and its item's history after the viewer changes it. */
function useInvalidateThread(parentType: ReplyParentType, parentId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.replies.list(parentType, parentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.activity(parentType, parentId) }),
    ]);
}

export function useCreateReply(parentType: ReplyParentType, parentId: string) {
  const invalidate = useInvalidateThread(parentType, parentId);
  return useMutation({
    mutationFn: (input: Omit<CreateReplyInput, 'parentType' | 'parentId'>) =>
      api.post('/api/replies', { ...input, parentType, parentId }, { schema: replySchema }),
    onSuccess: invalidate,
  });
}

export function useUpdateReply(parentType: ReplyParentType, parentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateThread(parentType, parentId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api.patch(`/api/replies/${encodeURIComponent(id)}`, { body }, { schema: replySchema }),
    onSuccess: async (reply: Reply) => {
      queryClient.setQueryData(
        queryKeys.replies.list(parentType, parentId),
        (current: { items: Reply[] } | undefined) =>
          current && {
            items: current.items.map((item) => (item.id === reply.id ? reply : item)),
          },
      );
      await invalidate();
    },
  });
}

export function useDeleteReply(parentType: ReplyParentType, parentId: string) {
  const invalidate = useInvalidateThread(parentType, parentId);
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/replies/${encodeURIComponent(id)}`, { schema: okResponseSchema }),
    onSuccess: invalidate,
  });
}

/**
 * `DELETE /api/attachments/:id` (to Trash). Refreshes reply threads (replies embed their
 * attachments) and, when given, the attachment list of the parent item.
 */
export function useDeleteAttachment(parent?: { type: string; id: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/attachments/${encodeURIComponent(id)}`, { schema: okResponseSchema }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.replies.all() }),
        parent
          ? queryClient.invalidateQueries({
              queryKey: queryKeys.attachments(parent.type, parent.id),
            })
          : undefined,
      ]),
  });
}
