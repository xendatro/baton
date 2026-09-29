import { BellOffIcon, BellRingIcon, CheckCheckIcon, CheckIcon, InboxIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { AgentActionRequest } from '@shared/schemas/agentActions';
import type { MeTeam, Notification } from '@shared/schemas/core';
import { AgentActionControls } from '@web/components/common/AgentActionControls';
import { ActorAvatar } from '@web/components/common/AgentAvatar';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { EmptyState } from '@web/components/common/EmptyState';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { PageHeader } from '@web/components/common/PageHeader';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { useNow } from '@web/components/common/useNow';
import { useUnreadCount } from '@web/components/layout/useUnreadCount';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/components/ui/tabs';
import { useAgentActionRequests } from '@web/lib/agentActions';
import { agentTitle, isAgentUser } from '@web/lib/agentMembers';
import { useMe } from '@web/lib/auth';
import {
  desktopPermission,
  requestDesktopPermission,
  setAlertPrefs,
  useAlertPrefs,
  type DesktopPermission,
} from '@web/lib/desktopNotifications';
import { useInView } from '@web/lib/useInView';
import { cn } from '@web/lib/utils';
import { TeamIcon } from '@web/pages/teams/TeamIcon';
import { actorName, dayLabel, NOTIFICATION_KINDS, notificationContext } from './notificationText';
import { InboxFilters } from './InboxFilters';
import { scopeLabel, useInboxScope } from './inboxScope';
import {
  useInbox,
  useMarkNotificationsRead,
  useNotificationCounts,
  type InboxScope,
} from './queries';

type InboxTab = 'all' | 'unread';

/** `/inbox`: notifications, newest first, with unread state and mark-as-read. */
export default function InboxPage() {
  const [params, setParams] = useSearchParams();
  const tab: InboxTab = params.get('filter') === 'unread' ? 'unread' : 'all';
  const allUnread = useUnreadCount();
  const markRead = useMarkNotificationsRead();
  const counts = useNotificationCounts();
  const [scope, setScope] = useInboxScope();
  const scoped = scope.teamId !== undefined || scope.projectId !== undefined;
  // Within a filter, the unread badge and "Mark all as read" follow it (BAT-34).
  const unread = !scoped
    ? allUnread
    : scope.projectId
      ? (counts.data?.projects.find((row) => row.projectId === scope.projectId)?.unread ?? 0)
      : (counts.data?.teams.find((row) => row.teamId === scope.teamId)?.unread ?? 0);

  const setTab = (next: string) =>
    setParams(next === 'unread' ? { filter: 'unread' } : {}, { replace: true });

  const markAllRead = () =>
    markRead.mutate(
      { all: true, ...scope },
      { onSuccess: ({ updated }) => toast.success(updated > 0 ? 'All caught up' : 'Nothing new') },
    );

  return (
    <PageContainer width="narrow">
      <PageHeader
        title="Inbox"
        description="Mentions, assignments, replies and updates on your work."
        actions={
          <>
            <EnableDesktopNotifications />
            <Button
              variant="outline"
              size="sm"
              onClick={markAllRead}
              disabled={unread === 0 || markRead.isPending}
            >
              <CheckCheckIcon aria-hidden="true" />
              Mark all as read
            </Button>
          </>
        }
      />
      <InboxFilters
        counts={counts.data}
        scope={scope}
        onChange={setScope}
        unreadOnly={tab === 'unread'}
      />
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList variant="line" className="w-full justify-start border-b pb-0">
          <TabsTrigger value="all" className="flex-none px-3">
            All
          </TabsTrigger>
          <TabsTrigger value="unread" className="flex-none px-3">
            Unread
            {unread > 0 ? (
              <span className="rounded-full bg-primary px-1.5 text-[0.7rem] leading-4 font-semibold text-primary-foreground tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="all">
          <NotificationList
            unreadOnly={false}
            scope={scope}
            onShowAll={() => setTab('all')}
            onClearScope={() => setScope({})}
          />
        </TabsContent>
        <TabsContent value="unread">
          <NotificationList
            unreadOnly
            scope={scope}
            onShowAll={() => setTab('all')}
            onClearScope={() => setScope({})}
          />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function NotificationList({
  unreadOnly,
  scope,
  onShowAll,
  onClearScope,
}: {
  unreadOnly: boolean;
  scope: InboxScope;
  onShowAll: () => void;
  onClearScope: () => void;
}) {
  const inbox = useInbox(unreadOnly, scope);
  const teams = useMe().data?.teams ?? [];
  const markRead = useMarkNotificationsRead();
  const now = new Date(useNow());
  const sentinel = useRef<HTMLDivElement>(null);
  const nearEnd = useInView(sentinel, {
    rootMargin: '0px 0px 400px 0px',
    enabled: inbox.hasNextPage,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = inbox;
  // Sign-off requests (design §6) show Approve / Deny, or what became of them.
  const hasActionRequests =
    inbox.data?.pages.some((page) =>
      page.items.some((item) => item.type === 'agent_action_request'),
    ) ?? false;
  const actionRequests = useAgentActionRequests('all', { enabled: hasActionRequests });
  useEffect(() => {
    if (nearEnd && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [nearEnd, hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (inbox.isPending) return <InboxSkeleton />;
  if (inbox.isError) {
    return (
      <ErrorState
        title="Couldn’t load your inbox"
        error={inbox.error}
        onRetry={() => void inbox.refetch()}
      />
    );
  }
  const items = inbox.data.pages.flatMap((page) => page.items);
  if (items.length === 0 && (scope.teamId || scope.projectId)) {
    return (
      <EmptyState
        icon={unreadOnly ? CheckCheckIcon : InboxIcon}
        title={
          unreadOnly
            ? `Nothing unread from ${scopeLabel(scope, teams)}`
            : `Nothing from ${scopeLabel(scope, teams)}`
        }
        description="Other teams and projects may have notifications for you."
        action={
          <Button variant="outline" onClick={onClearScope}>
            Show all teams and projects
          </Button>
        }
      />
    );
  }
  if (items.length === 0) {
    return unreadOnly ? (
      <EmptyState
        icon={CheckCheckIcon}
        title="You’re all caught up"
        description="No unread notifications. New ones show up here as they arrive."
        action={
          <Button variant="outline" onClick={onShowAll}>
            View all notifications
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={InboxIcon}
        title="No notifications yet"
        description="You’ll hear here when someone mentions you, assigns you a task, replies to something you follow, or resolves your issue."
        action={
          <Button variant="outline" asChild>
            <Link to="/my-tasks">Go to my tasks</Link>
          </Button>
        }
      />
    );
  }

  const days = items.map((notification) => dayLabel(notification.createdAt, now));
  const requests = new Map(
    (actionRequests.data?.items ?? []).map((request) => [request.id, request]),
  );
  return (
    <div className="space-y-2">
      <ul className="overflow-hidden rounded-lg border bg-card" aria-label="Notifications">
        {items.map((notification, index) => {
          const day = days[index];
          const header = index === 0 || day !== days[index - 1];
          return (
            <Fragment key={notification.id}>
              {header ? (
                <li
                  className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground first:rounded-t-lg sm:px-4"
                  aria-hidden="true"
                >
                  {day}
                </li>
              ) : null}
              <NotificationRow
                notification={notification}
                actionRequest={
                  notification.type === 'agent_action_request'
                    ? requests.get(notification.entityId)
                    : undefined
                }
                teams={teams}
                onRead={() => markRead.mutate({ ids: [notification.id] })}
              />
            </Fragment>
          );
        })}
      </ul>
      <div ref={sentinel} />
      {inbox.hasNextPage ? (
        <div className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void inbox.fetchNextPage()}
            disabled={inbox.isFetchingNextPage}
          >
            {inbox.isFetchingNextPage ? <Spinner className="size-4" /> : null}
            {inbox.isFetchingNextPage ? 'Loading…' : 'Load older notifications'}
          </Button>
        </div>
      ) : items.length > 10 ? (
        <p className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
          <BellOffIcon className="size-3.5" aria-hidden="true" />
          That’s everything.
        </p>
      ) : null}
    </div>
  );
}

interface NotificationRowProps {
  notification: Notification;
  /** The sign-off request of an `agent_action_request` notification, once loaded. */
  actionRequest?: AgentActionRequest;
  teams: readonly MeTeam[];
  onRead: () => void;
}

function NotificationRow({ notification, actionRequest, teams, onRead }: NotificationRowProps) {
  const kind = NOTIFICATION_KINDS[notification.type];
  const Icon = kind.icon;
  const unread = notification.readAt === null;
  const { team, project } = notificationContext(notification, teams);
  return (
    <li
      className={cn(
        'group relative flex items-start gap-3 border-b px-3 py-3 transition-colors last:border-b-0 hover:bg-accent/40 sm:px-4',
        unread && 'bg-primary/[0.03] dark:bg-primary/[0.06]',
      )}
      data-testid="notification"
      data-unread={unread ? 'true' : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-2 size-2 shrink-0 rounded-full sm:mt-3',
          unread ? 'bg-primary' : 'bg-transparent',
        )}
      />
      <span
        className={cn(
          'mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-full border bg-background sm:flex',
          kind.tone,
        )}
        title={kind.label}
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={notification.url}
          onClick={() => {
            if (unread) onRead();
          }}
          className="block rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
        >
          <span className="sr-only">{unread ? 'Unread: ' : ''}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <ActorAvatar
              user={notification.actor}
              agentName={notification.viaAgentName}
              keyName={notification.viaKeyName}
              size="sm"
            />
            {notification.actor && isAgentUser(notification.actor) ? (
              // Agent members: "Ethan AI [AI]", the key it used in the tooltip.
              <span
                className="inline-flex min-w-0 items-center gap-1.5"
                title={agentTitle(notification.actor, {
                  agentName: notification.viaAgentName,
                  keyName: notification.viaKeyName,
                })}
              >
                <span className="truncate font-medium text-foreground">
                  {notification.actor.name}
                </span>
                <AgentBadge />
              </span>
            ) : notification.viaAgentName ? (
              // BAT-6: "Claude via Ethan's MSI".
              <>
                <span className="font-medium text-foreground">{notification.viaAgentName}</span>
                <span>
                  via {actorName(notification)}’s {notification.viaKeyName}
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{actorName(notification)}</span>
                {notification.viaKeyName ? <span>via {notification.viaKeyName}</span> : null}
              </>
            )}
            <span>{kind.verb}</span>
          </span>
          <span
            className={cn(
              'mt-1 line-clamp-2 block text-sm break-words sm:truncate',
              unread ? 'font-semibold text-foreground' : 'font-medium text-foreground/90',
            )}
          >
            {notification.title}
          </span>
          {notification.snippet ? (
            <span className="mt-0.5 line-clamp-2 block text-sm break-words text-muted-foreground">
              {notification.snippet}
            </span>
          ) : null}
        </Link>
        {actionRequest ? (
          // Above the row's link overlay, so the buttons get the clicks.
          <AgentActionControls request={actionRequest} className="relative z-10 mt-2" />
        ) : null}
        <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {team ? (
            <>
              <TeamIcon
                icon={team.icon}
                name={team.name}
                color={team.color}
                size="sm"
                className="size-4 rounded text-[0.6rem]"
              />
              <span className="truncate">{team.name}</span>
            </>
          ) : null}
          {project ? (
            <>
              <span aria-hidden="true">·</span>
              <EntityIcon icon={project.icon} name={project.name} color={project.color} />
              <span className="truncate">{project.name}</span>
            </>
          ) : null}
          {team ? <span aria-hidden="true">·</span> : null}
          <RelativeTime value={notification.createdAt} className="shrink-0" />
        </span>
      </div>
      {unread ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative z-10 shrink-0 text-muted-foreground opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
          onClick={onRead}
          aria-label={`Mark “${notification.title}” as read`}
          title="Mark as read"
        >
          <CheckIcon aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}

function InboxSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-lg border"
      role="status"
      aria-label="Loading notifications"
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
          <Skeleton className="mt-0.5 size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48 max-w-full" />
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * BAT-2: offers desktop notifications until they're on or blocked (the browser asks on click;
 * Settings → Notifications has the switch and the sound).
 */
function EnableDesktopNotifications() {
  const prefs = useAlertPrefs();
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission);
  if (permission === 'unsupported' || permission === 'denied') return null;
  if (prefs.desktop && permission === 'granted') return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() =>
        void requestDesktopPermission().then((result) => {
          setPermission(result);
          setAlertPrefs({ desktop: result === 'granted' });
          if (result === 'granted') toast.success('Desktop notifications on');
        })
      }
    >
      <BellRingIcon aria-hidden="true" />
      Enable desktop notifications
    </Button>
  );
}
