import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  meResponseSchema,
  type MeProject,
  type MeResponse,
  type MeTeam,
  type UpdateMyTeamInput,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { useMe } from '@web/lib/auth';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Your own sidebar (BAT-36): the order of your teams and folded teams, (BAT#27) the order of each
 * team's projects, and your pinned projects, saved on the server so every browser and the desktop
 * app show the same. The mutations update the cached `me` at once and roll back if the server
 * refuses (the query client toasts the error).
 */

/** `ids` with `activeId` moved to `overId`'s place, or null when nothing moves. */
export function moveTeam(
  teams: readonly MeTeam[],
  activeId: string,
  overId: string,
): string[] | null {
  return moveId(
    teams.map((team) => team.id),
    activeId,
    overId,
  );
}

function moveId(ids: readonly string[], activeId: string, overId: string): string[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

function useOptimisticMe<TInput>(
  mutationFn: (input: TInput) => Promise<MeResponse>,
  apply: (me: MeResponse, input: TInput) => MeResponse,
) {
  const queryClient = useQueryClient();
  const key = queryKeys.me();
  return useMutation({
    mutationFn,
    onMutate: async (input: TInput) => {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const previous = queryClient.getQueryData<MeResponse>(key);
      if (previous) queryClient.setQueryData<MeResponse>(key, apply(previous, input));
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });
}

/** Saves your order of teams (every team once, top first). */
export function useReorderMyTeams() {
  return useOptimisticMe(
    (teamIds: string[]) =>
      api.put('/api/me/teams/order', { teamIds }, { schema: meResponseSchema }),
    (me, teamIds) => {
      const byId = new Map(me.teams.map((team) => [team.id, team]));
      const ordered = teamIds
        .map((id) => byId.get(id))
        .filter((team): team is MeTeam => team !== undefined);
      return { ...me, teams: ordered };
    },
  );
}

/** Folds or unfolds a team's projects in your sidebar. */
export function useUpdateMyTeam() {
  return useOptimisticMe(
    ({ teamId, ...input }: UpdateMyTeamInput & { teamId: string }) =>
      api.patch(`/api/me/teams/${encodeURIComponent(teamId)}`, input, {
        schema: meResponseSchema,
      }),
    (me, { teamId, collapsed }) => ({
      ...me,
      teams: me.teams.map((team) => (team.id === teamId ? { ...team, collapsed } : team)),
    }),
  );
}

/** `ids` with `activeId` moved to `overId`'s place (a team's projects), or null when nothing moves. */
export function moveProject(
  projects: readonly MeProject[],
  activeId: string,
  overId: string,
): string[] | null {
  return moveId(
    projects.map((project) => project.id),
    activeId,
    overId,
  );
}

/** Saves your order of one team's projects (BAT#27; projects only move within their team). */
export function useReorderMyProjects() {
  return useOptimisticMe(
    ({ teamId, projectIds }: { teamId: string; projectIds: string[] }) =>
      api.put(
        `/api/me/teams/${encodeURIComponent(teamId)}/projects/order`,
        { projectIds },
        { schema: meResponseSchema },
      ),
    (me, { teamId, projectIds }) => {
      const rank = new Map(projectIds.map((id, index) => [id, index]));
      const at = (project: MeProject) => rank.get(project.id) ?? Number.MAX_SAFE_INTEGER;
      return {
        ...me,
        teams: me.teams.map((team) =>
          team.id === teamId
            ? { ...team, projects: [...team.projects].sort((a, b) => at(a) - at(b)) }
            : team,
        ),
      };
    },
  );
}

/** A pinned project with its team: an entry of the sidebar's Pinned section. */
export interface PinnedProject {
  team: MeTeam;
  project: MeProject;
}

/** Your pinned projects, top first, with their teams (only the ones you can see). */
export function pinnedProjects(me: MeResponse | undefined): PinnedProject[] {
  if (!me) return [];
  const byId = new Map(
    me.teams.flatMap((team) => team.projects.map((project) => [project.id, { team, project }])),
  );
  return (me.pinnedProjectIds ?? [])
    .map((id) => byId.get(id))
    .filter((entry): entry is PinnedProject => entry !== undefined);
}

/** Pins (`pinned: true`) or unpins a project in your sidebar's Pinned section. */
export function usePinProject() {
  return useOptimisticMe(
    ({ projectId, pinned }: { projectId: string; pinned: boolean }) => {
      const url = `/api/me/projects/${encodeURIComponent(projectId)}/pin`;
      return pinned
        ? api.put(url, undefined, { schema: meResponseSchema })
        : api.delete(url, { schema: meResponseSchema });
    },
    (me, { projectId, pinned }) => {
      const ids = (me.pinnedProjectIds ?? []).filter((id) => id !== projectId);
      return { ...me, pinnedProjectIds: pinned ? [...ids, projectId] : ids };
    },
  );
}

/** `ids` of the Pinned section with `activeId` moved to `overId`'s place, or null. */
export function movePinned(ids: readonly string[], activeId: string, overId: string) {
  return moveId(ids, activeId, overId);
}

/** Saves the order of your Pinned section (pinned project ids, top first). */
export function useReorderPinnedProjects() {
  return useOptimisticMe(
    (projectIds: string[]) =>
      api.put('/api/me/pinned-projects/order', { projectIds }, { schema: meResponseSchema }),
    (me, projectIds) => ({ ...me, pinnedProjectIds: projectIds }),
  );
}

/** Pin or unpin a project, with a toast. */
export function useTogglePin() {
  const me = useMe().data;
  const pin = usePinProject();
  return {
    isPinned: (projectId: string) => (me?.pinnedProjectIds ?? []).includes(projectId),
    toggle: (project: Pick<MeProject, 'id' | 'name'>, pinned: boolean) =>
      pin.mutate(
        { projectId: project.id, pinned },
        {
          onSuccess: () =>
            toast.success(pinned ? `Pinned ${project.name}` : `Unpinned ${project.name}`),
        },
      ),
  };
}
