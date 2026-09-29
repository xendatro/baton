import { stepAvailabilityOf } from './modelOptions';
import {
  AGENT_RUNNER_LIMITS,
  DEFAULT_CHAIN,
  HARNESS_LABELS,
  type Chain,
  type ChainEntry,
  type HarnessId,
  type ModelOptions,
  type ModelSource,
} from './schemas/agentRunner';

/**
 * Which model chain runs a job (difficulty is gone, 2026-09-29), in this order:
 * 1. the model the owner chose when approving the request (exactly that, no fallback);
 * 2. the requester's suggestion, when one of the owner's computers has it;
 * 3. the stage's suggestion, likewise;
 * 4. the owner's default for the project;
 * 5. the owner's account default (else Baton's `DEFAULT_CHAIN`).
 * A suggestion that runs goes first, with the default (4, else 5) after it as the fallback.
 * Pure, so the server (job briefs, the Requests page) and the web agree.
 */

export interface ResolveJobModelInput {
  /** The model chosen when approving the request (`agent_job.model_override`). */
  override?: Chain | null;
  /** What the person who started the job suggested, and who ("@caden"). */
  requester?: { step: ChainEntry; by: string } | null;
  /** What the job's stage suggests, and the stage's name. */
  stage?: { step: ChainEntry; stage: string } | null;
  /** The owner's own default for the project, and the project's name. */
  project?: { chain: Chain; name: string } | null;
  /** The owner's account default. */
  account?: Chain | null;
  /**
   * What the owner's computers report (`GET /api/me/agent/model-options`). Null or empty: nothing
   * can be said (no desktop app reported yet), so suggestions are taken as they are.
   */
  options?: ModelOptions | null;
}

export interface ResolvedChain {
  chain: Chain;
  /** Where it came from, in words: "suggested by @caden", "your default for API". */
  source: string;
  modelSource: ModelSource;
  /** Suggestions that were not used, with why. */
  skipped: string[];
}

function usable(chain: Chain | null | undefined): chain is Chain {
  return chain !== null && chain !== undefined && chain.length > 0;
}

function sameStep(a: ChainEntry, b: ChainEntry): boolean {
  return (
    a.harness === b.harness &&
    a.model.trim().toLowerCase() === b.model.trim().toLowerCase() &&
    a.effort.trim().toLowerCase() === b.effort.trim().toLowerCase()
  );
}

/** "Codex · gpt-6-sol · high" (a default model or effort left out). */
export function stepLabel(step: Pick<ChainEntry, 'harness' | 'model' | 'effort'>): string {
  return [HARNESS_LABELS[step.harness], step.model.trim(), step.effort.trim()]
    .filter(Boolean)
    .join(' · ');
}

/** `step` first, then `rest` without it, at most `AGENT_RUNNER_LIMITS.chain` entries. */
export function withFirst(step: ChainEntry, rest: Chain): Chain {
  return [step, ...rest.filter((entry) => !sameStep(entry, step))].slice(
    0,
    AGENT_RUNNER_LIMITS.chain,
  );
}

/** The owner's default for a job: the project's own chain, else the account's. */
export function defaultChainOf(input: Pick<ResolveJobModelInput, 'project' | 'account'>): {
  chain: Chain;
  source: string;
  modelSource: ModelSource;
} {
  if (input.project && usable(input.project.chain)) {
    return {
      chain: input.project.chain,
      source: `your default for ${input.project.name}`,
      modelSource: 'project',
    };
  }
  return {
    chain: usable(input.account) ? input.account : DEFAULT_CHAIN,
    source: 'your account default',
    modelSource: 'account',
  };
}

export function resolveJobModel(input: ResolveJobModelInput): ResolvedChain {
  if (usable(input.override)) {
    return {
      chain: input.override,
      source: 'chosen by your owner when approving the request',
      modelSource: 'approval',
      skipped: [],
    };
  }
  const fallback = defaultChainOf(input);
  const skipped: string[] = [];
  const candidates: Array<{ step: ChainEntry; source: string; modelSource: ModelSource }> = [];
  if (input.requester) {
    candidates.push({
      step: input.requester.step,
      source: `suggested by ${input.requester.by}`,
      modelSource: 'requester',
    });
  }
  if (input.stage) {
    candidates.push({
      step: input.stage.step,
      source: `suggested by the stage ${input.stage.stage}`,
      modelSource: 'stage',
    });
  }
  for (const candidate of candidates) {
    const availability = stepAvailabilityOf(input.options ?? undefined, candidate.step);
    if (availability && !availability.available) {
      skipped.push(
        `${candidate.source} (${stepLabel(candidate.step)}), not used: ${availability.message ?? 'not available'}`,
      );
      continue;
    }
    return {
      chain: withFirst(candidate.step, fallback.chain),
      source: `${candidate.source}; then ${fallback.source}`,
      modelSource: candidate.modelSource,
      skipped,
    };
  }
  return { ...fallback, skipped };
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

/**
 * BAT#28: the harness behind an agent name, as MCP clients name themselves (BAT-6): "Claude" is
 * Claude Code, "Codex" Codex, and so on. Null for names of other clients.
 */
export function harnessOfAgentName(name: string | null | undefined): HarnessId | null {
  const value = name?.trim().toLowerCase() ?? '';
  if (!value) return null;
  if (value.includes('claude')) return 'claude';
  if (value.includes('codex')) return 'codex';
  if (value.includes('gemini')) return 'gemini';
  if (value.includes('cursor')) return 'cursor';
  if (value.includes('opencode')) return 'opencode';
  return null;
}

/**
 * BAT#28: the chain with `harness` first — its own entry of the chain (model and effort) when the
 * chain has one, else the harness with its defaults — and the rest after it as the fallback,
 * at most `max` entries.
 */
export function preferHarness(chain: Chain, harness: HarnessId, max = chain.length + 1): Chain {
  const index = chain.findIndex((entry) => entry.harness === harness);
  const first = index >= 0 ? chain[index] : undefined;
  const rest = chain.filter((_entry, position) => position !== index);
  return [first ?? { harness, model: '', effort: '' }, ...rest].slice(0, Math.max(1, max));
}
