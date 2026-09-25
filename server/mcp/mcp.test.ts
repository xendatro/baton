import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '@shared/constants';
import { createApiKeyResponseSchema } from '@shared/schemas/core';
import * as s from '../db/schema';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { mcpMaxBodyBytes } from './server';
import { coreTools } from './tools/core';

let ctx: TestContext;
let server: ServerType;
let origin: string;
let owner: UserRow;
let clients: Client[];

beforeEach(async () => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'ethan' });
  clients = [];
  origin = await new Promise<string>((resolve) => {
    server = serve({ fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) =>
      resolve(`http://127.0.0.1:${info.port}`),
    );
  });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
  ctx.close();
});

async function connect(key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'baton-test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function structured<T = Record<string, unknown>>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

describe('MCP over Streamable HTTP', () => {
  it('runs the key → tools → reply → audit flow end to end', async () => {
    // A key created through the web app, as the settings page does.
    const cookie = await signIn(ctx, owner);
    const created = await ctx.app.request(
      '/api/me/api-keys',
      json('POST', { name: 'Claude on laptop' }, web(ctx, cookie)),
    );
    const { key, apiKey } = createApiKeyResponseSchema.parse(await created.json());

    const team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
    const project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
    const task = createTask(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Ship it',
    });

    const client = await connect(key);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const tool of coreTools) expect(names).toContain(tool.name);
    for (const tool of tools.filter((t) => coreTools.some((c) => c.name === t.name))) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }

    const whoami = structured<{
      user: { username: string };
      via: { keyName: string };
      teams: Array<{ slug: string; url: string; projects: Array<{ ref: string }> }>;
    }>(await client.callTool({ name: 'whoami', arguments: {} }));
    expect(whoami.user.username).toBe('ethan');
    expect(whoami.via.keyName).toBe('Claude on laptop');
    expect(whoami.teams[0]).toMatchObject({ slug: 'acme', url: `${ctx.env.baseUrl}/t/acme` });
    expect(whoami.teams[0]?.projects[0]?.ref).toBe('acme/API');

    const reply = structured<{ id: string; ref: string; url: string; via: { keyName: string } }>(
      await client.callTool({
        name: 'add_reply',
        arguments: { item: 'API-1', body: 'Started working on this.' },
      }),
    );
    expect(reply.ref).toBe('API-1');
    expect(reply.url).toBe(`${ctx.env.baseUrl}/t/acme/p/API/tasks/1#reply-${reply.id}`);
    expect(reply.via.keyName).toBe('Claude on laptop');

    const row = ctx.db.orm.select().from(s.activity).where(eq(s.activity.entityId, reply.id)).get();
    expect(row).toMatchObject({
      action: 'reply.created',
      source: 'mcp',
      actorId: owner.id,
      viaKeyId: apiKey.id,
      viaKeyName: 'Claude on laptop',
    });

    const history = structured<{
      items: Array<{ action: string; actor: { via: { keyName: string } } }>;
    }>(
      await client.callTool({
        name: 'get_activity',
        arguments: { entityType: 'reply', entityId: reply.id },
      }),
    );
    expect(history.items[0]).toMatchObject({
      action: 'reply.created',
      actor: { via: { keyName: 'Claude on laptop' } },
    });

    const thread = structured<{ item: { ref: string }; replies: Array<{ id: string }> }>(
      await client.callTool({ name: 'list_replies', arguments: { item: task.id } }),
    );
    expect(thread.item.ref).toBe('API-1');
    expect(thread.replies.map((r) => r.id)).toEqual([reply.id]);
  });

  it('covers search, attachments, subscriptions, notifications and the audit log', async () => {
    const team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
    const project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
    const issue = createIssue(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Crash',
    });
    const mia = createUser(ctx.db, { username: 'mia' });
    addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
    const client = await connect(createApiKey(ctx.db, { userId: owner.id, name: 'Codex' }).key);
    const miaClient = await connect(createApiKey(ctx.db, { userId: mia.id }).key);

    structured(
      await client.callTool({
        name: 'add_reply',
        arguments: { item: 'API#1', body: 'ping @mia about the crash' },
      }),
    );
    const found = structured<{ results: Array<{ ref: string; url: string }> }>(
      await client.callTool({ name: 'search', arguments: { query: 'crash', project: 'API' } }),
    );
    expect(found.results.map((r) => r.ref)).toEqual(['API#1']);
    expect(found.results[0]?.url.startsWith(ctx.env.baseUrl)).toBe(true);

    const upload = structured<{ id: string; parentType: string; url: string }>(
      await client.callTool({
        name: 'upload_attachment',
        arguments: { item: 'API#1', filename: 'log.txt', text: 'stack trace here' },
      }),
    );
    expect(upload.parentType).toBe('issue');
    const fetched = structured<{ text: string; downloadUrl: string }>(
      await client.callTool({ name: 'get_attachment', arguments: { attachment: upload.id } }),
    );
    expect(fetched.text).toBe('stack trace here');
    const listed = structured<{ items: Array<{ id: string }> }>(
      await client.callTool({ name: 'list_attachments', arguments: { item: issue.id } }),
    );
    expect(listed.items.map((a) => a.id)).toEqual([upload.id]);

    const pending = structured<{ id: string }>(
      await client.callTool({
        name: 'upload_attachment',
        arguments: {
          team: 'acme',
          filename: 'img.bin',
          contentBase64: Buffer.from([1, 2, 3]).toString('base64'),
        },
      }),
    );
    const withFile = structured<{ attachments: Array<{ id: string }> }>(
      await client.callTool({
        name: 'add_reply',
        arguments: { item: 'API#1', body: 'see file', attachmentIds: [pending.id] },
      }),
    );
    expect(withFile.attachments.map((a) => a.id)).toEqual([pending.id]);

    const inbox = structured<{ items: Array<{ type: string; url: string }> }>(
      await miaClient.callTool({ name: 'list_notifications', arguments: { unreadOnly: true } }),
    );
    expect(inbox.items.map((n) => n.type)).toEqual(['mention']);
    expect(inbox.items[0]?.url.startsWith(`${ctx.env.baseUrl}/t/acme/p/API/issues/1#reply-`)).toBe(
      true,
    );
    expect(
      structured(
        await miaClient.callTool({ name: 'mark_notifications_read', arguments: { all: true } }),
      ),
    ).toEqual({
      updated: 1,
    });

    expect(
      structured(await miaClient.callTool({ name: 'subscribe', arguments: { item: 'API#1' } })),
    ).toEqual({
      subscribed: true,
    });
    expect(
      structured(await miaClient.callTool({ name: 'unsubscribe', arguments: { item: 'API#1' } })),
    ).toEqual({
      subscribed: false,
    });

    const audit = structured<{ items: Array<{ action: string }>; nextCursor: string | null }>(
      await client.callTool({
        name: 'get_activity',
        arguments: { team: 'acme', action: 'reply.', limit: 10 },
      }),
    );
    expect(audit.items.map((item) => item.action)).toEqual(['reply.created', 'reply.created']);
    const forbidden = await miaClient.callTool({
      name: 'get_activity',
      arguments: { team: 'acme' },
    });
    expect(forbidden.isError).toBe(true);
    expect(JSON.stringify(forbidden.content)).toContain('forbidden');

    const deleted = structured<{ ok: boolean }>(
      await client.callTool({ name: 'delete_attachment', arguments: { attachment: upload.id } }),
    );
    expect(deleted.ok).toBe(true);
  });

  it('returns isError results for bad refs, with no internals', async () => {
    const client = await connect(createApiKey(ctx.db, { userId: owner.id }).key);
    const result = await client.callTool({
      name: 'add_reply',
      arguments: { item: 'NOPE-1', body: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'not_found: Project not found' }]);
    const invalid = await client.callTool({ name: 'list_replies', arguments: {} });
    expect(invalid.isError).toBe(true);
  });
});

describe('MCP transport security', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'x', version: '1' },
    },
  };
  const post = (headers: Record<string, string>) =>
    fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize),
    });

  it('answers 401 with WWW-Authenticate for missing, invalid and revoked keys', async () => {
    const revoked = createApiKey(ctx.db, { userId: owner.id, revokedAt: new Date() });
    const cases: Array<Record<string, string>> = [
      {},
      { Authorization: `Bearer bat_${'z'.repeat(40)}` },
      { Authorization: `Bearer ${revoked.key}` },
    ];
    for (const headers of cases) {
      const res = await post(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('is stateless: GET and DELETE answer 405', async () => {
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${origin}/mcp`, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('rate limits per key', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: owner.id });
    const other = createApiKey(ctx.db, { userId: owner.id });
    // Drain the key's bucket (300/min) without 300 round trips.
    for (let i = 0; i < RATE_LIMITS.mcpPerKey; i += 1) {
      ctx.deps.rateLimiter.consume(`mcp:${apiKey.id}`, {
        max: RATE_LIMITS.mcpPerKey,
        windowMs: 60_000,
      });
    }
    expect((await post({ Authorization: `Bearer ${key}` })).status).toBe(429);
    expect((await post({ Authorization: `Bearer ${other.key}` })).status).toBe(200);
  });

  const rawPost = (key: string, body: string) =>
    fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
      },
      body,
    });

  // Regression (SEC-2): a 100-message batch used to cost one token of the 300/min key limit.
  it('refuses JSON-RPC batches and unparseable bodies', async () => {
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const batch = await rawPost(key, JSON.stringify([initialize, { ...initialize, id: 2 }]));
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    const garbage = await rawPost(key, '{"jsonrpc":');
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: { code: -32700 } });
  });

  // Regression (SEC-5): the SDK's default 4 MiB body limit capped MCP uploads at ~3 MB.
  it('accepts uploads up to MAX_UPLOAD_MB and answers 413 above the body limit', async () => {
    createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const client = await connect(key);
    const text = 'x'.repeat(5 * 1024 * 1024);
    const uploaded = structured<{ size: number }>(
      await client.callTool({
        name: 'upload_attachment',
        arguments: { filename: 'big.txt', text, team: 'acme' },
      }),
    );
    expect(uploaded.size).toBe(text.length);

    const tooLarge = await rawPost(
      key,
      JSON.stringify({
        ...initialize,
        params: { ...initialize.params, pad: 'x'.repeat(mcpMaxBodyBytes(ctx.env)) },
      }),
    );
    expect(tooLarge.status).toBe(413);
  });

  it('counts MCP uploads against the per-user uploads bucket', async () => {
    createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
    const { key } = createApiKey(ctx.db, { userId: owner.id });
    const client = await connect(key);
    for (let i = 0; i < RATE_LIMITS.uploadsPerUser; i += 1) {
      ctx.deps.rateLimiter.consume(`uploads:${owner.id}`, {
        max: RATE_LIMITS.uploadsPerUser,
        windowMs: 60_000,
      });
    }
    const result = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'a.txt', text: 'hi', team: 'acme' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('rate_limited');
  });
});
