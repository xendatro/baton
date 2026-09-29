import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  meResponseSchema,
  type MeProject,
  type MeResponse,
  type MeTeam,
  type UpdateMyTeamInput,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Your own sidebar (BAT-36): the order of your teams, pins and folded teams, and (BAT#27) the order
 * of each team's projects, saved on the server so every browser and the desktop app show the same.
 * The mutations update the cached `me` at once and roll back if the server refuses (the query
 * client toasts the error).
 */

/** Pinned teams first, keeping the given order within each group (what the server sends). */
export function pinnedFirst(teams: readonly MeTeam[]): MeTeam[] {
  return [...teams.filter((team) => team.pinned), ...teams.filter((team) => !team.pinned)];
}

/**
 * `ids` with `activeId` moved to `overId`'s place, or null when nothing moves. Only within one
 * group: a pinned team can't be dragged among the unpinned ones (pin or unpin it instead).
 */
export function moveTeam(
  teams: readonly MeTeam[],
  activeId: string,
  overId: string,
): string[] | null {
  const ids = teams.map((team) => team.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  if (Boolean(teams[from]?.pinned) !== Boolean(teams[to]?.pinned)) return null;
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
      return { ...me, teams: pinnedFirst(ordered) };
    },
  );
}

/** Pins a team to the top of your sidebar, or folds its projects. */
export function useUpdateMyTeam() {
  return useOptimisticMe(
    ({ teamId, ...input }: UpdateMyTeamInput & { teamId: string }) =>
      api.patch(`/api/me/teams/${teamId}`, input, { schema: meResponseSchema }),
    (me, { teamId, pinned, collapsed }) =>
      ({
        ...me,
        teams: pinnedFirst(
          me.teams.map((team) =>
            team.id === teamId
              ? {
                  ...team,
                  ...(pinned !== undefined ? { pinned } : {}),
                  ...(collapsed !== undefined ? { collapsed } : {}),
                }
              : team,
          ),
        ),
      }) satisfies MeResponse,
  );
}

/** `ids` with `activeId` moved to `overId`'s place (a team's projects), or null when nothing moves. */
export function moveProject(
  projects: readonly MeProject[],
  activeId: string,
  overId: string,
): string[] | null {
  const ids = projects.map((project) => project.id);
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
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
