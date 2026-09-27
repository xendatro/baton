import { HARNESS_LABELS, type Chain } from '@shared/schemas/agentRunner';

/** A model chain in words: "Claude Code opus → Codex". */
export function chainSummary(chain: Chain): string {
  return chain
    .map((entry) => `${HARNESS_LABELS[entry.harness]}${entry.model ? ` ${entry.model}` : ''}`)
    .join(' → ');
}
