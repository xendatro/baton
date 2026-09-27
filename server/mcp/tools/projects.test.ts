import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../../db/schema';
import {
  addMember,
  createApiKey,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerTools } from './index';
import { projectsTools } from './projects';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let teamId: string;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: member.id });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Codex desktop' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
    },
    projectsTools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

describe('project MCP tools', () => {
  it('describes every tool and field for agents', async () => {
    const client = await connect(owner);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'create_label',
        'create_pipeline',
        'create_project',
        'create_status',
        'delete_label',
        'delete_pipeline',
        'delete_project',
        'delete_status',
        'get_project',
        'list_labels',
        'list_pipelines',
        'list_projects',
        'list_statuses',
        'reorder_statuses',
        'restore_project',
        'update_label',
        'update_pipeline',
        'update_project',
        'update_status',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }
  });

  it('names the first pipeline of a new project ("Main" without one)', async () => {
    const client = await connect(owner);
    const named = await call<{ pipelines: Array<{ name: string }> }>(client, 'create_project', {
      team: 'acme',
      name: 'Game',
      pipeline: 'Modeling',
    });
    expect(named.pipelines.map((pipeline) => pipeline.name)).toEqual(['Modeling']);
    const unnamed = await call<{ pipelines: Array<{ name: string }> }>(client, 'create_project', {
      team: 'acme',
      name: 'Docs',
    });
    expect(unnamed.pipelines.map((pipeline) => pipeline.name)).toEqual(['Main']);
  });

  it('runs the project lifecycle: create, read, update key, delete, restore', async () => {
    const client = await connect(owner);
    const created = await call<{ key: string; ref: string; url: string; statuses: unknown[] }>(
      client,
      'create_project',
      { team: 'acme', name: 'Mobile app', description: 'iOS and Android', icon: '📱' },
    );
    expect(created).toMatchObject({
      key: 'MA',
      ref: 'acme/MA',
      url: `${ctx.env.baseUrl}/t/acme/p/MA`,
    });
    expect(created).not.toHaveProperty('path');
    expect(created.statuses).toHaveLength(5);

    const listed = await call<{ projects: Array<{ key: string; url: string }> }>(
      client,
      'list_projects',
      {},
    );
    expect(listed.projects.map((project) => project.key)).toEqual(['MA']);
    expect((await call(client, 'list_projects', { team: 'acme' })).projects).toHaveLength(1);

    const updated = await call<{ key: string; keyAliases: string[]; readme: string }>(
      client,
      'update_project',
      { project: 'MA', key: 'APP', readme: '# Mobile\n\nShip it.' },
    );
    expect(updated).toMatchObject({
      key: 'APP',
      keyAliases: ['MA'],
      readme: '# Mobile\n\nShip it.',
    });
    // The old key still resolves.
    expect(await call(client, 'get_project', { project: 'acme/MA' })).toMatchObject({ key: 'APP' });

    const activity = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'project.updated'))
      .get();
    expect(activity).toMatchObject({ source: 'mcp', viaKeyName: 'Codex desktop' });

    expect(await call(client, 'delete_project', { project: 'APP' })).toMatchObject({
      ok: true,
      deleted: { key: 'APP', name: 'Mobile app' },
    });
    expect(await callError(client, 'get_project', { project: 'APP' })).toMatch(/not_found/);
    expect(await call(client, 'restore_project', { project: 'acme/APP' })).toMatchObject({
      key: 'APP',
    });
  });

  it('validates input with the shared schemas and reports permission errors', async () => {
    const owners = await connect(owner);
    expect(
      await callError(owners, 'create_project', { team: 'acme', name: 'X', key: '1bad' }),
    ).toMatch(/validation_failed: key/);
    expect(await callError(owners, 'update_project', { project: 'nope', name: 'x' })).toMatch(
      /not_found: Project not found/,
    );

    await call(owners, 'create_project', { team: 'acme', name: 'Docs' });
    const members = await connect(member);
    expect(await callError(members, 'update_project', { project: 'DOC', name: 'x' })).toMatch(
      /forbidden/,
    );
    expect(await callError(members, 'create_status', { project: 'DOC', name: 'Doing' })).toMatch(
      /forbidden/,
    );
  });

  it('manages statuses by name', async () => {
    const client = await connect(owner);
    const project = await call<{ id: string }>(client, 'create_project', {
      team: 'acme',
      name: 'API',
    });
    const projectRow = ctx.db.orm
      .select()
      .from(s.project)
      .where(eq(s.project.id, project.id))
      .get();
    if (!projectRow) throw new Error('missing project');
    const task = createTask(ctx.db, { project: projectRow });

    await call(client, 'create_status', { project: 'API', name: 'QA' });
    expect(
      await callError(client, 'create_status', { project: 'API', name: 'In progress' }),
    ).toMatch(/already a status/);
    await call(client, 'create_status', {
      project: 'API',
      name: 'Review',
      color: '#8b5cf6',
      isDefault: true,
    });
    const renamed = await call(client, 'update_status', {
      project: 'API',
      status: 'in progress',
      name: 'Doing',
    });
    expect(renamed).toMatchObject({ name: 'Doing', icon: 'half-circle' });

    const order = ['Review', 'Backlog', 'To do', 'Doing', 'In review', 'QA', 'Done'];
    const reordered = await call<{ statuses: Array<{ name: string; isDefault: boolean }> }>(
      client,
      'reorder_statuses',
      { project: 'API', statuses: order },
    );
    expect(reordered.statuses.map((status) => status.name)).toEqual(order);
    expect(reordered.statuses.find((status) => status.isDefault)?.name).toBe('Review');

    const deleted = await call(client, 'delete_status', {
      project: 'API',
      status: 'Backlog',
      moveTo: 'Done',
    });
    expect(deleted).toEqual({ ok: true, movedTasks: 1, deleted: 'Backlog', movedTo: 'Done' });
    const moved = ctx.db.orm.select().from(s.task).where(eq(s.task.id, task.id)).get();
    expect(moved?.completedAt).toBeInstanceOf(Date);

    const listed = await call<{ statuses: Array<{ name: string; taskCount: number }> }>(
      client,
      'list_statuses',
      { project: 'API' },
    );
    expect(listed.statuses.map((status) => [status.name, status.taskCount])).toEqual([
      ['Review', 0],
      ['To do', 0],
      ['Doing', 0],
      ['In review', 0],
      ['QA', 0],
      ['Done', 1],
    ]);
    expect(
      await callError(client, 'delete_status', { project: 'API', status: 'Nope', moveTo: 'Done' }),
    ).toMatch(/Status not found/);
  });

  it('manages labels by name', async () => {
    const client = await connect(member);
    const ownerClient = await connect(owner);
    await call(ownerClient, 'create_project', { team: 'acme', name: 'Web', key: 'WEB' });

    const created = await call(client, 'create_label', {
      project: 'WEB',
      name: 'bug',
      color: '#ef4444',
      description: 'Something is broken',
    });
    expect(created).toMatchObject({ name: 'bug', color: '#ef4444', issueCount: 0 });
    expect(
      await call(client, 'update_label', { project: 'WEB', label: 'BUG', name: 'defect' }),
    ).toMatchObject({ name: 'defect' });
    expect(
      (await call<{ labels: Array<{ name: string }> }>(client, 'list_labels', { project: 'WEB' }))
        .labels,
    ).toMatchObject([{ name: 'defect' }]);
    expect(await call(client, 'delete_label', { project: 'WEB', label: 'defect' })).toEqual({
      ok: true,
      removedFrom: { issues: 0, tasks: 0 },
      deleted: 'defect',
    });
  });
});
