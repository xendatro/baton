import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { Theme } from '@shared/constants';
import {
  agentSettingsSchema,
  connectionsResponseSchema,
  passwordResponseSchema,
  profileResponseSchema,
  revokeSessionsResponseSchema,
  sessionListResponseSchema,
  type ChangePasswordInput,
  type DeleteAccountInput,
  type AgentSettings,
  type ProfileResponse,
  type SetPasswordInput,
  type SocialProvider,
  type UpdateAgentSettingsInput,
  type UpdateProfileInput,
} from '@shared/schemas/account';
import { okResponseSchema } from '@shared/schemas/common';
import {
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
  securityLogResponseSchema,
  type ApiKeyListResponse,
  type CreateApiKeyInput,
  type MeResponse,
} from '@shared/schemas/core';
import {
  deletedTeamsResponseSchema,
  teamDetailSchema,
  type DeletedTeamsResponse,
} from '@shared/schemas/teams';
import { api, uploadFile } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/**
 * Data hooks of the account settings pages (docs/API.md → Account). Every key comes from
 * `queryKeys.account` / `queryKeys.apiKeys`, which live events refresh (web/lib/live.ts).
 */

/** Writes a new profile into the cached `GET /api/me`, so the shell updates at once. */
export function setCachedProfile(queryClient: QueryClient, profile: ProfileResponse): void {
  queryClient.setQueryData<MeResponse>(queryKeys.me(), (me) =>
    me ? { ...me, user: profile } : me,
  );
}

// ---------------------------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------------------------

export function updateProfileRequest(input: UpdateProfileInput): Promise<ProfileResponse> {
  return api.patch('/api/me', input, { schema: profileResponseSchema });
}

export function useUpdateProfile(options: { suppressErrorToast?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProfileRequest,
    meta: { suppressErrorToast: options.suppressErrorToast ?? false },
    onSuccess: (profile) => setCachedProfile(queryClient, profile),
  });
}

/** Saves a theme to the profile (the theme persister; errors are not the user's concern here). */
export function saveThemeRequest(theme: Theme): Promise<ProfileResponse> {
  return updateProfileRequest({ theme });
}

/** Saves the theme chosen on the appearance page (applied locally by the caller). */
export function useSaveTheme() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveThemeRequest,
    onSuccess: (profile) => setCachedProfile(queryClient, profile),
  });
}

export function useUploadAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: File; onProgress?: (fraction: number) => void }) =>
      uploadFile('/api/me/avatar', input.file, {
        schema: profileResponseSchema,
        onProgress: input.onProgress,
      }),
    onSuccess: (profile) => setCachedProfile(queryClient, profile),
  });
}

export function useRemoveAvatar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete('/api/me/avatar', { schema: profileResponseSchema }),
    onSuccess: (profile) => setCachedProfile(queryClient, profile),
  });
}

// ---------------------------------------------------------------------------------------------
// Password, sign-in methods, deletion
// ---------------------------------------------------------------------------------------------

export function useConnections() {
  return useQuery({
    queryKey: queryKeys.account.connections(),
    queryFn: ({ signal }) =>
      api.get('/api/me/connections', { schema: connectionsResponseSchema, signal }),
    staleTime: 5 * 60_000,
  });
}

export function useDisconnectAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: SocialProvider) =>
      api.delete(`/api/me/connections/${provider}`, { schema: okResponseSchema }),
    // Shown by the confirm dialog.
    meta: { suppressErrorToast: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.account.all() }),
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordInput) =>
      api.post('/api/me/password', input, { schema: passwordResponseSchema }),
    meta: { suppressErrorToast: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.account.sessions() }),
  });
}

export function useSetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetPasswordInput) =>
      api.post('/api/me/password/set', input, { schema: passwordResponseSchema }),
    meta: { suppressErrorToast: true },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.account.connections() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.account.sessions() }),
      ]);
    },
  });
}

export function deleteAccountRequest(input: DeleteAccountInput) {
  return api.post('/api/me/delete', input, { schema: okResponseSchema });
}

// ---------------------------------------------------------------------------------------------
// Deleted teams (teams module contract)
// ---------------------------------------------------------------------------------------------

export function useDeletedTeams() {
  return useQuery({
    queryKey: queryKeys.account.deletedTeams(),
    queryFn: ({ signal }) =>
      api.get('/api/me/deleted-teams', { schema: deletedTeamsResponseSchema, signal }),
  });
}

export function useRestoreTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) =>
      api.post(`/api/teams/${encodeURIComponent(teamId)}/restore`, undefined, {
        schema: teamDetailSchema,
      }),
    onMutate: async (teamId) => {
      const key = queryKeys.account.deletedTeams();
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DeletedTeamsResponse>(key);
      queryClient.setQueryData<DeletedTeamsResponse>(key, (data) =>
        data ? { items: data.items.filter((team) => team.id !== teamId) } : data,
      );
      return { previous };
    },
    onError: (_error, _teamId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.account.deletedTeams(), context.previous);
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.account.deletedTeams() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.teams.all() }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Sessions and the security log
// ---------------------------------------------------------------------------------------------

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.account.sessions(),
    queryFn: ({ signal }) =>
      api.get('/api/me/sessions', { schema: sessionListResponseSchema, signal }),
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete(`/api/me/sessions/${encodeURIComponent(sessionId)}`, {
        schema: okResponseSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.account.all() }),
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post('/api/me/sessions/revoke-others', undefined, {
        schema: revokeSessionsResponseSchema,
      }),
    // Shown by the confirm dialog.
    meta: { suppressErrorToast: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.account.all() }),
  });
}

const SECURITY_LOG_PAGE = 25;

export function useSecurityLog() {
  return useInfiniteQuery({
    queryKey: queryKeys.account.securityLog(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/me/security-log', {
        schema: securityLogResponseSchema,
        signal,
        query: { limit: SECURITY_LOG_PAGE, cursor: pageParam },
      }),
    getNextPageParam: (page) => page.nextCursor,
  });
}

// ---------------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------------

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys(),
    queryFn: ({ signal }) =>
      api.get('/api/me/api-keys', { schema: apiKeyListResponseSchema, signal }),
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      api.post('/api/me/api-keys', input, { schema: createApiKeyResponseSchema }),
    meta: { suppressErrorToast: true },
    onSuccess: (created) => {
      queryClient.setQueryData<ApiKeyListResponse>(queryKeys.apiKeys(), (data) =>
        data ? { apiKeys: [created.apiKey, ...data.apiKeys] } : data,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() });
    },
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/me/api-keys/${encodeURIComponent(id)}`, { schema: okResponseSchema }),
    // Shown by the confirm dialog.
    meta: { suppressErrorToast: true },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.apiKeys() });
      const previous = queryClient.getQueryData<ApiKeyListResponse>(queryKeys.apiKeys());
      const revokedAt = new Date().toISOString();
      queryClient.setQueryData<ApiKeyListResponse>(queryKeys.apiKeys(), (data) =>
        data
          ? { apiKeys: data.apiKeys.map((key) => (key.id === id ? { ...key, revokedAt } : key)) }
          : data,
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.apiKeys(), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys() }),
  });
}

// ---------------------------------------------------------------------------------------------
// Your agent member (docs/design/agents-and-pipelines.md §1)
// ---------------------------------------------------------------------------------------------

export function useAgentSettings() {
  return useQuery({
    queryKey: queryKeys.account.agent(),
    queryFn: ({ signal }) => api.get('/api/me/agent', { schema: agentSettingsSchema, signal }),
  });
}

/** Pauses/resumes your agent or changes its notifications; shown at once, undone on errors. */
export function useUpdateAgentSettings() {
  const queryClient = useQueryClient();
  const key = queryKeys.account.agent();
  return useMutation({
    mutationFn: (input: UpdateAgentSettingsInput) =>
      api.patch('/api/me/agent', input, { schema: agentSettingsSchema }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AgentSettings>(key);
      queryClient.setQueryData<AgentSettings>(key, (data) =>
        data
          ? {
              ...data,
              pausedAt:
                input.paused === undefined
                  ? data.pausedAt
                  : input.paused
                    ? (data.pausedAt ?? new Date().toISOString())
                    : null,
              notifications: input.notifications ?? data.notifications,
            }
          : data,
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(key, settings);
      void queryClient.invalidateQueries({ queryKey: queryKeys.account.securityLog() });
    },
  });
}
