import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
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
  /** Every field needs a `.describe()` so agents know what to pass. */
  input: Input;
  annotations?: ToolAnnotations;
  /** Calls services only. Returns a JSON-serialisable value (sent as text + structuredContent). */
  handler: (ctx: ToolContext, input: z.output<Input>) => unknown;
}

/** A tool ready to be registered on a per-request McpServer. */
export interface McpTool {
  name: string;
  register(server: McpServer, ctx: ToolContext): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wraps a handler's return value (or thrown error) in an MCP tool result. */
export async function toToolResult(
  ctx: ToolContext,
  toolName: string,
  run: () => unknown,
): Promise<CallToolResult> {
  try {
    const value = await run();
    const structuredContent = isPlainObject(value) ? value : { result: value ?? null };
    return {
      content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
      structuredContent,
    };
  } catch (error) {
    if (isAppError(error)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      };
    }
    ctx.deps.logger.error({ err: error, tool: toolName }, 'MCP tool failed');
    return { isError: true, content: [{ type: 'text', text: 'internal: Something went wrong' }] };
  }
}

/** Declares a tool with a typed zod input. Collect definitions in the module's tools file. */
export function defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): McpTool {
  return {
    name: definition.name,
    register(server, ctx) {
      // Widened to the non-generic object schema so the SDK's callback type resolves.
      const inputSchema: z.ZodObject = definition.input;
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema,
          ...(definition.annotations ? { annotations: definition.annotations } : {}),
        },
        // The SDK validated the arguments against `definition.input`, so they are its output.
        (input) =>
          toToolResult(ctx, definition.name, () =>
            definition.handler(ctx, input as z.output<Input>),
          ),
      );
    },
  };
}
