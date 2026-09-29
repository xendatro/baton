import { FolderIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import type { Chain } from '@shared/schemas/agentRunner';
import type { MeProject, MeTeam } from '@shared/schemas/core';
import type { MyProjectSettings } from '@shared/schemas/projectSettings';
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
import { NotificationSettingsCard } from './NotificationSettingsCard';

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
            settings; notifications follow{' '}
            <Link to={`/t/${team.slug}/me`} className="underline underline-offset-2">
              your settings for {team.name}
            </Link>{' '}
            first.
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

function NotificationsCard({
  projectId,
  settings,
}: {
  projectId: string;
  settings: MyProjectSettings;
}) {
  const update = useUpdateMyProjectSettings(projectId);
  return (
    <NotificationSettingsCard
      scope="project"
      saved={{
        notifications: settings.notifications,
        agentNotifications: settings.agentNotifications,
      }}
      defaults={settings.defaults}
      inherited={settings.inherited}
      saving={update.isPending}
      onSave={(value, done) =>
        update.mutate(value, {
          onSuccess: () => {
            done();
            toast.success('Saved your notifications for this project');
          },
          onError: (cause) => toast.error(errorMessage(cause)),
        })
      }
    />
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
