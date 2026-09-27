import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  githubContentsSchema,
  githubInstallUrlSchema,
  githubReadmeSchema,
  githubReposSchema,
  githubStatusSchema,
  readmeSourceSchema,
  type ReadmeSource,
} from '@shared/schemas/github';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** GitHub on the web: a team's connections, the README source picker and a GitHub README. */

const enc = encodeURIComponent;

export function useGithubStatus(teamId: string) {
  return useQuery({
    queryKey: queryKeys.teams.github(teamId),
    queryFn: () => api.get(`/api/teams/${enc(teamId)}/github`, { schema: githubStatusSchema }),
  });
}

export function useStartGithubInstall(teamId: string) {
  return useMutation({
    mutationFn: () =>
      api.post(`/api/teams/${enc(teamId)}/github/install`, undefined, {
        schema: githubInstallUrlSchema,
      }),
  });
}

export function useDisconnectGithub(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (installationId: string) =>
      api.delete(`/api/teams/${enc(teamId)}/github/${enc(installationId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teams.github(teamId) }),
  });
}

export function useGithubRepos(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.teams.githubRepos(teamId),
    queryFn: () => api.get(`/api/teams/${enc(teamId)}/github/repos`, { schema: githubReposSchema }),
    enabled,
    staleTime: 60_000,
  });
}

export function useGithubContents(
  teamId: string,
  target: { installationId: string; repo: string; path: string } | null,
) {
  return useQuery({
    queryKey: queryKeys.teams.githubContents(
      teamId,
      target?.installationId ?? '',
      target?.repo ?? '',
      target?.path ?? '',
    ),
    queryFn: () =>
      api.get(
        `/api/teams/${enc(teamId)}/github/${enc(target?.installationId ?? '')}/contents?${new URLSearchParams(
          { repo: target?.repo ?? '', path: target?.path ?? '' },
        ).toString()}`,
        { schema: githubContentsSchema },
      ),
    enabled: target !== null,
    staleTime: 60_000,
  });
}

export function useGithubReadme(projectId: string, path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projects.githubReadme(projectId, path),
    // Switching pages keeps the tree and the current page until the next one arrives.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api.get(`/api/projects/${enc(projectId)}/readme/github${path ? `?path=${enc(path)}` : ''}`, {
        schema: githubReadmeSchema,
      }),
    enabled,
    staleTime: 60_000,
  });
}

export function useSetReadmeSource(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (readmeSource: ReadmeSource | null) =>
      api.put(
        `/api/projects/${enc(projectId)}/readme-source`,
        { readmeSource },
        { schema: z.object({ readmeSource: readmeSourceSchema.nullable() }) },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) }),
    meta: { suppressErrorToast: true },
  });
}

/** Same-origin URL of an image of the project's GitHub README. */
export function githubImageUrl(projectId: string, path: string): string {
  return `/api/projects/${enc(projectId)}/readme/github/image?path=${enc(path)}`;
}
