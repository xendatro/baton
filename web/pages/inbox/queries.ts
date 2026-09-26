import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import {
  markNotificationsReadResponseSchema,
  notificationListResponseSchema,
  type MarkNotificationsReadInput,
  type MeResponse,
  type NotificationListResponse,
  type UnreadCountResponse,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Inbox data (`GET /api/notifications`, `POST /api/notifications/read`). `notification.created`
 * events invalidate `queryKeys.notifications.all()`, which covers every list and the unread count.
 */

export const INBOX_PAGE_SIZE = 30;

type Feed = InfiniteData<NotificationListResponse, string | undefined>;

export function useInbox(unreadOnly: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.notifications.list({ view: 'inbox', unread: unreadOnly }),
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/notifications', {
        query: { limit: INBOX_PAGE_SIZE, cursor: pageParam, unread: unreadOnly ? '1' : null },
        schema: notificationListResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function isFeed(value: unknown): value is Feed {
  return typeof value === 'object' && value !== null && 'pages' in value;
}

/**
 * Marks notifications read in every cached list and lowers the unread counts at once. Returns
 * how many of them were unread.
 */
function applyRead(queryClient: QueryClient, input: MarkNotificationsReadInput): number {
  const readAt = new Date().toISOString();
  const ids = input.ids ? new Set(input.ids) : null;
  const matches = (id: string) => ids === null || ids.has(id);
  let newlyRead = 0;
  const counted = new Set<string>();

  queryClient.setQueriesData<unknown>(
    { queryKey: queryKeys.notifications.all() },
    (data: unknown) => {
      const markPage = (page: NotificationListResponse): NotificationListResponse => ({
        ...page,
        items: page.items.map((item) => {
          if (item.readAt !== null || !matches(item.id)) return item;
          if (!counted.has(item.id)) {
            counted.add(item.id);
            newlyRead += 1;
          }
          return { ...item, readAt };
        }),
      });
      if (isFeed(data)) return { ...data, pages: data.pages.map(markPage) };
      if (typeof data === 'object' && data !== null && 'items' in data) {
        return markPage(data as NotificationListResponse);
      }
      return data;
    },
  );

  const lower = (count: number) => (input.all ? 0 : Math.max(0, count - newlyRead));
  queryClient.setQueryData<UnreadCountResponse>(queryKeys.notifications.unreadCount(), (data) =>
    data ? { count: lower(data.count) } : data,
  );
  queryClient.setQueryData<MeResponse>(queryKeys.me(), (data) =>
    data ? { ...data, unreadNotifications: lower(data.unreadNotifications) } : data,
  );
  return newlyRead;
}

/**
 * Marks notifications (or all of them) read, optimistically. The lists and counts are refetched
 * once the server answers, which also undoes the change if it failed.
 */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsReadInput) =>
      api.post('/api/notifications/read', input, { schema: markNotificationsReadResponseSchema }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all() });
      applyRead(queryClient, input);
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
      ]),
  });
}
