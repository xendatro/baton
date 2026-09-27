import { PauseIcon } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { AgentNotificationLevel } from '@shared/constants';
import type { AgentSettings } from '@shared/schemas/account';
import { AgentBadge } from '@web/components/common/AgentBadge';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { UserAvatar } from '@web/components/common/UserAvatar';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Switch } from '@web/components/ui/switch';
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
  { value: 'none', label: 'Nothing', hint: 'Never notify you about your agent’s activity' },
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
