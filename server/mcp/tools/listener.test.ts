import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../context';
import * as s from '../../db/schema';
import { createReply } from '../../services/replies';
import {
  addMember,
  agentActor,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  openAgentAccess,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerTools } from './index';

/** The listener tools (design §4) through a real MCP client. */

interface JobOut {
  jobId: string;
  kind: string;
  status: string;
  closing: boolean;
  target: { ref: string | null; url: string | null };
  trigger: { body: string; author: { username: string | null } | null } | null;
  instructions: string;
}

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let task: TaskRow;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  const teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT' });
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Fix it' });
  clients = [];
  // Caden's jobs start Ethan's agent (agent access is tested in agentAccess.test.ts).
  openAgentAccess(ctx.db, ethan.id, teamId);
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow): Promise<{ client: Client; actor: Actor }> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Laptop' });
  const actor = agentActor(ctx.db, user.id, { id: apiKey.id, name: apiKey.name });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, { deps: ctx.deps, actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, actor };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

const say = (body: string) =>
  createReply(
    ctx.deps,
    { userId: caden.id, source: 'web', key: null },
    {
      parentType: 'task',
      parentId: task.id,
      body,
    },
  );

describe('listener tools', () => {
  it('start_listener → complete_job, with list_jobs and the inbox note', async () => {
    const { client } = await connect(ethan);
    say('@ethan-ai please review');
    const inbox = await call<{ items: unknown[]; note: string; pendingJobs: number }>(
      client,
      'list_notifications',
      {},
    );
    expect(inbox).toMatchObject({ items: [], pendingJobs: 1 });
    expect(inbox.note).toMatch(/start_listener/);

    const listened = await call<{ sessionId: string; projects: unknown[]; jobs: JobOut[] }>(
      client,
      'start_listener',
      { projects: ['BAT'], timeoutSeconds: 0 },
    );
    expect(listened.projects).toMatchObject([{ ref: 'baton/BAT' }]);
    expect(listened.jobs).toMatchObject([
      {
        kind: 'mention',
        status: 'claimed',
        target: { ref: 'baton/BAT-1', url: 'http://localhost:4100/t/baton/p/BAT/tasks/1' },
        trigger: { body: '@ethan-ai please review', author: { username: 'caden' } },
      },
    ]);
    const jobId = listened.jobs[0]?.jobId ?? '';
    expect(
      await call<{ jobs: JobOut[] }>(client, 'list_jobs', { status: 'claimed' }),
    ).toMatchObject({ jobs: [{ jobId }] });

    // Replying (closing the exchange) and completing the job.
    const replied = await call<{ closing?: boolean }>(client, 'add_reply', {
      item: 'BAT-1',
      body: 'Looks good',
      closing: true,
    });
    expect(replied.closing).toBe(true);
    expect(await call<JobOut>(client, 'complete_job', { jobId })).toMatchObject({ status: 'done' });
    const again = await call<{ jobs: JobOut[]; sessionId: string }>(client, 'start_listener', {
      projects: ['BAT'],
      timeoutSeconds: 0,
      sessionId: listened.sessionId,
    });
    expect(again).toMatchObject({ sessionId: listened.sessionId, jobs: [] });
  });

  it('release_job hands a job back; errors are clear', async () => {
    const { client } = await connect(ethan);
    say('@ethan-ai one');
    const { jobs } = await call<{ jobs: JobOut[] }>(client, 'start_listener', {
      projects: ['BAT'],
      timeoutSeconds: 0,
    });
    const jobId = jobs[0]?.jobId ?? '';
    expect(await call<JobOut>(client, 'release_job', { jobId })).toMatchObject({
      status: 'pending',
    });
    expect(await callError(client, 'complete_job', { jobId, agreeDone: true })).toMatch(
      /^validation_failed: agreeDone/,
    );
    expect(await callError(client, 'start_listener', { projects: ['NOPE'] })).toMatch(/^not_found/);
    expect(await callError(client, 'complete_job', { jobId: 'nope' })).toMatch(/^not_found: Job/);

    ctx.db.orm
      .update(s.user)
      .set({ agentPausedAt: new Date() })
      .where(eq(s.user.id, ethan.id))
      .run();
    expect(
      await callError(client, 'start_listener', { projects: ['BAT'], timeoutSeconds: 0 }),
    ).toMatch(/^agents_paused: Ethan paused this agent/);
  });

  it('start_listener waits for the first job', async () => {
    const { client } = await connect(ethan);
    const waiting = call<{ jobs: JobOut[] }>(client, 'start_listener', {
      projects: ['BAT'],
      timeoutSeconds: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    say('@ethan-ai now');
    expect((await waiting).jobs).toMatchObject([{ trigger: { body: '@ethan-ai now' } }]);
  });

  it('wait_for_mentions still works, as a deprecated alias', async () => {
    const { client } = await connect(ethan);
    say('@ethan-ai old client');
    const result = await call<{ deprecated: string; mentions: Array<{ reply: { body: string } }> }>(
      client,
      'wait_for_mentions',
      { timeoutSeconds: 0 },
    );
    expect(result.deprecated).toMatch(/start_listener/);
    expect(result.mentions.map((m) => m.reply.body)).toEqual(['@ethan-ai old client']);
  });
});
