import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import { auditLogFacetsSchema } from '@shared/schemas/admin';
import {
  auditLogResponseSchema,
  type ActivityEntry,
  type AuditLogResponse,
} from '@shared/schemas/core';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';
import { toApiQuery, type AuditFilters } from './filters';
import { markFresh } from './freshRows';

/**
 * Data of the audit log page. The loaded rows live in an infinite query (`auditLogFeed`) that
 * live events leave alone; a small `auditLog` query for rows newer than the newest loaded one is
 * refetched on every `activity.created` event (web/lib/live.ts), and its rows are prepended.
 */

const PAGE_SIZE = 50;
/** Most new rows fetched at once; beyond that the page reloads the list instead. */
const NEW_LIMIT = 100;

type Feed = InfiniteData<AuditLogResponse, string | undefined>;

export function useAuditLogFacets(teamId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.teams.auditLogFacets(teamId),
    queryFn: ({ signal }) =>
      api.get(`/api/teams/${encodeURIComponent(teamId)}/audit-log/facets`, {
        schema: auditLogFacetsSchema,
        signal,
      }),
    enabled,
    staleTime: 60_000,
  });
}

function feedKey(teamId: string, filters: AuditFilters) {
  return queryKeys.teams.auditLogFeed(teamId, { ...filters });
}

export function useAuditLogFeed(teamId: string, filters: AuditFilters, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: feedKey(teamId, filters),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/teams/${encodeURIComponent(teamId)}/audit-log`, {
        query: { ...toApiQuery(filters), limit: PAGE_SIZE, cursor: pageParam },
        schema: auditLogResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // New rows arrive through useNewAuditEntries; never refetch every loaded page on focus.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export interface NewEntries {
  entries: ActivityEntry[];
  /** More rows arrived than were fetched: reload the list instead of prepending. */
  overflow: boolean;
}

/**
 * Rows matching the filters that are newer than `newest` (or any rows, while the list is
 * empty). Refetched by live `activity.created` events through the `auditLog` key prefix.
 */
export function useNewAuditEntries(
  teamId: string,
  filters: AuditFilters,
  loaded: readonly ActivityEntry[] | undefined,
) {
  const newest = loaded?.[0];
  const since = newest?.createdAt ?? null;
  return useQuery({
    queryKey: queryKeys.teams.auditLog(teamId, { ...filters, since }),
    queryFn: ({ signal }) => {
      const query = toApiQuery(filters);
      return api.get(`/api/teams/${encodeURIComponent(teamId)}/audit-log`, {
        query: { ...query, ...(since ? { from: since } : {}), limit: NEW_LIMIT },
        schema: auditLogResponseSchema,
        signal,
      });
    },
    enabled: loaded !== undefined,
    select: (page): NewEntries => {
      // `from` is inclusive: rows at the newest loaded instant may already be on the page.
      const known = new Set(loaded?.filter((entry) => entry.createdAt === since).map((e) => e.id));
      return {
        entries: page.items.filter((entry) => !known.has(entry.id)),
        overflow: page.nextCursor !== null,
      };
    },
  });
}

/**
 * Puts new rows at the top of the loaded list (highlighted for a moment), or reloads it when
 * there were too many.
 */
export function usePrependEntries(teamId: string, filters: AuditFilters) {
  const queryClient = useQueryClient();
  return useCallback(
    (update: NewEntries) => {
      const key = feedKey(teamId, filters);
      if (update.overflow) {
        void queryClient.resetQueries({ queryKey: key, exact: true });
        return;
      }
      if (update.entries.length === 0) return;
      queryClient.setQueryData<Feed>(key, (feed) => {
        const [first, ...rest] = feed?.pages ?? [];
        if (!feed || !first) return feed;
        const ids = new Set(first.items.map((entry) => entry.id));
        const fresh = update.entries.filter((entry) => !ids.has(entry.id));
        markFresh(fresh.map((entry) => entry.id));
        return { ...feed, pages: [{ ...first, items: [...fresh, ...first.items] }, ...rest] };
      });
    },
    [queryClient, teamId, filters],
  );
}
