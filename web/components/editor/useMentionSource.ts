import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { mentionablesResponseSchema } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import {
  toAgentMentionItems,
  toMentionItems,
  type MentionAgent,
  type MentionSource,
} from './mention';

/**
 * `GET /api/teams/:teamId/mentionables?q` as the editor's mention source (cached 30 s per query),
 * with the thread's `agents` (BAT-12) listed above the team's people. The agents are read when
 * the list opens, so a thread's agents arriving later don't rebuild the editor.
 */
export function useMentionSource(
  teamId: string | null | undefined,
  agents?: readonly MentionAgent[],
): MentionSource | null {
  const queryClient = useQueryClient();
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  });
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
      return [
        ...toAgentMentionItems(agentsRef.current ?? [], q),
        ...toMentionItems(data.users, data.roles),
      ];
    };
  }, [queryClient, teamId]);
}
