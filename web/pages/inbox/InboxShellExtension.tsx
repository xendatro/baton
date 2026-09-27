import { useQueryClient } from '@tanstack/react-query';
import { CheckCheckIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { notificationListResponseSchema } from '@shared/schemas/core';
import { usePaletteCommands } from '@web/components/palette/registry';
import { useUnreadCount } from '@web/components/layout/useUnreadCount';
import { api } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { announceInboxItem, joinAlertElection } from '@web/lib/desktopNotifications';
import { useLiveEventListener } from '@web/lib/live';
import { queryKeys } from '@web/lib/queryKeys';
import { notificationSentence } from './notificationText';
import { useMarkNotificationsRead } from './queries';
import { isAboutItemOnScreen } from './useMarkItemRead';

/** Unread notifications fetched to find the one a live event announced. */
const LOOKUP_LIMIT = 10;

/**
 * App-wide inbox behaviour (SPEC §1.9), mounted once in the shell: a toast with an Open action
 * for each new notification while the viewer is elsewhere (the inbox updates in place), the chime
 * and desktop notification (BAT-2, `web/lib/desktopNotifications.ts`), and the "Mark all
 * notifications as read" palette command.
 */
export default function InboxShellExtension() {
  const me = useMe().data;
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unread = useUnreadCount();
  const markRead = useMarkNotificationsRead();
  const userId = me?.user.id;

  useEffect(() => joinAlertElection(), []);

  useLiveEventListener((event) => {
    if (event.type !== 'notification.created' || !userId) return;
    if (event.userId && event.userId !== userId) return;
    // BAT-15: about the task or issue on screen, so it is marked read already.
    if (isAboutItemOnScreen(event)) return;
    const onInbox = location.pathname === '/inbox';
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
        const open = () => {
          markRead.mutate({ ids: [notification.id] });
          void navigate(notification.url);
        };
        // BAT-2: a chime and, while Baton is in the background, a desktop notification.
        announceInboxItem({
          id: notification.id,
          title: notificationSentence(notification),
          body: notification.title,
          onOpen: open,
        });
        if (onInbox) return;
        toast(notificationSentence(notification), {
          id: `notification-${notification.id}`,
          description: notification.title,
          action: { label: 'Open', onClick: open },
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
