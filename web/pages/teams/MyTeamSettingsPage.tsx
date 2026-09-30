import { toast } from 'sonner';
import type { MeTeam } from '@shared/schemas/core';
import { ErrorState } from '@web/components/common/ErrorState';
import { NotFound } from '@web/components/common/NotFound';
import { PageContainer } from '@web/components/common/PageContainer';
import { errorMessage } from '@web/lib/api';
import { useRouteContext } from '@web/lib/routeContext';
import { useDocumentTitle } from '@web/lib/title';
import { NotificationSettingsCard } from '../projects/NotificationSettingsCard';
import { SettingsCardSkeleton } from '../settings/SettingsCard';
import { useMyTeamSettings, useUpdateMyTeamSettings } from './myTeamSettingsQueries';

/**
 * `/t/:team/me`: your settings for this team (BAT-34), like a Discord server's notification
 * settings. The notifications of all its projects, "Use my defaults" (the account's) until you
 * override them; a project's own settings (its Your settings page) still win. Personal.
 */
export default function MyTeamSettingsPage() {
  const { team, isLoading } = useRouteContext();
  if (isLoading) return <SettingsCardSkeleton rows={4} />;
  if (!team) return <NotFound what="Team" />;
  return <MyTeamSettings team={team} />;
}

function MyTeamSettings({ team }: { team: MeTeam }) {
  useDocumentTitle(['Your settings', team.name]);
  const settings = useMyTeamSettings(team.id);
  const update = useUpdateMyTeamSettings(team.id);
  return (
    <PageContainer width="narrow">
      <div className="grid gap-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Your settings for {team.name}</h1>
          <p className="text-sm text-muted-foreground">
            Only you see these. They apply to every project of the team, except projects with their
            own settings (a project’s Your settings page).
          </p>
        </header>
        {settings.isPending ? (
          <SettingsCardSkeleton rows={4} />
        ) : settings.isError ? (
          <ErrorState
            title="Couldn’t load your settings"
            error={settings.error}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <NotificationSettingsCard
            scope="team"
            saved={{
              notifications: settings.data.notifications,
              agentNotifications: settings.data.agentNotifications,
            }}
            defaults={settings.data.defaults}
            saving={update.isPending}
            onSave={(value, done) =>
              update.mutate(value, {
                onSuccess: () => {
                  done();
                  toast.success(`Saved your notifications for ${team.name}`);
                },
                onError: (cause) => toast.error(errorMessage(cause)),
              })
            }
          />
        )}
      </div>
    </PageContainer>
  );
}
