import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApiKeyResponseSchema, meResponseSchema } from '../shared/schemas/core.ts';
import { E2E_BASE_URL } from './support/env.ts';
import { createVerifiedUser, expect, ORIGIN, test } from './support/fixtures.ts';

test('an API key created over REST authenticates the REST API and MCP', async ({
  request,
  playwright,
}) => {
  const user = await createVerifiedUser(request);
  const created = await request.post('/api/me/api-keys', {
    data: { name: 'Claude on laptop' },
    headers: ORIGIN,
  });
  expect(created.status()).toBe(201);
  const { key, apiKey } = createApiKeyResponseSchema.parse(await created.json());
  expect(key).toMatch(/^bat_[A-Za-z0-9]{40}$/);

  // REST with the key alone, as a script would call it (no session cookie).
  const script = await playwright.request.newContext({
    baseURL: E2E_BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${key}` },
  });
  try {
    const me = await script.get('/api/me');
    expect(me.ok()).toBe(true);
    expect(meResponseSchema.parse(await me.json()).user.username).toBe(user.username);
  } finally {
    await script.dispose();
  }

  // MCP over Streamable HTTP, as Claude Code or Codex would connect.
  const client = new Client({ name: 'baton-e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${E2E_BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      user: { username: user.username, email: user.email },
      via: { keyId: apiKey.id, keyName: 'Claude on laptop' },
      teams: [],
    });
  } finally {
    await client.close();
  }
});

test('MCP refuses requests without a valid key', async ({ request }) => {
  const missing = await request.post('/mcp', { data: {} });
  expect(missing.status()).toBe(401);
  expect(missing.headers()['www-authenticate']).toMatch(/^Bearer/);

  const wrong = await request.post('/mcp', {
    data: {},
    headers: { Authorization: `Bearer bat_${'x'.repeat(40)}` },
  });
  expect(wrong.status()).toBe(401);
});
