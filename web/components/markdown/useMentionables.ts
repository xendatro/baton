import { useQuery } from '@tanstack/react-query';
import { mentionablesResponseSchema, type MentionablesResponse } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

/** `GET /api/teams/:teamId/mentionables` (no query): resolves mention chips to names and colors. */
export function useMentionables(teamId: string | null | undefined) {
  return useQuery<MentionablesResponse>({
    queryKey: queryKeys.teams.mentionables(teamId ?? '', ''),
    queryFn: ({ signal }) =>
      api.get(`/api/teams/${encodeURIComponent(teamId ?? '')}/mentionables`, {
        schema: mentionablesResponseSchema,
        signal,
      }),
    enabled: Boolean(teamId),
    staleTime: 60_000,
  });
}
