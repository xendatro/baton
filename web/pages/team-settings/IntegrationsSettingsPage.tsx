import { ExternalLinkIcon, PlugIcon, PlusIcon, UnplugIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import type { GithubInstallation } from '@shared/schemas/github';
import { ConfirmDialog } from '@web/components/common/ConfirmDialog';
import { EmptyState } from '@web/components/common/EmptyState';
import { ErrorState } from '@web/components/common/ErrorState';
import { GitHubIcon } from '@web/components/common/GitHubIcon';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { errorMessage } from '@web/lib/api';
import { useDocumentTitle } from '@web/lib/title';
import {
  useDisconnectGithub,
  useGithubStatus,
  useStartGithubInstall,
} from '@web/pages/projects/githubQueries';
import { useSettingsTeam } from './context';
import { SettingsCard, SettingsHeader } from './SettingsSection';

/**
 * Integrations: the GitHub accounts and organizations connected to the team, whose repositories
 * projects can show READMEs from. Connecting installs the Baton GitHub App on the repositories
 * you choose (`MANAGE_TEAM`); GitHub brings you back here (`?github=connected|denied|requested`).
 */

const OUTCOMES: Record<string, { ok: boolean; message: string }> = {
  connected: { ok: true, message: 'GitHub connected' },
  denied: {
    ok: false,
    message: 'GitHub says your account can’t access that installation, so it wasn’t connected',
  },
  requested: {
    ok: true,
    message: 'Install requested: an owner of the organization has to approve it on GitHub',
  },
};

export default function IntegrationsSettingsPage() {
  const team = useSettingsTeam();
  const canManage =
    team.permissions.includes('MANAGE_TEAM') || team.permissions.includes('ADMINISTRATOR');
  useDocumentTitle(['Integrations', team.name]);
  const status = useGithubStatus(team.id);
  const start = useStartGithubInstall(team.id);
  const [removing, setRemoving] = useState<GithubInstallation | null>(null);
  const disconnect = useDisconnectGithub(team.id);
  const [params, setParams] = useSearchParams();
  const outcome = params.get('github');

  useEffect(() => {
    const result = outcome ? OUTCOMES[outcome] : undefined;
    if (!result) return;
    if (result.ok) toast.success(result.message);
    else toast.error(result.message);
    setParams(
      (current) => {
        current.delete('github');
        return current;
      },
      { replace: true },
    );
  }, [outcome, setParams]);

  const connect = () =>
    start.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (cause) => toast.error(errorMessage(cause)),
    });

  const connectButton = canManage ? (
    <Button size="sm" onClick={connect} disabled={start.isPending}>
      {start.isPending ? <Spinner /> : <PlusIcon aria-hidden="true" />}
      Connect GitHub
    </Button>
  ) : null;

  return (
    <div>
      <SettingsHeader
        title="Integrations"
        description="Connect GitHub so projects can show their README from a repository: one Markdown file, or a whole folder of them."
        actions={status.data?.enabled ? connectButton : null}
      />
      {status.isPending ? (
        <Skeleton className="h-28 rounded-lg" />
      ) : status.isError ? (
        <ErrorState
          title="Couldn’t load integrations"
          error={status.error}
          onRetry={() => void status.refetch()}
        />
      ) : !status.data.enabled ? (
        <EmptyState
          icon={PlugIcon}
          title="GitHub isn’t set up on this server"
          description="Whoever runs this Baton server has to register a GitHub App first (see docs/DEPLOY.md)."
        />
      ) : status.data.installations.length === 0 ? (
        <EmptyState
          icon={PlugIcon}
          title="No GitHub accounts connected"
          description={
            canManage
              ? 'Install the Baton app on the repositories you want projects to read. Private repositories work too.'
              : 'Ask someone who can manage the team to connect GitHub.'
          }
          action={connectButton ?? undefined}
        />
      ) : (
        <SettingsCard>
          <ul aria-label="Connected GitHub accounts">
            {status.data.installations.map((installation) => (
              <li
                key={installation.id}
                className="flex flex-col gap-3 border-b p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <GitHubIcon />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{installation.accountLogin}</p>
                    <p className="text-xs text-muted-foreground">
                      {installation.accountType === 'Organization' ? 'Organization' : 'Account'}
                      {installation.createdBy
                        ? ` · connected by @${installation.createdBy.username}`
                        : ''}{' '}
                      · <RelativeTime value={installation.createdAt} />
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button asChild variant="ghost" size="sm">
                    <a href={installation.settingsUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLinkIcon aria-hidden="true" />
                      Choose repositories
                    </a>
                  </Button>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setRemoving(installation)}
                    >
                      <UnplugIcon aria-hidden="true" />
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Disconnect ${removing?.accountLogin ?? 'GitHub'}?`}
        description="Projects showing a README from its repositories go back to their own README. The app stays installed on GitHub until you uninstall it there."
        confirmLabel="Disconnect"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await disconnect.mutateAsync(removing.id);
          toast.success(`Disconnected ${removing.accountLogin}`);
          setRemoving(null);
        }}
      />
    </div>
  );
}
