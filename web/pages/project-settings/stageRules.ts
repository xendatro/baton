import type { HandoffMode, StageRules } from '@shared/schemas/pipelines';

/** Wording of pipeline stage rules (design §5) in Project settings → Statuses. */

export const HANDOFF_LABELS: Record<HandoffMode, string> = {
  keep: 'Keep the assignees',
  specific: 'Assign specific people',
  pool: 'Put it in a pool (anyone matching can claim it)',
  round_robin: 'Assign one of them in turn (round robin)',
  least_busy: 'Assign whoever of them is least busy',
  author: 'Assign the task’s author',
  mover: 'Assign whoever moved it here',
  stage_holder: 'Give it back to whoever held it in…',
};

/** How many rules a stage has (shown on its Rules button). */
export function countRules(rules: StageRules | undefined): number {
  if (!rules) return 0;
  return [
    rules.instructions.trim() !== '',
    rules.handoff.mode !== 'keep',
    rules.notify !== null,
    rules.exitCriteria.length > 0,
    rules.moveRule !== null,
    rules.approvals !== null,
    rules.autoAdvance,
    rules.nextStatusId !== null,
    !rules.allowSendBack,
  ].filter(Boolean).length;
}
