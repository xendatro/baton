import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReactionSummary } from '@shared/schemas/core';
import * as s from '../../db/schema';
import { createReply } from '../../services/replies';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { coreTools } from './core';
import { registerTools } from './index';

let ctx: TestContext;
let owner: UserRow;
let ada: UserRow;
let client: Client;

interface ReactionResult {
  targetType: string;
  targetId: string;
  ref: string;
  url: string;
  reactions: ReactionSummary[];
}

beforeEach(async () => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  owner = createUser(ctx.db, { username: 'owner' });
  ada = createUser(ctx.db, { username: 'ada', name: 'Ada' });
  const teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: ada.id });
  createProject(ctx.db, { teamId, key: 'WEB' });

  const { apiKey } = createApiKey(ctx.db, { userId: ada.id, name: 'MSI' });
  ctx.db.orm.update(s.apiKey).set({ agentName: 'Claude' }).where(eq(s.apiKey.id, apiKey.id)).run();
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: ada.id, source: 'mcp', key: { id: apiKey.id, name: 'MSI' } },
    },
    coreTools,
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

async function call(name: string, args: Record<string, unknown>): Promise<ReactionResult> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as ReactionResult;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

function project() {
  const row = ctx.db.orm.select().from(s.project).get();
  if (!row) throw new Error('no project');
  return row;
}

describe('reaction MCP tools', () => {
  it('reacts to a task by ref, attributed to the agent via the key, and removes it', async () => {
    const task = createTask(ctx.db, { project: project(), authorId: owner.id });
    const added = await call('add_reaction', { target: 'WEB-1', emoji: '👍' });
    expect(added).toMatchObject({
      targetType: 'task',
      targetId: task.id,
      ref: 'acme/WEB-1',
      url: 'http://localhost:4100/t/acme/p/WEB/tasks/1',
    });
    expect(added.reactions).toEqual([
      {
        emoji: '👍',
        count: 1,
        reactedByMe: true,
        users: [
          expect.objectContaining({
            id: ada.id,
            name: 'Ada',
            via: { keyId: expect.any(String) as string, keyName: 'MSI', agentName: 'Claude' },
          }),
        ],
      },
    ]);

    const removed = await call('remove_reaction', { target: 'acme/WEB-1', emoji: '👍' });
    expect(removed.reactions).toEqual([]);
  });

  it('reacts to issues by ref and to replies by id', async () => {
    const issue = createIssue(ctx.db, { project: project(), authorId: owner.id });
    const reply = createReply(
      ctx.deps,
      { userId: owner.id, source: 'web', key: null },
      { parentType: 'issue', parentId: issue.id, body: 'Thoughts?' },
    );

    const onIssue = await call('add_reaction', { target: 'WEB#1', emoji: '🎉' });
    expect(onIssue).toMatchObject({ targetType: 'issue', targetId: issue.id, ref: 'acme/WEB#1' });

    const onReply = await call('add_reaction', { target: reply.id, emoji: '👀' });
    expect(onReply).toMatchObject({
      targetType: 'reply',
      targetId: reply.id,
      ref: 'acme/WEB#1',
      url: `http://localhost:4100/t/acme/p/WEB/issues/1#reply-${reply.id}`,
    });
    expect(onReply.reactions).toEqual([expect.objectContaining({ emoji: '👀', count: 1 })]);
  });

  it('explains invalid emoji and unknown targets', async () => {
    createTask(ctx.db, { project: project(), authorId: owner.id });
    expect(await callError('add_reaction', { target: 'WEB-1', emoji: 'thumbs up' })).toMatch(
      /emoji/i,
    );
    expect(await callError('add_reaction', { target: 'WEB-99', emoji: '👍' })).toMatch(
      /not found/i,
    );
  });
});
