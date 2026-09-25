import { monotonicFactory } from 'ulidx';

const ulid = monotonicFactory();

/**
 * New entity id: a ULID (26 chars, Crockford base32). Monotonic within a process, so ids created
 * in the same millisecond still sort in creation order (cursor pagination relies on this).
 */
export function newId(): string {
  return ulid();
}
