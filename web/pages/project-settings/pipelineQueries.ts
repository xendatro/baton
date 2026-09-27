import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { copyPipelinePreviewSchema, type CopyPipelineInput } from '@shared/schemas/pipelines';
import { statusListResponseSchema } from '@shared/schemas/projects';
import type { PrincipalOptions } from '@web/components/pickers/principals';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import { useMembers, useRoles } from '../teams/api';
import { useProjectRoles } from './accessQueries';

/** Pipelines (design §5): who rules can name, and copying another project's pipeline. */

const enc = encodeURIComponent;

/** People, agents, team roles and project roles a rule of the project can name. */
export function usePrincipalOptions(teamId: string, projectId: string) {
  const members = useMembers(teamId);
  const roles = useRoles(teamId);
  const projectRoles = useProjectRoles(projectId);
  const options: PrincipalOptions = {
    users: members.data?.items.map((member) => member.user) ?? [],
    roles:
      roles.data?.items.map(({ id, name, color, isEveryone }) => ({
        id,
        name,
        color,
        isEveryone,
      })) ?? [],
    projectRoles: projectRoles.data?.map(({ id, name, color }) => ({ id, name, color })) ?? [],
  };
  return { options, isPending: members.isPending || roles.isPending };
}

/**
 * The stages of any project the viewer can see ("Create from existing" browsing another project),
 * sharing the project's statuses query; off while `projectId` is null.
 */
export function useSourceStages(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.projects.statuses(projectId ?? ''),
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId ?? '')}/statuses`, {
        schema: statusListResponseSchema,
        signal,
      }),
    select: (data) => data.items,
    enabled: Boolean(projectId),
  });
}

export function useCopyPipelinePreview(
  projectId: string,
  fromProjectId: string | null,
  pipelines: { fromPipelineId?: string | undefined; pipelineId?: string | undefined } = {},
) {
  return useQuery({
    queryKey: [
      ...queryKeys.projects.pipelineCopy(projectId, fromProjectId ?? ''),
      pipelines.fromPipelineId ?? null,
      pipelines.pipelineId ?? null,
    ],
    queryFn: ({ signal }) =>
      api.get(`/api/projects/${enc(projectId)}/pipeline/copy-preview`, {
        query: {
          from: fromProjectId ?? '',
          ...(pipelines.fromPipelineId ? { fromPipeline: pipelines.fromPipelineId } : {}),
          ...(pipelines.pipelineId ? { pipeline: pipelines.pipelineId } : {}),
        },
        schema: copyPipelinePreviewSchema,
        signal,
      }),
    enabled: Boolean(fromProjectId),
  });
}

export function useCopyPipeline(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CopyPipelineInput) =>
      api.post(`/api/projects/${enc(projectId)}/pipeline/copy`, input, {
        schema: statusListResponseSchema,
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.statuses(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.pipelines(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all(projectId) }),
      ]),
    meta: { suppressErrorToast: true },
  });
}
