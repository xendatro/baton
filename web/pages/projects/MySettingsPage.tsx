import { FolderIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { resolveChain } from '@shared/agentChains';
import type { AgentNotificationLevel } from '@shared/constants';
import type { Chain } from '@shared/schemas/agentRunner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import {
  PROJECT_NOTIFY_KIND_LABELS,
  PROJECT_NOTIFY_KINDS,
  PROJECT_NOTIFY_LEVEL_LABELS,
  PROJECT_NOTIFY_LEVELS,
  type MyProjectSettings,
  type ProjectNotifications,
  type ProjectNotifyLevel,
} from '@shared/schemas/projectSettings';
import { AgentConnectionStatus } from '@web/components/common/AgentConnectionNotice';
import { ErrorState } from '@web/components/common/ErrorState';
import { PageContainer } from '@web/components/common/PageContainer';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Label } from '@web/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/components/ui/radio-group';
import { Skeleton } from '@web/components/ui/skeleton';
import { Switch } from '@web/components/ui/switch';
import { errorMessage } from '@web/lib/api';
import { isDesktopApp, useDesktopState } from '@web/lib/desktop';
import { hardestFirst } from '@web/lib/difficulty';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { ChainEditor } from '../settings/ChainEditor';
import { chainSummary } from '../settings/chainSummary';
import { SettingsCard, SettingsCardSkeleton } from '../settings/SettingsCard';
import { useDifficulties } from './difficultyQueries';
import { useMyProjectSettings, useUpdateMyProjectSettings } from './mySettingsQueries';

/**
 * `/t/:team/p/:key/me`: your settings for this project (BAT-29), like Discord's per-server
 * settings. This project's notifications and your models by its difficulty levels, each "Use my
 * defaults" (the account's) until you override it, and in the desktop app this project's folder
 * on this computer. Personal: anyone who can see the project has their own.
 */
export default function MySettingsPage() {
  const { team, project } = useRouteContext();
  if (!team || !project) return null;
  return <MySettings team={team} project={project} />;
}

function MySettings({ team, project }: { team: MeTeam; project: MeProject }) {
  useDocumentTitle(['Your settings', project.name]);
  const settings = useMyProjectSettings(project.id);
  return (
    <PageContainer width="narrow">
      <div className="grid gap-6">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Your settings for this project</h2>
          <p className="text-sm text-muted-foreground">
            Only you see these. Anything on “Use my defaults” follows your account’s{' '}
            <Link to="/settings/agent" className="underline underline-offset-2">
              agent
            </Link>{' '}
            and{' '}
            <Link to="/settings/automatic-agents" className="underline underline-offset-2">
              Automatic agents
            </Link>{' '}
            settings.
          </p>
        </header>
        {settings.isPending ? (
          <>
            <SettingsCardSkeleton rows={3} />
            <SettingsCardSkeleton rows={3} />
          </>
        ) : settings.isError ? (
          <ErrorState
            title="Couldn’t load your settings"
            error={settings.error}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <>
            <SettingsCard
              title="Agent connection"
              description="Whether your agent takes this project’s jobs: the desktop app with a folder for it, or an MCP listener."
            >
              <AgentConnectionStatus projectId={project.id} />
            </SettingsCard>
            <NotificationsCard projectId={project.id} settings={settings.data} />
            <ModelsCard projectId={project.id} settings={settings.data} />
            {isDesktopApp() ? <FolderCard projectId={project.id} /> : null}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Settings of the project itself (statuses, labels, access) are under{' '}
          <Link
            to={`/t/${team.slug}/p/${project.key}/settings`}
            className="underline underline-offset-2"
          >
            Settings
          </Link>
          .
        </p>
      </div>
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

const AGENT_LEVEL_LABELS: Record<AgentNotificationLevel, string> = {
  all: 'Everything',
  needs_me: 'Only what needs you',
  none: 'Nothing',
};

interface NotificationsDraft {
  notifications: ProjectNotifications | null;
  agentNotifications: AgentNotificationLevel | null;
}

function NotificationsCard({
  projectId,
  settings,
}: {
  projectId: string;
  settings: MyProjectSettings;
}) {
  const update = useUpdateMyProjectSettings(projectId);
  const saved: NotificationsDraft = {
    notifications: settings.notifications,
    agentNotifications: settings.agentNotifications,
  };
  const [draft, setDraft] = useState<NotificationsDraft | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const ids = useId();
  const own = value.notifications;
  const shown = own ?? settings.defaults.notifications;
  const set = (patch: Partial<NotificationsDraft>) => setDraft({ ...value, ...patch });
  const setOwn = (patch: Partial<ProjectNotifications>) =>
    set({ notifications: { ...shown, ...patch } });

  const submit = () =>
    update.mutate(value, {
      onSuccess: () => {
        setDraft(null);
        toast.success('Saved your notifications for this project');
      },
      onError: (cause) => toast.error(errorMessage(cause)),
    });

  return (
    <SettingsCard
      title="Notifications"
      description="What of this project reaches your inbox. Mentions of you and assignments come through unless you choose Nothing; your agent’s sign-off requests always do."
      footer={
        <div className="flex w-full justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || update.isPending}>
            {update.isPending ? <Spinner /> : null}
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
                ? 'This project has its own notifications.'
                : `Your account’s: ${PROJECT_NOTIFY_LEVEL_LABELS[settings.defaults.notifications.level].toLowerCase()}.`}
            </p>
          </div>
          <Switch
            id={`${ids}-defaults`}
            checked={own === null}
            onCheckedChange={(on) =>
              set({ notifications: on ? null : { ...settings.defaults.notifications } })
            }
          />
        </div>
        <fieldset className="grid gap-3" disabled={own === null}>
          <legend className="sr-only">This project’s notifications</legend>
          <RadioGroup
            value={shown.level}
            onValueChange={(level) => setOwn({ level: level as ProjectNotifyLevel })}
            aria-label="Notifications for this project"
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
              Use my default ({AGENT_LEVEL_LABELS[settings.defaults.agentNotifications]})
            </option>
            {(Object.keys(AGENT_LEVEL_LABELS) as AgentNotificationLevel[]).map((level) => (
              <option key={level} value={level}>
                {AGENT_LEVEL_LABELS[level]}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            How much of what your agent does in this project reaches your inbox.
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Models by difficulty
// ---------------------------------------------------------------------------------------------

function ModelsCard({ projectId, settings }: { projectId: string; settings: MyProjectSettings }) {
  const levels = useDifficulties(projectId);
  const update = useUpdateMyProjectSettings(projectId);
  const [draft, setDraft] = useState<Record<string, Chain> | null>(null);
  const mapping = draft ?? settings.models.levels;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings.models.levels);
  const setLevel = (levelId: string, chain: Chain | null) => {
    const next = { ...mapping };
    if (chain === null) delete next[levelId];
    else next[levelId] = chain;
    setDraft(next);
  };
  const submit = () =>
    update.mutate(
      {
        models: {
          levels: Object.fromEntries(Object.entries(mapping).filter(([, chain]) => chain.length)),
        },
      },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success('Saved your models for this project');
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );

  return (
    <SettingsCard
      title="Models by difficulty"
      description="Which harness and model your agent runs for this project’s tasks, by their difficulty. When a harness is out of usage, the desktop app moves on to the next step. Hardest first: a level on your defaults uses the closest easier level you mapped, then a harder one, then your account’s models."
      footer={
        <div className="flex w-full justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save models
          </Button>
        </div>
      }
    >
      {levels.isPending ? (
        <Skeleton className="h-24" />
      ) : levels.isError ? (
        <ErrorState
          title="Couldn’t load the difficulty levels"
          error={levels.error}
          onRetry={() => void levels.refetch()}
        />
      ) : levels.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project has no difficulty levels: its tasks use your{' '}
          <Link to="/settings/automatic-agents" className="underline underline-offset-2">
            default models
          </Link>
          .
        </p>
      ) : (
        <ul className="grid gap-3" aria-label="Models by difficulty level, hardest first">
          {hardestFirst(levels.data).map((level) => {
            const chain = mapping[level.id];
            const inherits = chain === undefined;
            const resolved = resolveChain({
              levels: levels.data,
              difficultyId: level.id,
              project: { levels: mapping },
              defaults: settings.defaults.models,
            });
            const switchId = `defaults-${level.id}`;
            return (
              <li key={level.id} className="grid gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: level.color }}
                      aria-hidden="true"
                    />
                    {level.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={switchId} className="text-xs font-normal">
                      Use my defaults
                    </Label>
                    <Switch
                      id={switchId}
                      aria-label={`${level.name}: use my defaults`}
                      checked={inherits}
                      onCheckedChange={(on) =>
                        setLevel(
                          level.id,
                          on ? null : resolved.chain.map((entry) => ({ ...entry })),
                        )
                      }
                    />
                  </div>
                </div>
                {inherits ? (
                  <p className="text-sm text-muted-foreground">{sourceText(resolved)}</p>
                ) : (
                  <ChainEditor
                    label={`${level.name} chain`}
                    value={chain}
                    onChange={(next) => setLevel(level.id, next)}
                    emptyText="No model yet: add one, or use your defaults."
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsCard>
  );
}

/** Where an inherited level's model comes from, in words. */
function sourceText(resolved: { chain: Chain; source: string }): string {
  const models = chainSummary(resolved.chain);
  const closest = / \(closest mapped level\)$/.exec(resolved.source);
  if (closest) {
    return `From ${resolved.source.slice(0, closest.index)}, the closest level you mapped: ${models}`;
  }
  return `From your defaults: ${models}`;
}

// ---------------------------------------------------------------------------------------------
// This computer's folder (desktop app only)
// ---------------------------------------------------------------------------------------------

function FolderCard({ projectId }: { projectId: string }) {
  const { state, loading } = useDesktopState();
  const folder = state?.folders[projectId];
  return (
    <SettingsCard
      title="Folder on this computer"
      description="Where this project’s jobs run on this computer. It stays on this computer."
      action={
        <Button asChild size="sm" variant="outline">
          <Link to="/desktop/folders">Change folder</Link>
        </Button>
      }
    >
      {loading ? (
        <Skeleton className="h-5 w-64" />
      ) : (
        <p className="flex items-center gap-2 text-sm">
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">
            {folder
              ? (folder.path ?? 'No folder: a scratch folder the app makes')
              : 'No folder yet: its jobs don’t run on this computer'}
          </span>
        </p>
      )}
    </SettingsCard>
  );
}
