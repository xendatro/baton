import {
  HARNESS_LABELS,
  type ChainEntry,
  type HarnessOption,
  type ModelOption,
  type ModelOptions,
} from './schemas/agentRunner';

/**
 * Can a chain step run on one of the owner's computers? From what their desktop apps report
 * (`GET /api/me/agent/model-options`): the harness must be installed on one of them, its model
 * among the models it reports (the harness's default always is), and the effort among the
 * efforts of that model (else of the harness). Pure, so every picker agrees.
 */

export interface StepAvailability {
  available: boolean;
  /** Why not, in words: "You don’t have Codex set up on any of your computers". */
  message: string | null;
  /** The harness doesn't report its models (an older desktop app): accepted, unverified. */
  unverified: boolean;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function harnessOptionOf(
  options: ModelOptions | null | undefined,
  harness: string,
): HarnessOption | null {
  return options?.harnesses.find((entry) => entry.id === harness) ?? null;
}

export function modelOptionOf(harness: HarnessOption | null, model: string): ModelOption | null {
  if (!harness || !model.trim()) return null;
  return harness.models.find((entry) => same(entry.id, model)) ?? null;
}

/** The efforts to offer for a harness and model (the model's own, else the harness's). */
export function effortsFor(harness: HarnessOption | null, model: string): string[] {
  const own = modelOptionOf(harness, model)?.efforts ?? [];
  return own.length > 0 ? own : (harness?.efforts ?? []);
}

/**
 * Availability once the options loaded, or null when nothing can be said: still loading, or no
 * desktop app of the owner has reported yet (an MCP listener runs whatever it runs), so nothing
 * shows as missing.
 */
export function stepAvailabilityOf(
  options: ModelOptions | undefined,
  step: Pick<ChainEntry, 'harness' | 'model' | 'effort'>,
): StepAvailability | null {
  return options && options.harnesses.length > 0 ? stepAvailability(options, step) : null;
}

export function stepAvailability(
  options: ModelOptions | null | undefined,
  step: Pick<ChainEntry, 'harness' | 'model' | 'effort'>,
): StepAvailability {
  const label = HARNESS_LABELS[step.harness];
  const harness = harnessOptionOf(options, step.harness);
  if (!harness) {
    return {
      available: false,
      message: `You don’t have ${label} set up on any of your computers`,
      unverified: false,
    };
  }
  const model = step.model.trim();
  if (model && harness.reported && !modelOptionOf(harness, model)) {
    return {
      available: false,
      message: `You don’t have ${model} set up in ${label} on any of your computers`,
      unverified: false,
    };
  }
  const efforts = effortsFor(harness, model);
  const effort = step.effort.trim();
  if (effort && efforts.length > 0 && !efforts.some((entry) => same(entry, effort))) {
    return {
      available: false,
      message: `${model || label} doesn’t take the effort “${effort}” on your computers (${efforts.join(', ')})`,
      unverified: false,
    };
  }
  return { available: true, message: null, unverified: !harness.reported };
}
