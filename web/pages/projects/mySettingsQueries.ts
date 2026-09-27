import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  myProjectSettingsSchema,
  type UpdateMyProjectSettingsInput,
} from '@shared/schemas/projectSettings';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** Your settings for one project (BAT-29): its notifications and your models there. */

const url = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/my-settings`;

export function useMyProjectSettings(projectId: string) {
  return useQuery({
    queryKey: queryKeys.account.projectSettings(projectId),
    queryFn: ({ signal }) => api.get(url(projectId), { schema: myProjectSettingsSchema, signal }),
  });
}

export function useUpdateMyProjectSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyProjectSettingsInput) =>
      api.put(url(projectId), input, { schema: myProjectSettingsSchema }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.account.projectSettings(projectId), data);
      // Automatic agents lists the projects with their own models.
      void queryClient.invalidateQueries({ queryKey: queryKeys.account.agentModels() });
    },
    meta: { suppressErrorToast: true },
  });
}
