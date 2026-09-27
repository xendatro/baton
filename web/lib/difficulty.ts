/**
 * Difficulty levels are stored and sent easiest first (`position` 0 = easiest), but every list of
 * them in the UI shows the hardest at the top (BAT-30). Use these helpers wherever levels are
 * listed together, so the order is the same everywhere.
 */

/** The levels hardest first, from the API's easiest-first order (a new array). */
export function hardestFirst<T>(levels: readonly T[]): T[] {
  return [...levels].reverse();
}

/** Ids in a hardest-first display order, back to the API's easiest-first order. */
export function easiestFirstIds(hardestFirstIds: readonly string[]): string[] {
  return [...hardestFirstIds].reverse();
}
