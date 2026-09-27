import { PauseIcon, ShieldCheckIcon } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { AgentNotificationLevel } from '@shared/constants';
import type { AgentSettings } from '@shared/schemas/account';
import { AgentActionControls } from '@web/components/common/AgentActionControls';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { useAgentActionRequests } from '@web/lib/agentActions';
import { useAgentSettings, useUpdateAgentSettings } from './queries';
import { SettingsCard, SettingsCardSkeleton, SettingsPage } from './SettingsCard';

const LEVELS: ReadonlyArray<{ value: AgentNotificationLevel; label: string; hint: string }> = [
  {
    value: 'all',
    label: 'Everything',
    hint: 'Everything your agent does that notifies anyone',
  },
  {
    value: 'needs_me',
    label: 'Only what needs you',
    hint: 'Only when your agent mentions, assigns or answers you',
  },
  {
    value: 'none',
    label: 'Nothing',
    hint: 'Never notify you about your agent’s activity, except requests for your sign-off',
  },
];

function isLevel(value: string): value is AgentNotificationLevel {
  return LEVELS.some((level) => level.value === value);
}

/**
 * `/settings/agent`: your agent member (docs/design/agents-and-pipelines.md §1), which everything
 * written through your API keys is authored by: pause it, and choose how much of its activity
 * reaches your inbox.
 */
export default function AgentSettingsPage() {
  const settings = useAgentSettings();
  return (
    <SettingsPage
      title="Agent"
      description="Your agent is a team member that acts for you: everything written with your API keys is authored by it."
    >
      {settings.isPending ? (
        <div className="grid gap-6" role="status" aria-label="Loading your agent">
          <SettingsCardSkeleton rows={1} />
          <SettingsCardSkeleton rows={3} />
        </div>
      ) : settings.isError ? (
        <ErrorState
          title="Couldn’t load your agent"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <AgentSettingsCards settings={settings.data} />
      )}
    </SettingsPage>
  );
}

/**
 * "Pending agent actions" (design §6): destructive actions your agent asked for that wait for
 * your sign-off, with Approve / Deny. Live: `agent_action.changed` refreshes it.
 */
function PendingActionsCard() {
  const pending = useAgentActionRequests('pending');
  const description =
    'Destructive actions your agent asked for (deleting, removing members, …) in teams that want them signed off. Approving runs the action as your agent; nothing happens until you do. Requests expire after 7 days.';
  return (
    <SettingsCard title="Pending agent actions" description={description}>
      {pending.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading pending agent actions">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : pending.isError ? (
        <ErrorState
          title="Couldn’t load your agent’s requests"
          error={pending.error}
          onRetry={() => void pending.refetch()}
        />
      ) : pending.data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <ShieldCheckIcon className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Nothing waiting for you</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            When your agent asks to do something destructive, it shows up here and in your inbox.
          </p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/inbox">Open your inbox</Link>
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-md border" aria-label="Pending agent actions">
          {pending.data.items.map((request) => (
            <li
              key={request.id}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid="pending-agent-action"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm break-words">
                  <span className="font-medium">{request.agent?.name ?? 'Your agent'}</span> wants
                  to{' '}
                  {request.url ? (
                    <Link to={request.url} className="underline-offset-4 hover:underline">
                      {request.summary}
                    </Link>
                  ) : (
                    request.summary
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {request.team.name}
                  {request.via ? ` · via ${request.via.keyName}` : ''} · asked{' '}
                  <RelativeTime value={request.createdAt} />
                  {request.runsAsOwner ? ' · runs as you' : ''}
                </p>
              </div>
              <AgentActionControls request={request} className="shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

function AgentSettingsCards({ settings }: { settings: AgentSettings }) {
  const update = useUpdateAgentSettings();
  const pauseId = useId();
  const { agent, pausedAt, notifications } = settings;

  const setPaused = (paused: boolean) =>
    update.mutate(
      { paused },
      {
        onSuccess: () =>
          toast.success(paused ? `Paused ${agent.name}` : `${agent.name} can write again`),
      },
    );

  const setLevel = (level: AgentNotificationLevel) => {
    if (level === notifications) return;
    update.mutate(
      { notifications: level },
      { onSuccess: () => toast.success('Agent notifications saved') },
    );
  };

  return (
    <>
      <SettingsCard
        title="Your agent"
        description={
          <>
            Your API keys act as your agent. Admins can give it roles like any member; it can never
            do more than you can. Manage its keys in{' '}
            <Link
              to="/settings/api-keys"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              API keys
            </Link>
            .
          </>
        }
      >
        <div className="flex items-center gap-3">
          <UserAvatar user={agent} size="xl" />
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-semibold">{agent.name}</span>
              <AgentBadge />
            </p>
            <p className="truncate text-sm text-muted-foreground">@{agent.username}</p>
          </div>
        </div>
      </SettingsCard>

      <PendingActionsCard />

      <SettingsCard
        title="Pause"
        description="Stop your agent from changing anything, for example while it misbehaves."
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <PauseIcon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-1">
              <Label htmlFor={pauseId}>Pause your agent</Label>
              <p className="text-xs text-muted-foreground">
                Paused: its API keys can read but not write.
                {pausedAt ? (
                  <>
                    {' '}
                    Paused <RelativeTime value={pausedAt} />.
                  </>
                ) : null}
              </p>
            </div>
          </div>
          <Switch
            id={pauseId}
            checked={pausedAt !== null}
            disabled={update.isPending}
            onCheckedChange={setPaused}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Notifications"
        description="How much of your agent’s activity reaches your inbox."
      >
        <RadioGroup
          value={notifications}
          onValueChange={(value) => {
            if (isLevel(value)) setLevel(value);
          }}
          aria-label="Agent notifications"
          disabled={update.isPending}
        >
          {LEVELS.map((level) => {
            const id = `${pauseId}-${level.value}`;
            return (
              <div key={level.value} className="flex items-start gap-3">
                <RadioGroupItem value={level.value} id={id} className="mt-0.5" />
                <div className="grid gap-0.5">
                  <Label htmlFor={id}>{level.label}</Label>
                  <p className="text-xs text-muted-foreground">{level.hint}</p>
                </div>
              </div>
            );
          })}
        </RadioGroup>
      </SettingsCard>
    </>
  );
}
