import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { LIMITS } from '@shared/constants';
import { mentionablesResponseSchema, type MentionablesResponse } from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { EVERYONE_SLUG, findMentions } from '@web/lib/mentions';
import { queryKeys } from '@web/lib/queryKeys';

/** Usernames and role slugs mentioned in `markdown`, sorted and deduplicated. */
export function mentionedNames(markdown: string): { usernames: string[]; roles: string[] } {
  const usernames = new Set<string>();
  const roles = new Set<string>();
  for (const mention of findMentions(markdown)) {
    if (mention.kind === 'user') usernames.add(mention.id);
    else if (mention.id !== EVERYONE_SLUG) roles.add(mention.id);
  }
  const list = (names: Set<string>) => [...names].sort().slice(0, LIMITS.bulkIds);
  return { usernames: list(usernames), roles: list(roles) };
}

/**
 * Resolves the mentions in `markdown` to members and roles of the team
 * (`GET /api/teams/:teamId/mentionables?usernames&roles`), for chip names, hover cards and role
 * colors. Only the names in the body are looked up, so teams of any size resolve fully.
 */
export function useMentionables(teamId: string | null | undefined, markdown: string) {
  const { usernames, roles } = useMemo(() => mentionedNames(markdown), [markdown]);
  const names = `${usernames.join(',')}|${roles.join(',')}`;
  return useQuery<MentionablesResponse>({
    queryKey: queryKeys.teams.mentionLookup(teamId ?? '', names),
    queryFn: ({ signal }) =>
      api.get(`/api/teams/${encodeURIComponent(teamId ?? '')}/mentionables`, {
        query: { usernames: usernames.join(','), roles: roles.join(',') },
        schema: mentionablesResponseSchema,
        signal,
      }),
    enabled: Boolean(teamId) && (usernames.length > 0 || roles.length > 0),
    staleTime: 60_000,
  });
}
