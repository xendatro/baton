import { useState } from 'react';
import type { MeTeam } from '@shared/schemas/core';
import { useMe } from '@web/lib/auth';
import type { InboxScope } from './queries';

/**
 * The inbox's team and project filters (BAT-34), remembered per person in this browser. A
 * remembered team or project the viewer no longer belongs to (or can't see) is dropped.
 */

function storageKey(userId: string) {
  return `baton.inbox.scope.${userId}`;
}

function readStored(userId: string): InboxScope {
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return {};
    const { teamId, projectId } = value as Record<string, unknown>;
    return {
      ...(typeof teamId === 'string' ? { teamId } : {}),
      ...(typeof projectId === 'string' ? { projectId } : {}),
    };
  } catch {
    return {};
  }
}

function store(userId: string, scope: InboxScope): void {
  try {
    if (!scope.teamId && !scope.projectId) window.localStorage.removeItem(storageKey(userId));
    else window.localStorage.setItem(storageKey(userId), JSON.stringify(scope));
  } catch {
    // Storage unavailable: the filter just isn't remembered.
  }
}

/** The scope, keeping only a team and project the viewer still has (a project within the team). */
function validScope(scope: InboxScope, teams: readonly MeTeam[]): InboxScope {
  const project = scope.projectId
    ? teams.flatMap((team) => team.projects).find((item) => item.id === scope.projectId)
    : undefined;
  const projectTeam = project
    ? teams.find((team) => team.projects.some((item) => item.id === project.id))
    : undefined;
  const team = scope.teamId ? teams.find((item) => item.id === scope.teamId) : undefined;
  if (team && projectTeam && projectTeam.id !== team.id) return { teamId: team.id };
  return {
    ...(team ? { teamId: team.id } : {}),
    ...(project ? { projectId: project.id } : {}),
  };
}

export function useInboxScope(): [InboxScope, (scope: InboxScope) => void] {
  const me = useMe().data;
  const userId = me?.user.id ?? null;
  const [chosen, setChosen] = useState<InboxScope | null>(null);
  const scope = me ? validScope(chosen ?? (userId ? readStored(userId) : {}), me.teams) : {};
  const setScope = (next: InboxScope) => {
    setChosen(next);
    if (userId) store(userId, next);
  };
  return [scope, setScope];
}

/** "Acme", "Web app" (a project), for empty states. */
export function scopeLabel(scope: InboxScope, teams: readonly MeTeam[]): string {
  if (scope.projectId) {
    const project = teams
      .flatMap((team) => team.projects)
      .find((item) => item.id === scope.projectId);
    if (project) return project.name;
  }
  return teams.find((team) => team.id === scope.teamId)?.name ?? 'this filter';
}
