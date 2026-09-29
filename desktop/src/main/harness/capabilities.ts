import type { HarnessModel } from '@shared/schemas/agentRunner';

/**
 * What a harness offers on this machine (models and efforts), read from the harness itself: its
 * `--help`, Codex's models cache, `opencode models`. Never a hardcoded model list: the only fixed
 * names are Claude Code's own aliases (opus / sonnet / haiku always mean the latest) and Codex's
 * effort names when nothing else says which it takes. Pure parsers here, so they can be tested
 * against fixture text; the adapters do the I/O.
 */

export interface HarnessCapabilities {
  models: HarnessModel[];
  /** Efforts for models that don't list their own. */
  efforts: string[];
}

export const NO_CAPABILITIES: HarnessCapabilities = { models: [], efforts: [] };

const MAX_MODELS = 200;
const MAX_EFFORTS = 20;
const MAX_NAME = 100;
const MAX_EFFORT = 40;

function cleanName(value: unknown, max = MAX_NAME): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function uniqueEfforts(values: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const name = cleanName(value, MAX_EFFORT);
    if (name && /^[\w.-]+$/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_EFFORTS) break;
  }
  return out;
}

/** Dedupes by id (first wins), capped. */
export function uniqueModels(models: Iterable<HarnessModel>): HarnessModel[] {
  const seen = new Set<string>();
  const out: HarnessModel[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function model(id: string, label: string | null = null, efforts: string[] = []): HarnessModel {
  return { id, label, efforts };
}

/**
 * The help text of one option (`--effort <level>  Effort level … (low, medium, high)`): from the
 * flag to the next line that starts another option.
 */
export function optionHelp(help: string, name: string): string | null {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`(^|[\\s,])${name}(?![\\w-])`).test(line));
  if (start < 0) return null;
  const parts = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-{1,2}\w/.test(line) || !line.trim()) break;
    parts.push(line);
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

/**
 * A list of choices in an option's help: `(low, medium, high)`, `(choices: "a", "b")`,
 * `[choices: a, b]`, `one of: a, b`, or `a|b|c`.
 */
export function parseChoices(text: string | null): string[] {
  if (!text) return [];
  const choices =
    /choices:\s*([^\])]+)/i.exec(text)?.[1] ?? /one of:?\s*([^.()\]]+)/i.exec(text)?.[1] ?? null;
  const candidates: string[] = [];
  if (choices) candidates.push(choices);
  for (const match of text.matchAll(/\(([^()]*)\)/g)) candidates.push(match[1] ?? '');
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^\s*(e\.g\.|default:?)\s*/i, '');
    if (/default/i.test(candidate) && !choices) continue;
    const words = cleaned
      .split(/[,|/]|\s+or\s+/)
      .map((word) => word.trim().replace(/^["'`]|["'`]$/g, ''))
      .filter(Boolean);
    if (words.length >= 2 && words.every((word) => /^[\w.-]+$/.test(word))) {
      return uniqueEfforts(words);
    }
  }
  const piped = /<?([\w-]+(?:\|[\w-]+)+)>?/.exec(text)?.[1];
  return piped ? uniqueEfforts(piped.split('|')) : [];
}

/**
 * Model names in a `--model` option's help: quoted names, `(e.g. a, b, c)` lists and
 * `default: "x"`.
 */
export function parseModelOption(text: string | null): string[] {
  if (!text) return [];
  const names: string[] = [];
  const add = (value: string) => {
    const name = value.trim().replace(/^["'`]|["'`]$/g, '');
    if (name && /^[\w.:/@-]+$/.test(name) && name.length <= MAX_NAME && !names.includes(name)) {
      names.push(name);
    }
  };
  for (const match of text.matchAll(/default:?\s*["'`]?([\w.:/@-]+)["'`]?/gi)) add(match[1] ?? '');
  for (const match of text.matchAll(/e\.g\.,?\s*([^)\]]*)/gi)) {
    for (const part of (match[1] ?? '').split(/,|\s+or\s+/)) add(part);
  }
  for (const match of text.matchAll(/['"`]([\w.:/@-]+)['"`]/g)) add(match[1] ?? '');
  return names.filter((name) => !/^(model|string|default)$/i.test(name));
}

/** Claude Code's aliases: always the latest of each family. */
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku'];

/**
 * Claude Code's `--help`: efforts from `--effort <level>` ("(low, medium, high, xhigh, max)"),
 * models = the aliases plus the names its `--model` help quotes (e.g. 'fable', full model ids).
 * Every model takes the harness's efforts.
 */
export function parseClaudeHelp(help: string): HarnessCapabilities {
  const efforts = parseChoices(optionHelp(help, '--effort'));
  const quoted = parseModelOption(optionHelp(help, '--model'));
  return {
    models: uniqueModels([...CLAUDE_ALIASES, ...quoted].map((id) => model(id))),
    efforts,
  };
}

/** Codex's reasoning efforts when nothing on the machine says which it takes. */
export const CODEX_FALLBACK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function effortEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueEfforts(
    value.map((entry) => {
      if (typeof entry === 'string') return entry;
      const item = record(entry);
      return item ? (item.effort ?? item.level ?? item.id ?? item.name) : null;
    }),
  );
}

/**
 * Codex's models cache (`~/.codex/models_cache.json`), read defensively: its format changes
 * between versions, so no field is required. Models are an array at the root or under
 * `models` / `data`; each has an id (`slug`, `id`, `model` or `name`), a label (`display_name`,
 * `displayName`, `label`, `name`) and efforts (`supported_reasoning_levels`,
 * `supported_reasoning_efforts`, `reasoning_efforts`: names or `{ effort }` objects). Hidden
 * models are skipped. Null when it holds no models at all.
 */
export function parseCodexModelsCache(json: unknown): HarnessModel[] | null {
  const root = record(json);
  const list = Array.isArray(json)
    ? json
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(root?.data)
        ? root.data
        : null;
  if (!list) return null;
  const models: HarnessModel[] = [];
  for (const entry of list as unknown[]) {
    const item = record(entry);
    if (!item) {
      const id = cleanName(entry);
      if (id) models.push(model(id));
      continue;
    }
    const visibility = typeof item.visibility === 'string' ? item.visibility.toLowerCase() : '';
    if (visibility === 'hide' || visibility === 'hidden' || item.hidden === true) continue;
    const id =
      cleanName(item.slug) ?? cleanName(item.id) ?? cleanName(item.model) ?? cleanName(item.name);
    if (!id) continue;
    const label =
      cleanName(item.display_name) ??
      cleanName(item.displayName) ??
      cleanName(item.label) ??
      (cleanName(item.name) !== id ? cleanName(item.name) : null);
    const efforts = effortEntries(
      item.supported_reasoning_levels ??
        item.supported_reasoning_efforts ??
        item.reasoning_efforts ??
        item.supportedReasoningLevels,
    );
    models.push(model(id, label && label !== id ? label : null, efforts));
  }
  const unique = uniqueModels(models);
  return unique.length > 0 ? unique : null;
}

/** `opencode models`: one `provider/model` per line (other lines are ignored). */
export function parseOpencodeModels(text: string | null): HarnessModel[] {
  if (!text) return [];
  return uniqueModels(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+\/[\w.:@/-]+$/.test(line) && line.length <= MAX_NAME)
      .map((id) => model(id)),
  );
}

/** Generic `--help` of a CLI: its `--model` names and, if it has one, its effort choices. */
export function parseCliHelp(help: string): HarnessCapabilities {
  const efforts = parseChoices(
    optionHelp(help, '--effort') ?? optionHelp(help, '--reasoning-effort'),
  );
  return {
    models: uniqueModels(parseModelOption(optionHelp(help, '--model')).map((id) => model(id))),
    efforts,
  };
}
