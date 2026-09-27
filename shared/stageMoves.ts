/**
 * The moves a task can make from its stage (BAT-27), shared by the server's checks and the board's
 * drag targets. `ordered` is one pipeline's stages in column order.
 *
 *   - Forward: only to the stage's next stage, its `nextStatusId` or else the next column (none
 *     from the last stage).
 *   - Back: only to the earlier stages listed in its `sendBackTo`, nearest first.
 */

export interface MoveStage {
  id: string;
  nextStatusId: string | null;
  sendBackTo: readonly string[];
}

/** The stage after `from` (null: the last stage). */
export function nextStageOf<T extends MoveStage>(ordered: readonly T[], from: T): T | null {
  if (from.nextStatusId) {
    const next = ordered.find((row) => row.id === from.nextStatusId);
    if (next && next.id !== from.id) return next;
  }
  const index = ordered.findIndex((row) => row.id === from.id);
  return index === -1 ? null : (ordered[index + 1] ?? null);
}

/** The earlier stages `from` may send tasks back to, nearest first. */
export function backStagesOf<T extends MoveStage>(ordered: readonly T[], from: T): T[] {
  const index = ordered.findIndex((row) => row.id === from.id);
  if (index <= 0 || from.sendBackTo.length === 0) return [];
  const allowed = new Set(from.sendBackTo);
  return ordered
    .slice(0, index)
    .filter((row) => allowed.has(row.id))
    .reverse();
}

/** Every stage before `id` in column order (a new stage's default send-back list). */
export function earlierStageIds(ordered: ReadonlyArray<{ id: string }>, id: string): string[] {
  const index = ordered.findIndex((row) => row.id === id);
  return (index === -1 ? ordered : ordered.slice(0, index)).map((row) => row.id);
}
