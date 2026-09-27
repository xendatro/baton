import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardResponse, MyTask } from '@shared/schemas/work';
import * as s from '../../db/schema';
import {
  addMember,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerTools } from './index';
import { workTools } from './work';

let ctx: TestContext;
let owner: UserRow;
let ada: UserRow;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  owner = createUser(ctx.db, { username: 'owner' });
  ada = createUser(ctx.db, { username: 'ada' });
  clients = [];

  for (const [slug, key] of [
    ['acme', 'WEB'],
    ['side', 'API'],
  ] as const) {
    const teamId = createTeam(ctx.db, { ownerId: owner.id, slug }).team.id;
    addMember(ctx.db, { teamId, userId: ada.id });
    const { project } = createProject(ctx.db, { teamId, key });
    for (const [title, priority] of [
      [`${key} urgent`, 4],
      [`${key} low`, 1],
    ] as const) {
      const task = createTask(ctx.db, { project, title });
      ctx.db.orm.update(s.task).set({ priority }).where(eq(s.task.id, task.id)).run();
      ctx.db.orm
        .insert(s.taskAssigneeUser)
        .values({ taskId: task.id, statusId: task.statusId, userId: ada.id })
        .run();
    }
  }
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
    workTools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
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

describe('work MCP tools', () => {
  it('describes both tools and every input field for agents', async () => {
    const client = await connect(ada);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['dashboard_summary', 'my_tasks']);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.annotations?.readOnlyHint).toBe(true);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }
  });

  it('my_tasks lists my tasks across teams with absolute URLs, filters and a limit', async () => {
    const client = await connect(ada);
    const all = await call<{ total: number; returned: number; tasks: MyTask[] }>(
      client,
      'my_tasks',
      {},
    );
    expect(all.total).toBe(4);
    // Highest priority first.
    expect(all.tasks.map((task) => task.priority)).toEqual([4, 4, 1, 1]);
    expect(all.tasks[0]?.url).toMatch(
      /^http:\/\/localhost:4100\/t\/(acme|side)\/p\/[A-Z]+\/tasks\/\d+$/,
    );

    const side = await call<{ tasks: MyTask[] }>(client, 'my_tasks', { team: 'side' });
    expect(side.tasks.map((task) => task.title).sort()).toEqual(['API low', 'API urgent']);

    const urgentWeb = await call<{ tasks: MyTask[] }>(client, 'my_tasks', {
      project: 'acme/WEB',
      priority: ['urgent'],
    });
    expect(urgentWeb.tasks.map((task) => task.title)).toEqual(['WEB urgent']);

    const limited = await call<{ total: number; returned: number }>(client, 'my_tasks', {
      limit: 1,
    });
    expect(limited).toMatchObject({ total: 4, returned: 1 });

    const byRef = await call<{ tasks: MyTask[] }>(client, 'my_tasks', { query: 'API-2' });
    expect(byRef.tasks.map((task) => task.title)).toEqual(['API low']);
  });

  it('my_tasks reports unknown teams and bad dates as errors', async () => {
    const client = await connect(ada);
    expect(await callError(client, 'my_tasks', { team: 'nowhere' })).toMatch(/not found/i);
    expect(await callError(client, 'my_tasks', { today: '2026-13-01' })).toBeTruthy();
  });

  it('dashboard_summary returns counts, lists and teams with absolute URLs', async () => {
    const client = await connect(ada);
    const dashboard = await call<DashboardResponse>(client, 'dashboard_summary', {
      today: '2026-03-10',
    });
    expect(dashboard.today).toBe('2026-03-10');
    expect(dashboard.counts).toEqual({ assigned: 4, overdue: 0, dueSoon: 0, claimed: 0 });
    expect(dashboard.assigned).toHaveLength(4);
    expect(dashboard.assigned[0]?.url.startsWith('http://localhost:4100/t/')).toBe(true);
    expect(dashboard.teams.map((team) => team.url)).toEqual([
      'http://localhost:4100/t/acme',
      'http://localhost:4100/t/side',
    ]);
    expect(dashboard.teams[0]?.projects[0]?.url).toBe('http://localhost:4100/t/acme/p/WEB');
  });
});
