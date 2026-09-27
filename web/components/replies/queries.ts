import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ActivityEntityType, ReplyParentType } from '@shared/constants';
import { okResponseSchema } from '@shared/schemas/common';
import {
  activityListResponseSchema,
  replyListResponseSchema,
  replySchema,
  REPLY_TREE,
  type CreateReplyInput,
  type Reply,
  type ReplyListResponse,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import { notePostedReply } from './postedReplies';

/** Data hooks for reply threads and per-item history (`/api/replies`, `/api/activity`). */

/** Which part of an item's comment tree to load (BAT-13; see `GET /api/replies`). */
export interface ReplyTreeView {
  /** "Continue this thread": only this reply and its answers. */
  root: string | null;
  limit: number;
  /** Replies whose remaining answers were asked for ("N more replies"). */
  expand: readonly string[];
  /** Replies to load with their ancestors (a `#reply-<id>` link, the viewer's new replies). */
  include: readonly string[];
}

export const DEFAULT_REPLY_VIEW: ReplyTreeView = {
  root: null,
  limit: REPLY_TREE.limit,
  expand: [],
  include: [],
};

export function replyTreeKey(parentType: ReplyParentType, parentId: string, view: ReplyTreeView) {
  return queryKeys.replies.tree(parentType, parentId, { ...view });
}

/**
 * The comment tree of an issue or task. While more of the same tree loads ("N more replies"), the
 * previous view stays; another sub-thread starts from a skeleton.
 */
export function useReplies(
  parentType: ReplyParentType,
  parentId: string,
  view: ReplyTreeView = DEFAULT_REPLY_VIEW,
) {
  return useQuery({
    queryKey: replyTreeKey(parentType, parentId, view),
    queryFn: ({ signal }) =>
      api.get('/api/replies', {
        query: {
          parentType,
          parentId,
          root: view.root ?? undefined,
          limit: view.limit === REPLY_TREE.limit ? undefined : view.limit,
          expand: view.expand.length ? view.expand.join(',') : undefined,
          include: view.include.length ? view.include.join(',') : undefined,
        },
        schema: replyListResponseSchema,
        signal,
      }),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3]?.root === view.root ? previous : undefined,
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
    onSuccess: (reply) => {
      // Shown even when it falls outside the loaded part of a long thread.
      notePostedReply(parentType, parentId, reply.id);
      return invalidate();
    },
  });
}

export function useUpdateReply(parentType: ReplyParentType, parentId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateThread(parentType, parentId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api.patch(`/api/replies/${encodeURIComponent(id)}`, { body }, { schema: replySchema }),
    onSuccess: async (reply: Reply) => {
      queryClient.setQueriesData<ReplyListResponse>(
        { queryKey: queryKeys.replies.list(parentType, parentId) },
        (current) =>
          current && {
            ...current,
            items: current.items.map((item) =>
              item.id === reply.id ? { ...item, ...reply } : item,
            ),
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
