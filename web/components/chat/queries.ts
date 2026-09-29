import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { CHAT_LIMITS, type ConversationMode, type ReplyParentType } from '@shared/constants';
import {
  catchUpStateSchema,
  chatPageSchema,
  conversationModeResponseSchema,
  type CatchUpRangeInput,
  type ChatPage,
} from '@shared/schemas/chat';
import { okResponseSchema } from '@shared/schemas/common';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Chat data: the message stream (`GET /api/items/:type/:id/chat`, pages of older messages),
 * typing pings, the conversation mode and the viewer's catch-up summaries. Reply events refresh
 * the stream (its key is under `replies.list`); `agent_job.changed` refreshes catch-up state.
 */

const itemUrl = (type: ReplyParentType, id: string) =>
  `/api/items/${type}/${encodeURIComponent(id)}`;

export type ChatFeed = InfiniteData<ChatPage, string | undefined>;

export function useChatMessages(type: ReplyParentType, id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.replies.chat(type, id),
    queryFn: ({ pageParam, signal }) =>
      api.get(`${itemUrl(type, id)}/chat`, {
        query: { before: pageParam, limit: CHAT_LIMITS.pageSize },
        schema: chatPageSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.olderCursor ?? undefined,
    // "… is working" follows `item.working_changed` (BAT#42); no polling needed.
  });
}

/**
 * Pings `typing` at most every 3 s while the viewer types (a `typing` live event for the others).
 * Returns the function to call on each keystroke, and one to forget the last ping (after sending).
 */
export function useTypingPing(type: ReplyParentType, id: string) {
  const last = useRef(0);
  const ping = useCallback(() => {
    const now = Date.now();
    if (now - last.current < CHAT_LIMITS.typingPingMs) return;
    last.current = now;
    void api
      .post(`${itemUrl(type, id)}/typing`, undefined, { schema: okResponseSchema })
      .catch(() => undefined);
  }, [type, id]);
  const reset = useCallback(() => {
    last.current = 0;
  }, []);
  return { ping, reset };
}

export function useSetConversationMode(type: ReplyParentType, id: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: ConversationMode) =>
      api.put(
        `${itemUrl(type, id)}/conversation-mode`,
        { mode },
        { schema: conversationModeResponseSchema },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey:
          type === 'issue' ? queryKeys.issues.all(projectId) : queryKeys.tasks.all(projectId),
      }),
  });
}

export function useCatchUp(type: ReplyParentType, id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.catchUp.item(type, id),
    queryFn: ({ signal }) =>
      api.get(`${itemUrl(type, id)}/catch-up`, { schema: catchUpStateSchema, signal }),
    enabled,
  });
}

export function useRequestCatchUp(type: ReplyParentType, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (range: CatchUpRangeInput) =>
      api.post(`${itemUrl(type, id)}/catch-up`, range, { schema: catchUpStateSchema }),
    onSuccess: (state) => queryClient.setQueryData(queryKeys.catchUp.item(type, id), state),
  });
}
