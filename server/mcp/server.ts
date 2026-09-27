import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { agentNameFromClient } from '@shared/agents';
import type { AppEnv } from '../context';
import type { Env } from '../env';
import { requireActor } from '../middleware/actor';
import { recordKeyAgent } from '../services/apiKeys';
import { byApiKey, rateLimit } from '../middleware/rateLimit';
import { VERSION } from '../version';
import { mcpAuth } from './auth';
import { registerTools } from './tools';

const INSTRUCTIONS = `Baton is a shared workspace where people and their agents coordinate work.
Teams contain projects; projects contain issues (forum posts, refs like KEY#51) and tasks (board items, refs like KEY-12).
You act as the agent member of the person who owns your API key (e.g. Ethan's agent is "Ethan AI", @ethan-ai): everything you write is authored by that agent "via" the key, your permissions never exceed your owner's, and people mention you as @<your username> (see whoami).
Refs are accepted wherever an entity is expected: team slug, project KEY or team-slug/KEY, task KEY-12, issue KEY#51, username, role slug or name, status or label name. Ids work too.
You have no inbox: when someone mentions you, assigns you a task, replies in a thread you take part in or hands you work, you get a job. To work as a team member, run a listener loop: call start_listener { projects: [KEY, ...] } (pass back the sessionId it returns), and for each job it returns spawn a subagent that follows the job's instructions and ends with complete_job (or release_job); then call start_listener again right away. Claimed jobs stay yours until you complete or release them. When an exchange with another agent is finished, reply with closing: true; if another agent's closing reply reaches you and you agree, call complete_job { agreeDone: true } instead of replying.`;

/**
 * The MCP endpoint (SPEC §5.1): Streamable HTTP in stateless mode. Every POST builds a fresh
 * McpServer bound to the caller (actor + deps), so no session state is kept between requests.
 * Stateless servers have no server-initiated stream and no sessions to delete, so GET and DELETE
 * answer 405 as the MCP specification allows.
 *
 * JSON-RPC batches are refused (they were removed from MCP in 2025-06-18): the per-key rate limit
 * counts HTTP requests, so a batch would multiply it by the batch size.
 */
export const mcpRoutes = new Hono<AppEnv>();

/** Room for the JSON-RPC envelope and the other tool arguments around an uploaded file. */
const ENVELOPE_BYTES = 64 * 1024;

/**
 * Largest MCP request body: an `upload_attachment` of MAX_UPLOAD_MB sent as base64 (4/3 of the
 * file) plus the envelope, so MCP uploads get the same size limit as web uploads.
 */
export function mcpMaxBodyBytes(env: Pick<Env, 'maxUploadMb'>): number {
  return Math.ceil((env.maxUploadMb * 1024 * 1024 * 4) / 3) + ENVELOPE_BYTES;
}

function jsonRpcError(c: Context, status: 400 | 413, code: number, message: string) {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, status);
}

const mcpBodyLimit: MiddlewareHandler<AppEnv> = (c, next) =>
  bodyLimit({
    maxSize: mcpMaxBodyBytes(c.var.deps.env),
    onError: (ctx) =>
      jsonRpcError(
        ctx,
        413,
        -32000,
        `Payload too large: files can be at most ${c.var.deps.env.maxUploadMb} MB`,
      ),
  })(c, next);

mcpRoutes.use('/mcp', mcpAuth(), rateLimit({ name: 'mcp', key: byApiKey }));

mcpRoutes.post('/mcp', mcpBodyLimit, async (c) => {
  const actor = requireActor(c);
  let message: unknown;
  try {
    message = JSON.parse(await c.req.text());
  } catch {
    return jsonRpcError(c, 400, -32700, 'Parse error: the body must be one JSON-RPC message');
  }
  if (Array.isArray(message)) {
    return jsonRpcError(
      c,
      400,
      -32600,
      'Invalid Request: JSON-RPC batches are not supported; send one message per request',
    );
  }
  // The client names itself only in `initialize`; the key remembers it for later requests.
  const agentName = initializeAgentName(message);
  if (agentName && actor.key) {
    recordKeyAgent(c.var.deps, actor.key.id, agentName);
    actor.key.agentName = agentName;
  }
  const server = new McpServer(
    { name: 'baton', title: 'Baton', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, { deps: c.var.deps, actor, signal: c.req.raw.signal });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw, { parsedBody: message });
  } finally {
    await server.close();
  }
});

/** The agent name of an `initialize` request's `clientInfo`, if the message is one. */
function initializeAgentName(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== 'initialize' || typeof params !== 'object' || params === null) return null;
  const { clientInfo } = params as { clientInfo?: unknown };
  if (typeof clientInfo !== 'object' || clientInfo === null) return null;
  return agentNameFromClient(clientInfo);
}

mcpRoutes.on(['GET', 'DELETE'], '/mcp', (c) =>
  c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this MCP server is stateless' },
      id: null,
    },
    405,
    { Allow: 'POST' },
  ),
);
