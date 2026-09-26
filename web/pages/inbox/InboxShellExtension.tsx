import { useQueryClient } from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { notificationListResponseSchema } from '@shared/schemas/core';
import { usePaletteCommands } from '@web/components/palette/registry';
import { useUnreadCount } from '@web/components/layout/useUnreadCount';
import { api } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { useLiveEventListener } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';
import { notificationSentence } from './notificationText';
import { useMarkNotificationsRead } from './queries';

/** Unread notifications fetched to find the one a live event announced. */
const LOOKUP_LIMIT = 10;

/**
 * App-wide inbox behaviour (SPEC §1.9), mounted once in the shell: a toast with an Open action
 * for each new notification while the viewer is elsewhere (the inbox updates in place), and the
 * "Mark all notifications as read" palette command.
 */
export default function InboxShellExtension() {
  const me = useMe().data;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unread = useUnreadCount();
  const markRead = useMarkNotificationsRead();
  const userId = me?.user.id;

  useLiveEventListener((event) => {
    if (event.type !== 'notification.created' || !userId) return;
    if (event.userId && event.userId !== userId) return;
    if (location.pathname === '/inbox') return;
    const params = { view: 'toast', limit: LOOKUP_LIMIT, unread: '1' } as const;
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.notifications.list(params),
        queryFn: ({ signal }) =>
          api.get('/api/notifications', {
            query: { limit: LOOKUP_LIMIT, unread: '1' },
            schema: notificationListResponseSchema,
            signal,
          }),
        staleTime: 0,
      })
      .then(({ items }) => {
        // Live events name the notification; it may already be read (another tab) or gone.
        const notification = items.find((item) => item.id === event.entityId);
        if (!notification) return;
        toast(notificationSentence(notification), {
          id: `notification-${notification.id}`,
          description: notification.title,
          action: {
            label: 'Open',
            onClick: () => {
              markRead.mutate({ ids: [notification.id] });
              void navigate(notification.url);
            },
          },
        });
      })
      .catch(() => undefined);
  });

  usePaletteCommands(
    unread > 0
      ? [
          {
            id: 'inbox.mark-all-read',
            label: 'Mark all notifications as read',
            group: 'Inbox',
            icon: CheckCheckIcon,
            keywords: ['inbox', 'clear', 'notifications'],
            perform: () =>
              markRead.mutate({ all: true }, { onSuccess: () => toast.success('All caught up') }),
          },
        ]
      : [],
  );

  return null;
}
