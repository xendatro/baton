/**
 * Estimated API prices of the models automatic agents run (BAT#25), to show what a run would have
 * cost at list API rates when the harness doesn't report a cost itself (Codex, Gemini CLI, …).
 * Subscription usage (Claude Pro/Max, ChatGPT plans) has no real per-token charge: these figures
 * are estimates, always labelled so.
 *
 * Prices are US dollars per million tokens. Update the table (and `MODEL_PRICES_AS_OF`) when
 * providers change their prices; a model missing here shows "—" rather than $0. `uncertain`
 * marks rates that couldn't be checked against the provider's price page.
 */

export const MODEL_PRICES_AS_OF = '2026-09-29';

export interface ModelPrice {
  /** Uncached input. */
  input: number;
  /** Cached input / cache reads. */
  cacheRead: number;
  /** Cache writes (cache creation); providers without a write charge bill it as input. */
  cacheWrite: number;
  /** Output (reasoning tokens included). */
  output: number;
  uncertain?: boolean;
}

/** Anthropic: cache reads cost 0.1× input, 5-minute cache writes 1.25× input. */
function anthropic(input: number, output: number, uncertain = false): ModelPrice {
  return {
    input,
    cacheRead: input * 0.1,
    cacheWrite: input * 1.25,
    output,
    ...(uncertain ? { uncertain } : {}),
  };
}

/** OpenAI: cached input at the listed cached rate, no charge for writing the cache. */
function openai(input: number, cached: number, output: number, uncertain = false): ModelPrice {
  return {
    input,
    cacheRead: cached,
    cacheWrite: input,
    output,
    ...(uncertain ? { uncertain } : {}),
  };
}

/** Canonical model id (see `canonicalModel`) → price. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic (Claude Code reports its own cost; these cover runs that didn't).
  'claude-fable-5': anthropic(10, 50, true),
  'claude-mythos-5': anthropic(10, 50, true),
  'claude-opus-5': anthropic(5, 25, true),
  'claude-opus-4-8': anthropic(5, 25, true),
  'claude-opus-4-7': anthropic(5, 25, true),
  'claude-opus-4-6': anthropic(5, 25),
  'claude-opus-4-5': anthropic(5, 25),
  'claude-opus-4-1': anthropic(15, 75),
  'claude-opus-4': anthropic(15, 75),
  'claude-sonnet-5': anthropic(3, 15, true),
  'claude-sonnet-4-6': anthropic(3, 15),
  'claude-sonnet-4-5': anthropic(3, 15),
  'claude-sonnet-4': anthropic(3, 15),
  'claude-3-7-sonnet': anthropic(3, 15),
  'claude-haiku-4-5': anthropic(1, 5),
  'claude-3-5-haiku': anthropic(0.8, 4),
  // OpenAI (the models Codex runs).
  'gpt-5': openai(1.25, 0.125, 10),
  'gpt-5-codex': openai(1.25, 0.125, 10),
  'gpt-5-mini': openai(0.25, 0.025, 2),
  'gpt-5-nano': openai(0.05, 0.005, 0.4),
  'gpt-5.1': openai(1.25, 0.125, 10),
  'gpt-5.1-codex': openai(1.25, 0.125, 10),
  'gpt-5.1-codex-mini': openai(0.25, 0.025, 2),
  'gpt-5.1-codex-max': openai(1.25, 0.125, 10, true),
  'gpt-5.2': openai(1.75, 0.175, 14, true),
  'gpt-5.2-codex': openai(1.75, 0.175, 14, true),
  'codex-mini-latest': openai(1.5, 0.375, 6),
  'gpt-4.1': openai(2, 0.5, 8),
  o3: openai(2, 0.5, 8),
  'o4-mini': openai(1.1, 0.275, 4.4),
};

/**
 * One id per model however it was written (BAT#25: "gpt-6-sol", "GPT-6-Sol " and
 * "openai/gpt-6-sol" are one model): trimmed, lower-case, without a provider prefix
 * (`openai/…`, `anthropic/…`), a context-window suffix (`[1m]`) or a release date
 * (`-20251001`, `@20251001`). Empty stays empty (the harness's default model).
 */
export function canonicalModel(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, '');
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/[-@]\d{8}$/, '');
  return id.trim();
}

export function modelPrice(model: string): ModelPrice | null {
  const id = canonicalModel(model);
  return id ? (MODEL_PRICES[id] ?? null) : null;
}

export interface TokenCounts {
  /** All input, cache reads and writes included. */
  tokensIn: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** All output, reasoning included. */
  tokensOut: number;
}

/** The estimated API cost of a run in US dollars, or null when the model has no known price. */
export function estimateCost(model: string, tokens: TokenCounts): number | null {
  const price = modelPrice(model);
  if (!price) return null;
  const uncached = Math.max(0, tokens.tokensIn - tokens.tokensCacheRead - tokens.tokensCacheWrite);
  return (
    (uncached * price.input +
      tokens.tokensCacheRead * price.cacheRead +
      tokens.tokensCacheWrite * price.cacheWrite +
      tokens.tokensOut * price.output) /
    1_000_000
  );
}
