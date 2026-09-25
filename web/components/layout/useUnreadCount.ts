import { useQuery } from '@tanstack/react-query';
import { unreadCountResponseSchema } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Unread notifications, kept live by `notification.created` events (web/lib/live.ts). */
export function useUnreadCount(): number {
  const query = useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: ({ signal }) =>
      api.get('/api/notifications/unread-count', { schema: unreadCountResponseSchema, signal }),
  });
  return query.data?.count ?? 0;
}
