import { useId, useState } from 'react';
import type { AgentNotificationLevel } from '@shared/constants';
import {
  PROJECT_NOTIFY_KIND_LABELS,
  PROJECT_NOTIFY_KINDS,
  PROJECT_NOTIFY_LEVEL_LABELS,
  PROJECT_NOTIFY_LEVELS,
  type ProjectNotifications,
  type ProjectNotifyLevel,
} from '@shared/schemas/projectSettings';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Switch } from '@web/components/ui/switch';
import { SettingsCard } from '../settings/SettingsCard';

const AGENT_LEVEL_LABELS: Record<AgentNotificationLevel, string> = {
  all: 'Everything',
  needs_me: 'Only what needs you',
  none: 'Nothing',
};

export interface NotificationOverrides {
  notifications: ProjectNotifications | null;
  agentNotifications: AgentNotificationLevel | null;
}

type Source = 'team' | 'account';

/**
 * Your notifications for a project (BAT-29) or a team (BAT-34): "Use my defaults" or an override
 * (a level and per-kind switches), and your agent's activity there. A project's defaults are the
 * team's override when there is one (`inherited`), else the account's.
 */
export function NotificationSettingsCard({
  scope,
  saved,
  defaults,
  inherited,
  saving,
  onSave,
}: {
  scope: 'project' | 'team';
  saved: NotificationOverrides;
  defaults: { notifications: ProjectNotifications; agentNotifications: AgentNotificationLevel };
  inherited?: { notifications: Source; agentNotifications: Source };
  saving: boolean;
  /** Saves; call `done` once saved to leave editing. */
  onSave: (value: NotificationOverrides, done: () => void) => void;
}) {
  const [draft, setDraft] = useState<NotificationOverrides | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const ids = useId();
  const own = value.notifications;
  const shown = own ?? defaults.notifications;
  const set = (patch: Partial<NotificationOverrides>) => setDraft({ ...value, ...patch });
  const setOwn = (patch: Partial<ProjectNotifications>) =>
    set({ notifications: { ...shown, ...patch } });
  const whose = (source: Source | undefined) =>
    source === 'team' ? 'Your team’s' : 'Your account’s';
  const here = scope === 'project' ? 'this project' : 'this team';

  return (
    <SettingsCard
      title="Notifications"
      description={
        scope === 'project'
          ? 'What of this project reaches your inbox. Mentions of you and assignments come through unless you choose Nothing; your agent’s sign-off requests always do.'
          : 'What of this team’s projects reaches your inbox, unless a project has its own settings. Mentions of you and assignments come through unless you choose Nothing; your agent’s sign-off requests always do.'
      }
      footer={
        <div className="flex w-full justify-end">
          <Button
            size="sm"
            onClick={() => onSave(value, () => setDraft(null))}
            disabled={!dirty || saving}
          >
            {saving ? <Spinner /> : null}
            Save notifications
          </Button>
        </div>
      }
    >
      <div className="grid gap-5">
        <div className="flex items-center justify-between gap-4">
          <div className="grid gap-0.5">
            <Label htmlFor={`${ids}-defaults`}>Use my defaults</Label>
            <p className="text-xs text-muted-foreground">
              {own
                ? `This ${scope} has its own notifications.`
                : `${whose(inherited?.notifications)}: ${PROJECT_NOTIFY_LEVEL_LABELS[defaults.notifications.level].toLowerCase()}.`}
            </p>
          </div>
          <Switch
            id={`${ids}-defaults`}
            checked={own === null}
            onCheckedChange={(on) =>
              set({ notifications: on ? null : { ...defaults.notifications } })
            }
          />
        </div>
        <fieldset className="grid gap-3" disabled={own === null}>
          <legend className="sr-only">{`Notifications for ${here}`}</legend>
          <RadioGroup
            value={shown.level}
            onValueChange={(level) => setOwn({ level: level as ProjectNotifyLevel })}
            aria-label={`Notifications for ${here}`}
            disabled={own === null}
            className="gap-2"
          >
            {PROJECT_NOTIFY_LEVELS.map((level) => (
              <div key={level} className="flex items-center gap-2">
                <RadioGroupItem id={`${ids}-level-${level}`} value={level} />
                <Label htmlFor={`${ids}-level-${level}`} className="font-normal">
                  {PROJECT_NOTIFY_LEVEL_LABELS[level]}
                </Label>
              </div>
            ))}
          </RadioGroup>
          {shown.level === 'all' ? (
            <ul className="grid gap-2 rounded-md border p-3" aria-label="Kinds of notifications">
              {PROJECT_NOTIFY_KINDS.map((kind) => (
                <li key={kind} className="flex items-center justify-between gap-4">
                  <div className="grid gap-0.5">
                    <Label htmlFor={`${ids}-kind-${kind}`} className="font-normal">
                      {PROJECT_NOTIFY_KIND_LABELS[kind].label}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {PROJECT_NOTIFY_KIND_LABELS[kind].hint}
                    </p>
                  </div>
                  <Switch
                    id={`${ids}-kind-${kind}`}
                    checked={shown.kinds[kind]}
                    disabled={own === null}
                    onCheckedChange={(on) => setOwn({ kinds: { ...shown.kinds, [kind]: on } })}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-agent`}>Your agent’s activity here</Label>
          <select
            id={`${ids}-agent`}
            value={value.agentNotifications ?? ''}
            onChange={(event) =>
              set({
                agentNotifications: (event.target.value || null) as AgentNotificationLevel | null,
              })
            }
            className="h-8 w-full max-w-xs rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
          >
            <option value="">
              {`${inherited?.agentNotifications === 'team' ? 'Use my team default' : 'Use my default'} (${AGENT_LEVEL_LABELS[defaults.agentNotifications]})`}
            </option>
            {(Object.keys(AGENT_LEVEL_LABELS) as AgentNotificationLevel[]).map((level) => (
              <option key={level} value={level}>
                {AGENT_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {`How much of what your agent does in ${here} reaches your inbox.`}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}
