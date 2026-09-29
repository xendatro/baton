import { FolderIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
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
import type { AgentAccessRules } from '@shared/schemas/agentAccess';
import { AgentAccessEditor } from '@web/components/agentRequests/AgentAccessEditor';
import {
  useProjectAgentAccess,
  useSetProjectAgentAccess,
} from '@web/components/agentRequests/queries';
import { AgentConnectionStatus } from '@web/components/common/AgentConnectionNotice';
import { describeRule, type PrincipalOptions } from '@web/components/pickers/principals';
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
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { ChainEditor } from '../settings/ChainEditor';
import { chainSummary } from '../settings/chainSummary';
import { SettingsCard, SettingsCardSkeleton } from '../settings/SettingsCard';
import { useProjectRoles } from '../project-settings/accessQueries';
import { useMembers, useRoles } from '../teams/api';
import { useMyProjectSettings, useUpdateMyProjectSettings } from './mySettingsQueries';

/**
 * `/t/:team/p/:key/me`: your settings for this project (BAT-29), like Discord's per-server
 * settings. This project's notifications and your agent's default model here, each "Use my
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
            <AgentAccessCard teamId={team.id} projectId={project.id} />
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
// Who can start your agent here (agent access)
// ---------------------------------------------------------------------------------------------

function AgentAccessCard({ teamId, projectId }: { teamId: string; projectId: string }) {
  const access = useProjectAgentAccess(projectId);
  const save = useSetProjectAgentAccess(projectId);
  const members = useMembers(teamId);
  const roles = useRoles(teamId);
  const projectRoles = useProjectRoles(projectId);
  const [draft, setDraft] = useState<AgentAccessRules | null | undefined>(undefined);
  const switchId = useId();
  if (access.isPending) return <SettingsCardSkeleton rows={3} />;
  if (access.isError) {
    return (
      <ErrorState
        title="Couldn’t load who can start your agent here"
        error={access.error}
        onRetry={() => void access.refetch()}
      />
    );
  }
  const saved = access.data.override;
  const value = draft === undefined ? saved : draft;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);
  const options: PrincipalOptions = {
    users: members.data?.items.map((member) => member.user) ?? [],
    roles:
      roles.data?.items.map(({ id, name, color, isEveryone }) => ({
        id,
        name,
        color,
        isEveryone,
      })) ?? [],
    projectRoles: projectRoles.data?.map(({ id, name, color }) => ({ id, name, color })) ?? [],
  };
  const submit = () =>
    save.mutate(
      { override: value },
      {
        onSuccess: () => {
          setDraft(undefined);
          toast.success(
            value ? 'Saved who can start your agent here' : 'This project uses your team default',
          );
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );
  return (
    <SettingsCard
      title="Who can start your agent here"
      description="Who starts your agent in this project without asking, and who can ask you first. Anyone else can’t start it."
      footer={
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || save.isPending}>
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor={switchId}>Use team default</Label>
          <Switch
            id={switchId}
            checked={value === null}
            onCheckedChange={(useDefault) =>
              setDraft(useDefault ? null : (saved ?? access.data.teamDefault))
            }
          />
        </div>
        {value === null ? (
          <p className="text-sm text-muted-foreground">
            Your team default applies ({accessSummary(access.data.teamDefault, options)}). Change it
            in{' '}
            <Link
              to="/settings/automatic-agents#who-can-start"
              className="underline underline-offset-2"
            >
              Automatic agents
            </Link>
            .
          </p>
        ) : (
          <AgentAccessEditor
            label="Who can start your agent here"
            value={value}
            onChange={setDraft}
            options={options}
            disabled={save.isPending}
          />
        )}
      </div>
    </SettingsCard>
  );
}

/** "starts it: @caden · can ask: everyone". */
function accessSummary(rules: AgentAccessRules, options: PrincipalOptions): string {
  const auto = rules.auto.allow.length > 0 ? describeRule(rules.auto, options) : 'only you';
  const ask = rules.ask.allow.length > 0 ? describeRule(rules.ask, options) : 'nobody';
  return `starts it: ${auto} · can ask: ${ask}`;
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
// Your agent's default model for this project
// ---------------------------------------------------------------------------------------------

function ModelsCard({ projectId, settings }: { projectId: string; settings: MyProjectSettings }) {
  const update = useUpdateMyProjectSettings(projectId);
  const [draft, setDraft] = useState<Chain | null>(null);
  const chain = draft ?? settings.models.chain;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(settings.models.chain);
  const inherits = chain.length === 0;
  const switchId = useId();
  const submit = () =>
    update.mutate(
      { models: { chain } },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success('Saved your default model for this project');
        },
        onError: (cause) => toast.error(errorMessage(cause)),
      },
    );

  return (
    <SettingsCard
      title="Default model"
      description="Which harness and model your agent runs in this project, unless someone suggests a model your computers have (or you pick one when approving a request). When a harness is out of usage, the desktop app moves on to the next step."
      footer={
        <div className="flex w-full justify-end">
          <Button size="sm" onClick={submit} disabled={!dirty || update.isPending}>
            {update.isPending ? <Spinner /> : null}
            Save model
          </Button>
        </div>
      }
    >
      <div className="grid gap-3" data-testid="project-default-model">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={switchId} className="text-sm font-normal">
            Use my account default
          </Label>
          <Switch
            id={switchId}
            checked={inherits}
            onCheckedChange={(on) =>
              setDraft(
                on
                  ? []
                  : settings.defaults.models.chain.length > 0
                    ? settings.defaults.models.chain.map((entry) => ({ ...entry }))
                    : [{ harness: 'claude', model: '', effort: '' }],
              )
            }
          />
        </div>
        {inherits ? (
          <p className="text-sm text-muted-foreground">
            Your{' '}
            <Link to="/settings/automatic-agents" className="underline underline-offset-2">
              account default
            </Link>
            : {chainSummary(settings.defaults.models.chain) || 'Claude Code opus'}
          </p>
        ) : (
          <ChainEditor
            label="Default model for this project"
            value={chain}
            onChange={setDraft}
            emptyText="No model yet: add one, or use your account default."
          />
        )}
      </div>
    </SettingsCard>
  );
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
