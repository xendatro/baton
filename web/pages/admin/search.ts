import { LIMITS } from '@shared/constants';
import { searchResponseSchema, type SearchResult } from '@shared/schemas/core';
import { api } from '@web/lib/api';

/** Results requested per query (the server's maximum), split into groups by the palette. */
const LIMIT = 50;

interface InFlight {
  query: string;
  signal: AbortSignal;
  promise: Promise<SearchResult[]>;
}

let latest: InFlight | null = null;

/**
 * `GET /api/search` for the palette. The palette calls every provider with the same query and
 * AbortSignal, so the Tasks, Issues and Replies providers share one request: a call with the
 * query and signal of the request in flight reuses it.
 */
export function searchAll(query: string, signal: AbortSignal): Promise<SearchResult[]> {
  if (latest && latest.query === query && latest.signal === signal) return latest.promise;
  const promise = api
    .get('/api/search', {
      query: { q: query.slice(0, LIMITS.searchQuery.max), limit: LIMIT },
      schema: searchResponseSchema,
      signal,
    })
    .then((response) => response.results);
  latest = { query, signal, promise };
  return promise;
}
