import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { notificationListResponseSchema } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { useLiveEventListener } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Toasts each new notification (SPEC §1.9). Live events carry no data, so the newest unread
 * notification is fetched when `notification.created` arrives.
 */
export function useLiveNotificationToasts(userId: string | undefined): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useLiveEventListener((event) => {
    if (event.type !== 'notification.created' || !userId) return;
    if (event.userId && event.userId !== userId) return;
    const params = { limit: 1, unread: '1' } as const;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.notifications.list(params),
        queryFn: ({ signal }) =>
          api.get('/api/notifications', {
            query: params,
            schema: notificationListResponseSchema,
            signal,
          }),
        staleTime: 0,
      })
      .then(({ items }) => {
        const [latest] = items;
        if (!latest) return;
        toast(latest.title, {
          id: `notification-${latest.id}`,
          description: latest.snippet || undefined,
          action: { label: 'Open', onClick: () => void navigate(latest.url) },
        });
      })
      .catch(() => undefined);
  });
}
