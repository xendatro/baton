import { XIcon } from 'lucide-react';
import { useId } from 'react';
import type { NotificationCountsResponse } from '@shared/schemas/core';
import { Button } from '@web/components/ui/button';
import { useMe } from '@web/lib/auth';
import { cn } from '@web/lib/utils';
import type { InboxScope } from './queries';

interface Tally {
  total: number;
  unread: number;
}

/**
 * The inbox's Team and Project filters (BAT-34): only the viewer's teams and projects that have
 * notifications, each with its count (unread ones on the Unread tab). Shown once there is more
 * than one team or project to choose from, or while a filter is on.
 */
export function InboxFilters({
  counts,
  scope,
  onChange,
  unreadOnly,
}: {
  counts: NotificationCountsResponse | undefined;
  scope: InboxScope;
  onChange: (scope: InboxScope) => void;
  unreadOnly: boolean;
}) {
  const ids = useId();
  const teams = useMe().data?.teams ?? [];
  if (!counts) return null;
  const scoped = scope.teamId !== undefined || scope.projectId !== undefined;

  const teamOptions = teams.flatMap((team) => {
    const tally = counts.teams.find((row) => row.teamId === team.id);
    return tally ? [{ id: team.id, name: team.name, tally }] : [];
  });
  const projectOptions = teams
    .filter((team) => !scope.teamId || team.id === scope.teamId)
    .flatMap((team) =>
      team.projects.flatMap((project) => {
        const tally = counts.projects.find((row) => row.projectId === project.id);
        if (!tally) return [];
        const name =
          teamOptions.length > 1 && !scope.teamId ? `${team.name} / ${project.name}` : project.name;
        return [{ id: project.id, teamId: team.id, name, tally }];
      }),
    );
  if (!scoped && teamOptions.length <= 1 && projectOptions.length <= 1) return null;

  const count = (tally: Tally) => (unreadOnly ? tally.unread : tally.total);
  const allCount = (rows: readonly Tally[]) => rows.reduce((sum, row) => sum + count(row), 0);
  const selectClass =
    'h-8 min-w-0 max-w-[16rem] rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30';

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Filter notifications"
    >
      {teamOptions.length > 1 || scope.teamId ? (
        <>
          <label htmlFor={`${ids}-team`} className="text-xs font-medium text-muted-foreground">
            Team
          </label>
          <select
            id={`${ids}-team`}
            value={scope.teamId ?? ''}
            onChange={(event) => onChange(event.target.value ? { teamId: event.target.value } : {})}
            className={selectClass}
          >
            <option value="">All teams ({allCount(counts.teams)})</option>
            {teamOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({count(option.tally)})
              </option>
            ))}
          </select>
        </>
      ) : null}
      {projectOptions.length > 0 ? (
        <>
          <label
            htmlFor={`${ids}-project`}
            className={cn(
              'text-xs font-medium text-muted-foreground',
              (teamOptions.length > 1 || scope.teamId) && 'ml-1',
            )}
          >
            Project
          </label>
          <select
            id={`${ids}-project`}
            value={scope.projectId ?? ''}
            onChange={(event) => {
              const project = projectOptions.find((option) => option.id === event.target.value);
              onChange(
                project
                  ? { ...(scope.teamId ? { teamId: scope.teamId } : {}), projectId: project.id }
                  : scope.teamId
                    ? { teamId: scope.teamId }
                    : {},
              );
            }}
            className={selectClass}
          >
            <option value="">
              All projects ({allCount(projectOptions.map((option) => option.tally))})
            </option>
            {projectOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} ({count(option.tally)})
              </option>
            ))}
          </select>
        </>
      ) : null}
      {scoped ? (
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          <XIcon aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
