import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profileResponseSchema } from '@shared/schemas/account';
import { securityLogResponseSchema } from '@shared/schemas/core';
import * as s from '../../db/schema';
import {
  createApiKey,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { accountTools } from './account';
import { registerTools } from './index';

let ctx: TestContext;
let user: UserRow;
let client: Client;

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(async () => {
  ctx = createTestContext({ env: { LOG_LEVEL: 'silent' } });
  user = createUser(ctx.db, { username: 'ada', name: 'Ada' });
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude on laptop' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
    },
    accountTools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  ctx.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first?.text ?? '';
}

describe('account MCP tools', () => {
  it('lists the account tools with described inputs', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_security_log',
      'remove_avatar',
      'set_avatar',
      'update_profile',
    ]);
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }
  });

  it('update_profile changes the profile through the same service as the web', async () => {
    const result = await call('update_profile', { name: 'Ada King', username: 'Ada_K' });
    expect(result.isError).toBeFalsy();
    expect(profileResponseSchema.parse(result.structuredContent)).toMatchObject({
      name: 'Ada King',
      username: 'ada_k',
      displayUsername: 'Ada_K',
    });
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.actorId, user.id), isNull(s.activity.teamId)))
      .get();
    expect(row).toMatchObject({
      action: 'user.profile_updated',
      source: 'mcp',
      viaKeyName: 'Claude on laptop',
    });
  });

  it('update_profile reports taken usernames and empty calls as errors', async () => {
    createUser(ctx.db, { username: 'grace' });
    const taken = await call('update_profile', { username: 'grace' });
    expect(taken.isError).toBe(true);
    expect(textOf(taken)).toBe('conflict: @grace is taken');

    const empty = await call('update_profile', {});
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/at least one of name, username or theme/);
  });

  it('set_avatar and remove_avatar manage the profile picture', async () => {
    const set = await call('set_avatar', {
      filename: 'me.png',
      contentBase64: `data:image/png;base64,${PNG_BASE64}`,
    });
    expect(set.isError).toBeFalsy();
    expect(profileResponseSchema.parse(set.structuredContent).image).toMatch(
      /^\/api\/attachments\/.+\/me\.png$/,
    );

    const notImage = await call('set_avatar', {
      filename: 'notes.txt',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    expect(notImage.isError).toBe(true);
    expect(textOf(notImage)).toBe('validation_failed: Use a PNG, JPEG, GIF or WebP image');

    const invalid = await call('set_avatar', { filename: 'x.png', contentBase64: '***' });
    expect(textOf(invalid)).toBe('validation_failed: contentBase64 is not valid base64');

    const removed = await call('remove_avatar');
    expect(profileResponseSchema.parse(removed.structuredContent).image).toBeNull();
  });

  it('get_security_log pages through the caller’s own log with absolute URLs', async () => {
    await call('update_profile', { name: 'One' });
    await call('update_profile', { name: 'Two' });
    const first = await call('get_security_log', { limit: 1 });
    const page = securityLogResponseSchema.parse(first.structuredContent);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.changes).toEqual({ name: { from: 'One', to: 'Two' } });
    expect(page.items[0]?.url).toBe(`${ctx.env.baseUrl}/settings/security`);
    expect(page.nextCursor).not.toBeNull();

    const second = await call('get_security_log', { limit: 1, cursor: page.nextCursor });
    const next = securityLogResponseSchema.parse(second.structuredContent);
    expect(next.items[0]?.changes).toEqual({ name: { from: 'Ada', to: 'One' } });
  });
});
