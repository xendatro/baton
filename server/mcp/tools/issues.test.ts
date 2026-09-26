import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../../db/schema';
import {
  addMember,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type ProjectRow,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerTools } from './index';
import { issuesTools } from './issues';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let teamId: string;
let project: ProjectRow;
let projectId: string;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: member.id });
  project = createProject(ctx.db, { teamId, key: 'API' }).project;
  projectId = project.id;
  for (const name of ['Bug', 'UI', 'Docs']) {
    ctx.db.orm.insert(s.label).values({ projectId, name, color: '#ef4444' }).run();
  }
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
    issuesTools,
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

interface AgentIssue {
  id: string;
  ref: string;
  title: string;
  url: string;
  resolved: boolean;
  labels: Array<{ name: string }>;
  via: { keyName: string } | null;
}

describe('issue MCP tools', () => {
  it('describes every tool and field for agents', async () => {
    const client = await connect(owner);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        'create_issue',
        'delete_issue',
        'get_issue',
        'list_issues',
        'reopen_issue',
        'resolve_issue',
        'restore_issue',
        'update_issue',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it('opens, reads, lists, labels, resolves, deletes and restores issues by ref', async () => {
    const client = await connect(member);
    const created = await call<AgentIssue>(client, 'create_issue', {
      project: 'API',
      title: 'Login fails on Safari',
      body: 'Steps: open /login in Safari 17',
      labels: ['bug'],
    });
    expect(created).toMatchObject({
      ref: 'acme/API#1',
      url: `${ctx.env.baseUrl}/t/acme/p/API/issues/1`,
      via: { keyName: 'Claude on laptop' },
      labels: [{ name: 'Bug' }],
    });
    expect(created).not.toHaveProperty('path');

    await call(client, 'update_issue', {
      issue: 'acme/API#1',
      addLabels: ['UI'],
      title: 'Login fails on Safari 17',
    });
    const listed = await call<{ issues: AgentIssue[]; counts: { open: number } }>(
      client,
      'list_issues',
      { project: 'acme/API', labels: ['bug', 'ui'], labelMatch: 'all', author: 'mia' },
    );
    expect(listed.issues.map((issue) => issue.title)).toEqual(['Login fails on Safari 17']);
    expect(listed.counts.open).toBe(1);
    expect(
      (await call<{ issues: AgentIssue[] }>(client, 'list_issues', { project: 'API', q: 'safari' }))
        .issues,
    ).toHaveLength(1);

    const resolved = await call<AgentIssue>(client, 'resolve_issue', { issue: 'API#1' });
    expect(resolved.resolved).toBe(true);
    expect(
      (await call<{ issues: AgentIssue[] }>(client, 'list_issues', { project: 'API' })).issues,
    ).toHaveLength(0);
    expect((await call<AgentIssue>(client, 'reopen_issue', { issue: created.id })).resolved).toBe(
      false,
    );

    const task = createTask(ctx.db, { project, title: 'Fix' });
    ctx.db.orm
      .insert(s.taskIssueLink)
      .values({ taskId: task.id, issueId: created.id, kind: 'fixes' })
      .run();
    const detail = await call<{
      replies: unknown[];
      history: Array<{ action: string; via: string | null }>;
      linkedTasks: Array<{ ref: string; url: string }>;
    }>(client, 'get_issue', { issue: 'API#1' });
    expect(detail.linkedTasks).toEqual([
      expect.objectContaining({
        ref: 'acme/API-1',
        url: `${ctx.env.baseUrl}/t/acme/p/API/tasks/1`,
      }),
    ]);
    expect(detail.history.map((entry) => entry.action)).toEqual([
      'issue.created',
      'issue.updated',
      'issue.labels_changed',
      'issue.resolved',
      'issue.reopened',
    ]);
    expect(detail.history[0]?.via).toBe('Claude on laptop');
    expect(detail.replies).toEqual([]);

    expect(await call(client, 'delete_issue', { issue: 'API#1' })).toEqual({ ok: true });
    expect(await callError(client, 'get_issue', { issue: 'API#1' })).toMatch(/not_found/);
    const restored = await call<AgentIssue>(client, 'restore_issue', { issue: 'API#1' });
    expect(restored.id).toBe(created.id);
    expect(await callError(client, 'restore_issue', { issue: 'API#1' })).toMatch(/not in Trash/);
  });

  it('replaces or clears labels and reports errors agents can act on', async () => {
    const client = await connect(member);
    await call(client, 'create_issue', { project: 'API', title: 'Labels', labels: ['Bug', 'UI'] });
    const replaced = await call<AgentIssue>(client, 'update_issue', {
      issue: 'API#1',
      labels: ['docs'],
    });
    expect(replaced.labels.map((label) => label.name)).toEqual(['Docs']);
    const cleared = await call<AgentIssue>(client, 'update_issue', { issue: 'API#1', labels: [] });
    expect(cleared.labels).toEqual([]);

    expect(await callError(client, 'update_issue', { issue: 'API#1', labels: ['Nope'] })).toMatch(
      /Label not found/,
    );
    expect(
      await callError(client, 'update_issue', {
        issue: 'API#1',
        labels: ['Bug'],
        addLabels: ['UI'],
      }),
    ).toMatch(/either set, or add\/remove/);
    expect(await callError(client, 'create_issue', { project: 'NOPE', title: 'x' })).toMatch(
      /Project not found/,
    );
    expect(await callError(client, 'get_issue', { issue: 'API#99' })).toMatch(/Issue not found/);

    ctx.db.orm.update(s.role).set({ permissions: [] }).where(eq(s.role.teamId, teamId)).run();
    expect(await callError(client, 'create_issue', { project: 'API', title: 'x' })).toMatch(
      /forbidden/,
    );
  });
});
