import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { mentionablesResponseSchema } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import { toMentionItems, type MentionSource } from './mention';

/** `GET /api/teams/:teamId/mentionables?q` as the editor's mention source (cached 30 s per query). */
export function useMentionSource(teamId: string | null | undefined): MentionSource | null {
  const queryClient = useQueryClient();
  return useMemo(() => {
    if (!teamId) return null;
    return async (query) => {
      const q = query.trim().toLowerCase();
      const data = await queryClient.fetchQuery({
        queryKey: queryKeys.teams.mentionables(teamId, q),
        queryFn: ({ signal }) =>
          api.get(`/api/teams/${encodeURIComponent(teamId)}/mentionables`, {
            query: { q: q || undefined },
            schema: mentionablesResponseSchema,
            signal,
          }),
        staleTime: 30_000,
      });
      return toMentionItems(data.users, data.roles);
    };
  }, [queryClient, teamId]);
}
