import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errors } from '../../lib/errors';
import { createTestContext, createUser, type TestContext } from '../../test/helpers';
import { allTools, defineTool, registerTools, type ToolContext } from './index';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

const echo = defineTool({
  name: 'echo_upper',
  title: 'Echo',
  description: 'Uppercases text.',
  input: z.object({
    text: z.string().min(1).describe('Text to echo'),
    times: z.number().int().min(1).max(3).default(1).describe('Repetitions'),
  }),
  handler: (_ctx, input) => ({ text: input.text.toUpperCase().repeat(input.times) }),
});

const failing = defineTool({
  name: 'always_forbidden',
  title: 'Forbidden',
  description: 'Throws an AppError.',
  input: z.object({}),
  handler: () => {
    throw errors.forbidden('Nope');
  },
});

const crashing = defineTool({
  name: 'crashes',
  title: 'Crash',
  description: 'Throws an unexpected error.',
  input: z.object({}),
  handler: () => {
    throw new Error('stack trace with secrets');
  },
});

async function connect(toolCtx: ToolContext) {
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, toolCtx, [echo, failing, crashing]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP tool registry', () => {
  it('registers typed tools and returns JSON text plus structured content', async () => {
    const user = createUser(ctx.db);
    const client = await connect({
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: null },
    });

    const { tools } = await client.listTools();
    const listed = tools.find((tool) => tool.name === 'echo_upper');
    expect(listed?.inputSchema.properties).toMatchObject({
      text: { type: 'string', description: 'Text to echo' },
    });

    const result = await client.callTool({
      name: 'echo_upper',
      arguments: { text: 'hi', times: 2 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ text: 'HIHI' });
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"HIHI"}' }]);
    await client.close();
  });

  it('turns AppErrors into isError results and hides unexpected errors', async () => {
    const user = createUser(ctx.db);
    const client = await connect({
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: null },
    });

    const forbidden = await client.callTool({ name: 'always_forbidden', arguments: {} });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.content).toEqual([{ type: 'text', text: 'forbidden: Nope' }]);

    const crashed = await client.callTool({ name: 'crashes', arguments: {} });
    expect(crashed.isError).toBe(true);
    expect(JSON.stringify(crashed.content)).not.toContain('secrets');
    await client.close();
  });

  it('rejects duplicate tool names', () => {
    const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
    const user = createUser(ctx.db);
    expect(() =>
      registerTools(
        server,
        { deps: ctx.deps, actor: { userId: user.id, source: 'mcp', key: null } },
        [echo, echo],
      ),
    ).toThrow(/Duplicate MCP tool name/);
  });

  it('uses snake_case names for every registered tool', () => {
    for (const tool of allTools) expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
