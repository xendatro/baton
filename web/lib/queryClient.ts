import { QueryClient } from '@tanstack/react-query';

/**
 * App-wide TanStack Query client. Live events (web/lib/live.ts) invalidate queries, so data can
 * stay fresh for a while without refetching on every mount.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: 0 },
    },
  });
}
