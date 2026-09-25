import { differenceInCalendarDays, parseISO } from 'date-fns';
import { ArchiveRestoreIcon, UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { DeletedTeam } from '@shared/schemas/teams';
import { EntityIcon } from '@web/components/common/EntityIcon';
import { ErrorState } from '@web/components/common/ErrorState';
import { RelativeTime } from '@web/components/common/RelativeTime';
import { Spinner } from '@web/components/common/Spinner';
import { Button } from '@web/components/ui/button';
import { Skeleton } from '@web/components/ui/skeleton';
import { pluralize } from '@web/lib/format';
import { useDeletedTeams, useRestoreTeam } from './queries';
import { SettingsCard } from './SettingsCard';

function daysLeft(team: DeletedTeam): number {
  return Math.max(0, differenceInCalendarDays(parseISO(team.purgeAt), new Date()));
}

function DeletedTeamRow({ team }: { team: DeletedTeam }) {
  const restore = useRestoreTeam();
  const left = daysLeft(team);
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
        <EntityIcon
          icon={team.icon}
          name={team.name}
          color={team.color}
          className="size-5 text-base"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{team.name}</p>
        <p className="text-xs text-muted-foreground">
          /{team.slug} · deleted <RelativeTime value={team.deletedAt} /> ·{' '}
          <span className={left <= 3 ? 'font-medium text-destructive' : undefined}>
            {left === 0 ? 'purged today' : `purged in ${pluralize(left, 'day')}`}
          </span>
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restore.isPending}
        onClick={() =>
          restore.mutate(team.id, { onSuccess: () => toast.success(`${team.name} restored`) })
        }
      >
        {restore.isPending ? <Spinner /> : <ArchiveRestoreIcon aria-hidden="true" />}
        Restore
      </Button>
    </li>
  );
}

/** Teams the user owns that are in Trash, restorable for 30 days (teams module contract). */
export function DeletedTeamsCard() {
  const deleted = useDeletedTeams();
  return (
    <SettingsCard
      title="Deleted teams"
      description="Teams you own stay in Trash for 30 days after deletion. Restore one to bring back its projects, issues and tasks."
    >
      {deleted.isPending ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : deleted.isError ? (
        <ErrorState
          title="Couldn’t load deleted teams"
          error={deleted.error}
          onRetry={() => void deleted.refetch()}
        />
      ) : deleted.data.items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
          <UsersIcon className="size-4 shrink-0" aria-hidden="true" />
          No deleted teams. Teams you delete appear here until they are purged.
        </div>
      ) : (
        <ul className="divide-y">
          {deleted.data.items.map((team) => (
            <DeletedTeamRow key={team.id} team={team} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
