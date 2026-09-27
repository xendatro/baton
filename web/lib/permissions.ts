import type { Permission } from '@shared/permissions';
import type { MeResponse } from '@shared/schemas/core';
import { useMe } from './auth';

/**
 * The viewer's permissions in a team, from `GET /api/me` (already effective: owners and
 * administrators get every permission). The server enforces permissions; the UI only uses these
 * to hide actions the viewer can't take.
 */
export interface TeamAccess {
  userId: string | null;
  isOwner: boolean;
  isMember: boolean;
  has: (permission: Permission) => boolean;
  /** Authors can always edit/delete their own content; others need the `…_ANY_CONTENT` permission. */
  canEdit: (authorId: string | null | undefined) => boolean;
  canDelete: (authorId: string | null | undefined) => boolean;
}

function accessFrom(
  userId: string | null,
  isOwner: boolean,
  isMember: boolean,
  list: readonly Permission[],
): TeamAccess {
  const permissions = new Set<Permission>(list);
  const has = (permission: Permission) => permissions.has(permission);
  const isAuthor = (authorId: string | null | undefined) =>
    userId !== null && authorId !== null && authorId !== undefined && authorId === userId;
  return {
    userId,
    isOwner,
    isMember,
    has,
    canEdit: (authorId) => isAuthor(authorId) || has('EDIT_ANY_CONTENT'),
    canDelete: (authorId) => isAuthor(authorId) || has('DELETE_ANY_CONTENT'),
  };
}

export function useTeamAccess(teamId: string | null | undefined): TeamAccess {
  const me = useMe().data;
  const team = teamId ? me?.teams.find((candidate) => candidate.id === teamId) : undefined;
  return accessFrom(
    me?.user.id ?? null,
    team?.isOwner ?? false,
    team !== undefined,
    team?.permissions ?? [],
  );
}

/** The viewer's effective permissions in a project (design §3), or null when unknown. */
export function projectPermissions(
  me: MeResponse | undefined,
  teamId: string | null | undefined,
  projectId: string | null | undefined,
): readonly Permission[] | null {
  const team = teamId ? me?.teams.find((candidate) => candidate.id === teamId) : undefined;
  if (!team) return null;
  const project = projectId ? team.projects.find((p) => p.id === projectId) : undefined;
  // Older servers (and projects not in `me`) fall back to the team's permissions.
  return project?.permissions ?? team.permissions;
}

/**
 * The viewer's permissions in a project: team-level ones from team roles plus the project-level
 * ones after the project's overrides (`me.teams[].projects[].permissions`). Use it for everything
 * inside a project (replies, tasks, issues, statuses, labels, reactions); without a project id it
 * is the team's access.
 */
export function useProjectAccess(
  teamId: string | null | undefined,
  projectId: string | null | undefined,
): TeamAccess {
  const me = useMe().data;
  const team = teamId ? me?.teams.find((candidate) => candidate.id === teamId) : undefined;
  return accessFrom(
    me?.user.id ?? null,
    team?.isOwner ?? false,
    team !== undefined,
    projectPermissions(me, teamId, projectId) ?? [],
  );
}

/**
 * May the viewer manage a project's roles and overrides? `MANAGE_PROJECT_ACCESS` there, or the
 * team's `MANAGE_PROJECTS` (the server's rule).
 */
export function useCanManageProjectAccess(
  teamId: string | null | undefined,
  projectId: string | null | undefined,
): boolean {
  const project = useProjectAccess(teamId, projectId);
  const team = useTeamAccess(teamId);
  return project.has('MANAGE_PROJECT_ACCESS') || team.has('MANAGE_PROJECTS');
}
