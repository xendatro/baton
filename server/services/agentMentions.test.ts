import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHandle, agentNameFromClient } from '@shared/agents';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
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

/**
 * BAT-6 agent identity on writes, and mentions of agent members (agents A): `@ethan-ai` is a
 * username mention of Ethan's agent, queued for every active key of Ethan's until
 * `wait_for_mentions` collects it.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let task: TaskRow;
let teamId: string;
/** Ethan's agent through his "MSI" key (Claude) and his "Laptop" key (Codex). */
let claude: Actor;
let codex: Actor;
let cadenWeb: Actor;
let ethanWeb: Actor;

function keyActor(user: UserRow, keyName: string, agentName: string): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  recordKeyAgent(ctx.deps, apiKey.id, agentName);
  return agentActor(ctx.db, user.id, { id: apiKey.id, name: keyName, agentName });
}

const reply = (actor: Actor, body: string) =>
  createReply(ctx.deps, actor, { parentType: 'task', parentId: task.id, body });

const pending = async (actor: Actor) =>
  (await waitForMentions(ctx.deps, actor, { timeoutSeconds: 0 })).mentions.map(
    (mention) => mention.reply.body,
  );

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Agent replies' });
  claude = keyActor(ethan, 'MSI', 'Claude');
  codex = keyActor(ethan, 'Laptop', 'Codex');
  cadenWeb = { userId: caden.id, source: 'web', key: null };
  ethanWeb = { userId: ethan.id, source: 'web', key: null };
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

describe('agent writes', () => {
  it('are authored by the agent member, named after the key and its harness', () => {
    const written = reply(claude, 'I found the cause.');
    expect(written.author).toMatchObject({
      username: 'ethan-ai',
      name: 'Ethan AI',
      kind: 'agent',
      agentOwner: { id: ethan.id, username: 'ethan' },
    });
    expect(written.via).toMatchObject({ keyName: 'MSI', agentName: 'Claude' });
  });

  it('reach the owner only as far as their agent notifications say (needs_me by default)', () => {
    reply(ethanWeb, 'Subscribing myself');
    reply(claude, 'I found the cause.');
    // A reply on a thread Ethan follows is nothing he needs to hear from his own agent…
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([]);
    // …but a mention of him is.
    reply(claude, '@ethan the fix needs your review');
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([
      expect.objectContaining({
        type: 'mention',
        actor: expect.objectContaining({ username: 'ethan-ai' }) as unknown,
        viaKeyName: 'MSI',
        viaAgentName: 'Claude',
      }),
    ]);
  });
});

describe('mentions of agent members', () => {
  it('queue a reply mentioning @ethan-ai for every key of Ethan, once each', async () => {
    const outsider = keyActor(caden, 'Caden PC', 'Claude');
    reply(cadenWeb, '@ethan-ai can you check the tests?');

    expect(await pending(claude)).toEqual(['@ethan-ai can you check the tests?']);
    const mentions = await waitForMentions(ctx.deps, codex, { timeoutSeconds: 0 });
    expect(mentions.mentions[0]).toMatchObject({
      parentType: 'task',
      reply: { ref: 'BAT-1', author: { username: 'caden' } },
    });
    // Delivered once per key.
    expect(await pending(claude)).toEqual([]);
    // Caden's agent wasn't mentioned; `@claude`-style handles no longer reach anyone.
    reply(cadenWeb, '@claude @codex anyone?');
    expect(await pending(outsider)).toEqual([]);
    expect(await pending(claude)).toEqual([]);
  });

  it('ignore self-mentions, re-edits, revoked keys and agents outside the team', async () => {
    reply(claude, '@ethan-ai note to self');
    expect(await pending(codex)).toEqual([]);

    const posted = reply(cadenWeb, 'Thanks');
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @ethan-ai' });
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @ethan-ai!' });
    expect(await pending(codex)).toEqual(['Thanks @ethan-ai!']);

    ctx.db.orm
      .update(s.apiKey)
      .set({ revokedAt: new Date() })
      .where(eq(s.apiKey.id, codex.key?.id ?? ''))
      .run();
    const queuedFor = () =>
      ctx.db.orm
        .select()
        .from(s.agentMention)
        .all()
        .filter((row) => row.keyId === codex.key?.id).length;
    expect(queuedFor()).toBe(1);
    reply(cadenWeb, '@ethan-ai one more');
    expect(queuedFor()).toBe(1);
    expect(await pending(claude)).toEqual(['Thanks @ethan-ai!', '@ethan-ai one more']);

    // An agent removed from the team is not queued.
    ctx.db.orm.delete(s.teamMember).where(eq(s.teamMember.userId, claude.userId)).run();
    reply(cadenWeb, '@ethan-ai are you there?');
    expect(ctx.db.orm.select().from(s.agentMention).all()).toHaveLength(3);
  });

  it('do not wake a paused agent', async () => {
    ctx.db.orm
      .update(s.user)
      .set({ agentPausedAt: new Date() })
      .where(eq(s.user.id, ethan.id))
      .run();
    reply(cadenWeb, '@ethan-ai while you were paused');
    ctx.db.orm.update(s.user).set({ agentPausedAt: null }).where(eq(s.user.id, ethan.id)).run();
    ctx.db.orm
      .update(s.team)
      .set({ agentsPausedAt: new Date() })
      .where(eq(s.team.id, teamId))
      .run();
    reply(cadenWeb, '@ethan-ai while the team paused agents');
    expect(await pending(claude)).toEqual([]);
  });

  it('waits for the next mention', async () => {
    const waiting = waitForMentions(ctx.deps, claude, { timeoutSeconds: 5 });
    reply(cadenWeb, 'No mention here');
    reply(cadenWeb, '@ethan-ai your turn');
    const { mentions } = await waiting;
    expect(mentions.map((m) => m.reply.body)).toEqual(['@ethan-ai your turn']);
  });

  it('stops waiting when the request goes away', async () => {
    const controller = new AbortController();
    const waiting = waitForMentions(ctx.deps, claude, { timeoutSeconds: 60 }, controller.signal);
    controller.abort();
    expect((await waiting).mentions).toEqual([]);
  });

  it('are collected through an API key, whatever its harness', async () => {
    const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Script' });
    const script = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Script' }, 'api');
    reply(cadenWeb, '@ethan-ai ping');
    expect(await pending(script)).toEqual(['@ethan-ai ping']);
    await expect(waitForMentions(ctx.deps, ethanWeb, { timeoutSeconds: 0 })).rejects.toThrow(
      /API key/,
    );
  });
});
