import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../../db/schema';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  openAgentAccess,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerRunner } from '../../services/agentRunner';
import { createTask } from '../../services/tasks';
import { coreTools } from './core';
import { registerTools } from './index';
import { projectsTools } from './projects';
import { tasksTools } from './tasks';

/**
 * Direct model choice (difficulty removed, 2026-09-29): suggesting a model with a reply (REST and
 * MCP `add_reply`), a stage's suggested model (MCP `update_status`), the models a requester can
 * suggest, and what is gone (difficulty endpoints and tool parameters).
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let teamId: string;
let project: CreatedProject;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  project = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude on laptop' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
    },
    [...coreTools, ...tasksTools, ...projectsTools],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

type Json = Record<string, unknown>;

async function call<T = Json>(client: Client, name: string, args: Json): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function jobsOf(agentId: string) {
  return ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.agentUserId, agentId)).all();
}

/** Ethan's agent member (created with his first key). */
function ethanAgent() {
  const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
  return agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' }, 'api');
}

describe('suggesting a model', () => {
  it('stores a reply’s suggestion on the jobs it starts (REST)', async () => {
    const agent = ethanAgent();
    openAgentAccess(ctx.db, ethan.id, teamId);
    const task = createTask(
      ctx.deps,
      { userId: caden.id, source: 'web', key: null },
      project.project.id,
      {
        title: 'Plan it',
      },
    );
    const { key } = createApiKey(ctx.db, { userId: caden.id, name: 'Script' });
    const res = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        {
          parentType: 'task',
          parentId: task.id,
          body: 'Please plan this @ethan-ai',
          suggestedModel: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
        },
        bearer(key),
      ),
    );
    expect(res.status).toBe(201);
    const [job] = jobsOf(agent.userId);
    // Written through Caden's key, the reply (and so the suggestion) is his agent's.
    const reply = ctx.db.orm.select().from(s.reply).where(eq(s.reply.parentId, task.id)).get();
    expect(reply?.suggestedModel).toEqual({ harness: 'codex', model: 'gpt-6-sol', effort: 'high' });
    expect(job?.payload).toMatchObject({
      suggestedModel: { harness: 'codex', model: 'gpt-6-sol', effort: 'high' },
      suggestedById: reply?.authorId,
    });
  });

  it('takes suggestModel on add_reply, and a stage’s suggestedModel on update_status', async () => {
    const agent = ethanAgent();
    openAgentAccess(ctx.db, ethan.id, teamId);
    createTask(ctx.deps, { userId: ethan.id, source: 'web', key: null }, project.project.id, {
      title: 'Plan it',
    });
    const client = await connect(caden);
    await call(client, 'add_reply', {
      item: 'BAT-1',
      body: 'Go @ethan-ai',
      suggestModel: { harness: 'claude', model: 'opus' },
    });
    expect(jobsOf(agent.userId)[0]?.payload.suggestedModel).toEqual({
      harness: 'claude',
      model: 'opus',
      effort: '',
    });

    const owner = await connect(ethan);
    const updated = await call<{ rules: Json }>(owner, 'update_status', {
      project: 'BAT',
      status: 'Open',
      suggestedModel: { harness: 'claude', model: 'opus', effort: 'high' },
    });
    expect(updated.rules.suggestedModel).toEqual({
      harness: 'claude',
      model: 'opus',
      effort: 'high',
    });
    const cleared = await call<{ rules: Json }>(owner, 'update_status', {
      project: 'BAT',
      status: 'Open',
      suggestedModel: null,
    });
    expect(cleared.rules.suggestedModel).toBeNull();
  });

  it('lists what the team’s computers report, without machine names, to members only', async () => {
    const agent = ethanAgent();
    registerRunner(ctx.deps, agent, {
      machineId: 'machine-msi-1',
      machineName: 'MSI',
      harnesses: [
        {
          id: 'codex',
          version: '1.0.0',
          models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['high'] }],
          efforts: ['high'],
        },
      ],
      projectIds: [project.project.id],
    });
    const { key } = createApiKey(ctx.db, { userId: caden.id, name: 'Script' });
    const res = await ctx.app.request(`/api/projects/${project.project.id}/suggestable-models`, {
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      harnesses: [
        {
          id: 'codex',
          machines: [],
          models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['high'] }],
        },
      ],
    });
    const outsider = createUser(ctx.db, { username: 'zed' });
    const denied = await ctx.app.request(`/api/projects/${project.project.id}/suggestable-models`, {
      headers: bearer(createApiKey(ctx.db, { userId: outsider.id, name: 'X' }).key),
    });
    expect(denied.status).toBe(404);
  });
});

describe('difficulty is gone', () => {
  it('has no difficulty endpoints, fields or tool parameters', async () => {
    const { key } = createApiKey(ctx.db, { userId: ethan.id, name: 'Script' });
    const levels = await ctx.app.request(`/api/projects/${project.project.id}/difficulties`, {
      headers: bearer(key),
    });
    expect(levels.status).toBe(404);
    // New projects get no levels.
    expect(
      ctx.db.orm
        .select()
        .from(s.difficulty)
        .where(eq(s.difficulty.projectId, project.project.id))
        .all(),
    ).toEqual([]);
    // REST ignores a difficulty sent by an older client.
    const created = await ctx.app.request(
      `/api/projects/${project.project.id}/tasks`,
      json(
        'POST',
        { title: 'Old client', difficultyId: '01J0000000000000000000000A' },
        bearer(key),
      ),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).not.toHaveProperty('difficulty');
    // MCP refuses it (unknown arguments are refused).
    const client = await connect(ethan);
    const result = await client.callTool({
      name: 'create_task',
      arguments: { project: 'BAT', title: 'Hard one', difficulty: 'Hard' },
    });
    expect(result.isError).toBe(true);
  });
});
