import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHandle, agentNameFromClient } from '@shared/agents';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { waitForMentions } from './agentMentions';
import { recordKeyAgent } from './apiKeys';
import { listNotifications } from './notifications';
import { createReply, editReply } from './replies';
import { getViaKeys } from './users';

/** BAT-6: agent identity on writes, agent writes in the owner's inbox, and @agent mentions. */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let task: TaskRow;
let claude: Actor;
let codex: Actor;
let cadenWeb: Actor;

function agentActor(user: UserRow, keyName: string, agentName: string): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  recordKeyAgent(ctx.deps, apiKey.id, agentName);
  return { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: keyName, agentName } };
}

const reply = (actor: Actor, body: string) =>
  createReply(ctx.deps, actor, { parentType: 'task', parentId: task.id, body });

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan' });
  caden = createUser(ctx.db, { username: 'caden' });
  const team = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team;
  addMember(ctx.db, { teamId: team.id, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId: team.id, key: 'BAT', createdById: ethan.id });
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Agent replies' });
  claude = agentActor(ethan, 'MSI', 'Claude');
  codex = agentActor(ethan, 'Laptop', 'Codex');
  cadenWeb = { userId: caden.id, source: 'web', key: null };
});

afterEach(() => {
  ctx.close();
});

describe('agent names', () => {
  it('names well-known MCP clients and keeps other names', () => {
    expect(agentNameFromClient({ name: 'claude-code' })).toBe('Claude');
    expect(agentNameFromClient({ name: 'codex-mcp-client' })).toBe('Codex');
    expect(agentNameFromClient({ name: 'my-bot', title: 'Release Bot' })).toBe('Release Bot');
    expect(agentNameFromClient({})).toBeNull();
    expect(agentHandle('Release Bot')).toBe('releasebot');
  });

  it('learns the agent from the MCP initialize handshake and shows it on writes', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    const res = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: {
        ...bearer(key),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '2.1.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const row = ctx.db.orm.select().from(s.apiKey).where(eq(s.apiKey.id, apiKey.id)).get();
    expect(row?.agentName).toBe('Claude');
    expect(getViaKeys(ctx.db.orm, [apiKey.id]).get(apiKey.id)).toEqual({
      keyId: apiKey.id,
      keyName: 'Desktop',
      agentName: 'Claude',
    });
  });
});

describe('agent writes in the owner’s inbox', () => {
  it('notifies the key’s owner of their agent’s reply, but not of their own web reply', () => {
    reply({ userId: ethan.id, source: 'web', key: null }, 'Subscribing myself');
    const ethanWeb: Actor = { userId: ethan.id, source: 'web', key: null };
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([]);

    reply(claude, 'I found the cause.');
    const inbox = listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items;
    expect(inbox).toEqual([
      expect.objectContaining({ type: 'reply', viaKeyName: 'MSI', viaAgentName: 'Claude' }),
    ]);
  });
});

describe('@agent mentions', () => {
  it('reaches only agents of the mentioned kind that took part in the thread', async () => {
    reply(claude, 'Looking into it.');
    const outsider = agentActor(caden, 'Caden PC', 'Claude');
    reply(cadenWeb, '@claude @codex can you check the tests?');

    const mine = await waitForMentions(ctx.deps, claude, { timeoutSeconds: 0 });
    expect(mine.mentions.map((m) => m.reply.body)).toEqual([
      '@claude @codex can you check the tests?',
    ]);
    expect(mine.mentions[0]).toMatchObject({ parentType: 'task', reply: { ref: 'BAT-1' } });
    // Delivered once.
    expect((await waitForMentions(ctx.deps, claude, { timeoutSeconds: 0 })).mentions).toEqual([]);
    // Codex never replied here, and Caden's Claude never took part.
    expect((await waitForMentions(ctx.deps, codex, { timeoutSeconds: 0 })).mentions).toEqual([]);
    expect((await waitForMentions(ctx.deps, outsider, { timeoutSeconds: 0 })).mentions).toEqual([]);
  });

  it('counts the key that created the item, ignores self-mentions and re-edits', async () => {
    ctx.db.orm.update(s.task).set({ viaKeyId: codex.key?.id }).where(eq(s.task.id, task.id)).run();
    reply(codex, '@codex note to self');
    expect((await waitForMentions(ctx.deps, codex, { timeoutSeconds: 0 })).mentions).toEqual([]);

    const posted = reply(cadenWeb, 'Thanks');
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @codex' });
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @codex!' });
    const { mentions } = await waitForMentions(ctx.deps, codex, { timeoutSeconds: 0 });
    expect(mentions.map((m) => m.reply.id)).toEqual([posted.id]);
  });

  it('waits for the next mention', async () => {
    reply(claude, 'Standing by.');
    const pending = waitForMentions(ctx.deps, claude, { timeoutSeconds: 5 });
    reply(cadenWeb, 'No mention here');
    reply(cadenWeb, '@claude your turn');
    const { mentions } = await pending;
    expect(mentions.map((m) => m.reply.body)).toEqual(['@claude your turn']);
  });

  it('stops waiting when the request goes away', async () => {
    const controller = new AbortController();
    const pending = waitForMentions(ctx.deps, claude, { timeoutSeconds: 60 }, controller.signal);
    controller.abort();
    expect((await pending).mentions).toEqual([]);
  });

  it('needs a key whose agent is known', async () => {
    const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Script' });
    const script: Actor = {
      userId: ethan.id,
      source: 'api',
      key: { id: apiKey.id, name: 'Script' },
    };
    await expect(waitForMentions(ctx.deps, script, { timeoutSeconds: 0 })).rejects.toThrow(
      /no agent name/,
    );
  });
});
