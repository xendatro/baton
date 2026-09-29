import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  myTeamSettingsSchema,
  type UpdateMyTeamSettingsInput,
} from '@shared/schemas/projectSettings';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Your settings for one team (BAT-34): its notifications, under each project's own. */

const url = (teamId: string) => `/api/teams/${encodeURIComponent(teamId)}/my-settings`;

export function useMyTeamSettings(teamId: string) {
  return useQuery({
    queryKey: queryKeys.account.teamSettings(teamId),
    queryFn: ({ signal }) => api.get(url(teamId), { schema: myTeamSettingsSchema, signal }),
  });
}

export function useUpdateMyTeamSettings(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyTeamSettingsInput) =>
      api.put(url(teamId), input, { schema: myTeamSettingsSchema }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.account.teamSettings(teamId), data);
      // A project's "Use my defaults" follows the team's settings.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.account.all(),
        predicate: (query) => query.queryKey[1] === 'project-settings',
      });
    },
    meta: { suppressErrorToast: true },
  });
}
