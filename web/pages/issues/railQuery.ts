import { useInfiniteQuery } from '@tanstack/react-query';
import { issueListResponseSchema } from '@shared/schemas/issues';
import { api } from '@web/lib/api';
import { queryKeys } from '@web/lib/queryKeys';

const enc = encodeURIComponent;

/** Rows per page of the rail. */
export const RAIL_PAGE_SIZE = 50;

/** The project's open issues by latest activity, with their newest reply (BAT-44). */
export function useIssueRail(projectId: string, q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.issues.list(projectId, { view: 'rail', q }),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/projects/${enc(projectId)}/issues`, {
        query: {
          state: 'open',
          sort: 'latest-activity',
          latestReply: 'true',
          q: q || undefined,
          limit: RAIL_PAGE_SIZE,
          cursor: pageParam,
        },
        schema: issueListResponseSchema,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
}
