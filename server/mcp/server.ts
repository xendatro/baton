import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import type { AppEnv } from '../context';
import { requireActor } from '../middleware/actor';
import { byApiKey, rateLimit } from '../middleware/rateLimit';
import { VERSION } from '../version';
import { mcpAuth } from './auth';
import { registerTools } from './tools';

const INSTRUCTIONS = `Baton is a shared workspace where people and their agents coordinate work.
Teams contain projects; projects contain issues (forum posts, refs like KEY#51) and tasks (board items, refs like KEY-12).
You act as the user who owns your API key; everything you change is attributed to them "via" the key.
Refs are accepted wherever an entity is expected: team slug, project KEY or team-slug/KEY, task KEY-12, issue KEY#51, username, role slug or name, status or label name. Ids work too.`;

/**
 * The MCP endpoint (SPEC §5.1): Streamable HTTP in stateless mode. Every POST builds a fresh
 * McpServer bound to the caller (actor + deps), so no session state is kept between requests.
 * Stateless servers have no server-initiated stream and no sessions to delete, so GET and DELETE
 * answer 405 as the MCP specification allows.
 */
export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.use('/mcp', mcpAuth(), rateLimit({ name: 'mcp', key: byApiKey }));

mcpRoutes.post('/mcp', async (c) => {
  const actor = requireActor(c);
  const server = new McpServer(
    { name: 'baton', title: 'Baton', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, { deps: c.var.deps, actor });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    await server.close();
  }
});

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
