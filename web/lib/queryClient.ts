import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { errorMessage, isApiError, isAuthRoutingError } from './api';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** The caller shows the error itself (e.g. inline in a form). */
      suppressErrorToast?: boolean;
    };
  }
}

/** Client errors (4xx) won't succeed on retry; network failures and 5xx might. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * App-wide TanStack Query client. Live events (web/lib/live.ts) invalidate queries, so data can
 * stay fresh for a while without refetching on every mount. Failed mutations toast their error;
 * failed background refetches toast too (a failed first load is shown by the page instead).
 * Auth errors are never toasted: the API client is already redirecting.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isAuthRoutingError(error) || query.state.data === undefined) return;
        toast.error(errorMessage(error, 'Couldn’t refresh data.'), { id: 'query-refresh-error' });
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isAuthRoutingError(error) || mutation.meta?.suppressErrorToast) return;
        toast.error(errorMessage(error));
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: 0 },
    },
  });
}
