import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Actor, AppDeps } from '../../context';
import { isAppError } from '../../lib/errors';

/** Per-request context every tool handler receives (the MCP server is stateless). */
export interface ToolContext {
  deps: AppDeps;
  /** Always `{ source: 'mcp', key }` — MCP requires an API key. */
  actor: Actor;
}

export interface ToolDefinition<Input extends z.ZodObject> {
  /** snake_case, e.g. `create_task`. */
  name: string;
  title: string;
  description: string;
  /**
   * Built with `toolInput` (a strict object), so unknown or misspelled arguments are refused
   * instead of silently dropped. Every field needs a `.describe()` so agents know what to pass.
   */
  input: Input;
  /**
   * Behaviour hints for clients. Every tool gets `openWorldHint: false` (Baton is a closed
   * system); a tool that isn't `readOnlyHint: true` must say whether it is destructive.
   */
  annotations?: ToolAnnotations;
  /** Calls services only. Returns a JSON-serialisable value (sent as text + structuredContent). */
  handler: (ctx: ToolContext, input: z.output<Input>) => unknown;
}

/** A tool ready to be registered on a per-request McpServer. */
export interface McpTool {
  name: string;
  /** The annotations advertised in `tools/list` (defaults applied). */
  annotations: ToolAnnotations;
  register(server: McpServer, ctx: ToolContext): void;
}

// ---------------------------------------------------------------------------------------------
// Strict inputs
// ---------------------------------------------------------------------------------------------

/** Names agents commonly use for a parameter that some tools spell differently. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  q: ['query'],
  query: ['q'],
  search: ['query', 'q'],
  due: ['dueDate'],
  dueDate: ['due'],
  body: ['text', 'description'],
  description: ['body'],
  user: ['username', 'assignee'],
  username: ['user'],
};

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function singular(key: string): string {
  return key.endsWith('ies') ? `${key.slice(0, -3)}y` : key.replace(/s$/, '');
}

/** Levenshtein distance, for "did you mean" on short parameter names. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, substitution);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/** The accepted parameter an unknown key most likely meant, if any. */
export function suggestKey(unknown: string, accepted: readonly string[]): string | undefined {
  const synonym = SYNONYMS[unknown]?.find((key) => accepted.includes(key));
  if (synonym) return synonym;
  const wanted = singular(normalizeKey(unknown));
  const same = accepted.find((key) => singular(normalizeKey(key)) === wanted);
  if (same) return same;
  const close = accepted
    .map((key) => ({ key, score: distance(normalizeKey(key), normalizeKey(unknown)) }))
    .filter(({ key, score }) => score <= Math.min(2, Math.floor(key.length / 3)))
    .sort((a, b) => a.score - b.score)[0];
  return close?.key;
}

function unknownKeysMessage(keys: readonly string[], accepted: readonly string[]): string {
  const parts = keys.map((key) => {
    const suggestion = suggestKey(key, accepted);
    return suggestion ? `"${key}" (did you mean "${suggestion}"?)` : `"${key}"`;
  });
  const noun = keys.length === 1 ? 'Unknown parameter' : 'Unknown parameters';
  return `${noun} ${parts.join(', ')}. Accepted: ${accepted.join(', ') || 'none'}`;
}

/**
 * A strict tool input (or nested argument) object: unknown keys are an error that names them,
 * suggests the parameter the caller probably meant and lists the accepted ones, instead of being
 * dropped silently. The advertised JSON schema carries `additionalProperties: false`.
 */
export function toolInput<Shape extends z.ZodRawShape>(shape: Shape) {
  const accepted = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys' ? unknownKeysMessage(issue.keys, accepted) : undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Error details worth showing an agent (suggested values and the like) as JSON. What messages
 * already say is left out: validation issues (the message names the first one with its field),
 * the failing ref and the candidates (not-found and ambiguity messages list them).
 */
function detailsText(details: unknown): string {
  if (details === undefined || details === null) return '';
  if (isPlainObject(details)) {
    const { issues: _issues, ref: _ref, candidates: _candidates, ...rest } = details;
    return Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  }
  return ` ${JSON.stringify(details)}`;
}

/**
 * Wraps a handler's return value (or thrown error) in an MCP tool result and logs the call (tool,
 * key, duration, outcome — never the arguments, which may hold content or secrets). An AppError
 * becomes `code: message` followed by its details as JSON, so the agent gets the same actionable
 * data (candidates, suggestions) as a REST client.
 */
export async function toToolResult(
  ctx: ToolContext,
  toolName: string,
  run: () => unknown,
): Promise<CallToolResult> {
  const started = performance.now();
  const log = (outcome: string, extra: Record<string, unknown> = {}) =>
    ctx.deps.logger.info(
      {
        tool: toolName,
        userId: ctx.actor.userId,
        keyId: ctx.actor.key?.id ?? null,
        ms: Math.round(performance.now() - started),
        outcome,
        ...extra,
      },
      'mcp tool call',
    );
  try {
    const value = await run();
    const structuredContent = isPlainObject(value) ? value : { result: value ?? null };
    log('ok');
    return {
      content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
      structuredContent,
    };
  } catch (error) {
    if (isAppError(error)) {
      log(error.code);
      return {
        isError: true,
        content: [
          { type: 'text', text: `${error.code}: ${error.message}${detailsText(error.details)}` },
        ],
      };
    }
    ctx.deps.logger.error({ err: error, tool: toolName }, 'MCP tool failed');
    log('internal');
    return { isError: true, content: [{ type: 'text', text: 'internal: Something went wrong' }] };
  }
}

/** Declares a tool with a typed zod input. Collect definitions in the module's tools file. */
export function defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): McpTool {
  const annotations: ToolAnnotations = { openWorldHint: false, ...definition.annotations };
  return {
    name: definition.name,
    annotations,
    register(server, ctx) {
      // Widened to the non-generic object schema so the SDK's callback type resolves.
      const inputSchema: z.ZodObject = definition.input;
      server.registerTool(
        definition.name,
        { title: definition.title, description: definition.description, inputSchema, annotations },
        // The SDK validated the arguments against `definition.input`, so they are its output.
        (input) =>
          toToolResult(ctx, definition.name, () =>
            definition.handler(ctx, input as z.output<Input>),
          ),
      );
    },
  };
}
