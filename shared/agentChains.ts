import {
  DEFAULT_CHAIN,
  type Chain,
  type DefaultMapping,
  type HarnessId,
  type ProjectMapping,
} from './schemas/agentRunner';

/**
 * Which model chain runs a task (BAT-24): the person's mapping for the task's difficulty level in
 * its project; else the closest mapped level below it, then above it; else their account default
 * for a level of that name; else their account default chain. Pure, so the server (job briefs)
 * and the desktop app agree.
 */

export interface ChainLevel {
  id: string;
  name: string;
  /** Easiest first. */
  position: number;
}

export interface ResolvedChain {
  chain: Chain;
  /** Where it came from, in words: "Hard", "Normal (closest mapped level)", "account default". */
  source: string;
}

function usable(chain: Chain | undefined): chain is Chain {
  return chain !== undefined && chain.length > 0;
}

export function resolveChain(input: {
  /** The project's levels. */
  levels: readonly ChainLevel[];
  /** The task's level, null for none. */
  difficultyId: string | null;
  project: ProjectMapping | null;
  defaults: DefaultMapping | null;
}): ResolvedChain {
  const defaultChain = usable(input.defaults?.chain) ? input.defaults.chain : DEFAULT_CHAIN;
  const level = input.levels.find((candidate) => candidate.id === input.difficultyId);
  if (!level) return { chain: defaultChain, source: 'account default' };

  const mapped = input.project?.levels ?? {};
  const own = mapped[level.id];
  if (usable(own)) return { chain: own, source: level.name };

  const ordered = [...input.levels].sort((a, b) => a.position - b.position);
  const below = ordered.filter((candidate) => candidate.position < level.position).reverse();
  const above = ordered.filter((candidate) => candidate.position > level.position);
  for (const candidate of [...below, ...above]) {
    const chain = mapped[candidate.id];
    if (usable(chain)) return { chain, source: `${candidate.name} (closest mapped level)` };
  }

  const byName = Object.entries(input.defaults?.levels ?? {}).find(
    ([name]) => name.trim().toLowerCase() === level.name.trim().toLowerCase(),
  )?.[1];
  if (usable(byName)) return { chain: byName, source: `${level.name} (account default)` };
  return { chain: defaultChain, source: 'account default' };
}

/**
 * The chain as it runs on one machine: entries whose harness isn't installed, or is out of usage
 * until later, are skipped (keeping their order).
 */
export function runnableChain(
  chain: Chain,
  installed: ReadonlySet<HarnessId>,
  exhaustedUntil: ReadonlyMap<HarnessId, number> = new Map(),
  now: number = Date.now(),
): Chain {
  return chain.filter(
    (entry) => installed.has(entry.harness) && (exhaustedUntil.get(entry.harness) ?? 0) <= now,
  );
}
