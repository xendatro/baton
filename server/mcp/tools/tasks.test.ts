import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../../db/schema';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { coreTools } from './core';
import { registerTools } from './index';
import { tasksTools } from './tasks';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let teamId: string;
let project: CreatedProject;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: mia.id });
  project = createProject(ctx.db, { teamId, key: 'API', createdById: owner.id });
  ctx.db.orm
    .insert(s.status)
    .values({
      projectId: project.project.id,
      pipelineId: project.pipeline.id,
      name: 'In Progress',
      color: '#f59e0b',
      position: 2,
    })
    .run();
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow, keyName = 'Claude on laptop'): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
    },
    [...coreTools, ...tasksTools],
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

async function callError(client: Client, name: string, args: Json): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

interface TaskOut {
  id: string;
  ref: string;
  url: string;
  title: string;
  status: { name: string };
  priority: number;
  claim: { user: { username: string }; via: { keyName: string } | null } | null;
  labels: Array<{ name: string }>;
  assignees: { users: Array<{ username: string }>; roles: Array<{ slug: string }> };
  blockedBy: Array<{ ref: string; url: string }>;
  issues: Array<{ ref: string; kind: string; resolved: boolean }>;
  recentReplies?: Array<{ body: string; via: string | null }>;
  recentHistory?: Array<{ action: string }>;
}

describe('task MCP tools', () => {
  it('describes every tool and field for agents', async () => {
    const client = await connect(owner);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'list_tasks',
      'get_task',
      'create_task',
      'update_task',
      'move_task',
      'delete_task',
      'restore_task',
      'create_task_from_issue',
      'claim_next_task',
      'claim_task',
      'renew_claim',
      'release_task',
    ]) {
      expect(names).toContain(name);
    }
    for (const tool of tools.filter((candidate) =>
      tasksTools.some((t) => t.name === candidate.name),
    )) {
      expect(tool.description?.length).toBeGreaterThan(40);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }
    const claimNext = tools.find((tool) => tool.name === 'claim_next_task');
    expect(claimNext?.description).toMatch(/get_task|move_task|add_reply/);
  });

  it('runs the agent workflow: claim next, read, reply, finish (releasing the claim)', async () => {
    const lead = await connect(owner, 'Lead agent');
    const agent = await connect(mia);
    const issue = createIssue(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Login broken',
    });
    ctx.db.orm
      .insert(s.label)
      .values({ projectId: project.project.id, name: 'Backend', color: '#3b82f6' })
      .run();
    const created = await call<TaskOut>(lead, 'create_task', {
      project: 'acme/API',
      title: 'Fix the login',
      description: 'The session cookie is not set. @mia can you look?',
      priority: 'high',
      labels: ['backend'],
      assignees: ['mia'],
      issues: [{ issue: 'API#1' }],
    });
    expect(created).toMatchObject({
      ref: 'acme/API-1',
      url: `${ctx.env.baseUrl}/t/acme/p/API/tasks/1`,
      priority: 3,
      labels: [{ name: 'Backend' }],
      assignees: { users: [{ username: 'mia' }] },
      issues: [{ ref: 'acme/API#1', kind: 'fixes', resolved: false }],
    });
    expect(created).not.toHaveProperty('path');

    const claimed = await call<{ task: TaskOut }>(agent, 'claim_next_task', {
      project: 'API',
      moveToStatus: 'in progress',
      leaseMinutes: 45,
    });
    expect(claimed.task).toMatchObject({
      ref: 'acme/API-1',
      status: { name: 'In Progress' },
      claim: { user: { username: 'mia' }, via: { keyName: 'Claude on laptop' } },
    });

    await call(agent, 'add_reply', { item: 'API-1', body: 'Found it: SameSite was wrong.' });
    const context = await call<TaskOut>(agent, 'get_task', { task: 'API-1' });
    expect(context.recentReplies?.map((reply) => [reply.body, reply.via])).toEqual([
      ['Found it: SameSite was wrong.', 'Claude on laptop'],
    ]);
    expect(context.recentHistory?.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['task.created', 'task.moved', 'task.claimed']),
    );

    // Another agent of the same user can't take it silently.
    const other = await connect(mia, 'Codex desktop');
    expect(await callError(other, 'claim_task', { task: 'API-1' })).toMatch(
      /conflict: API-1 is claimed by @mia via Claude on laptop/,
    );
    const nothing = await call<{ task: null; message: string }>(other, 'claim_next_task', {
      project: 'API',
    });
    expect(nothing.task).toBeNull();
    expect(nothing.message).toMatch(/No task is eligible/);

    const finished = await call<TaskOut>(agent, 'move_task', { task: 'API-1', status: 'Done' });
    expect(finished.claim).toBeNull();
    expect(finished.issues[0]?.resolved).toBe(true);
    const resolved = ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get();
    expect(resolved?.resolved).toBe(true);
  });

  it('lists with filters by name, updates lists, moves, deletes and restores', async () => {
    const client = await connect(owner);
    const backend = createRole(ctx.db, { teamId, name: 'Backend', slug: 'backend' });
    const a = await call<TaskOut>(client, 'create_task', { project: 'API', title: 'A' });
    await call<TaskOut>(client, 'create_task', {
      project: 'API',
      title: 'B',
      assigneeRoles: ['@&backend'],
      blockedBy: ['API-1'],
      dueDate: '2030-01-01',
    });
    const byRole = await call<{ tasks: TaskOut[]; total: number }>(client, 'list_tasks', {
      project: 'API',
      assignee: ['@&backend'],
    });
    expect(byRole.tasks.map((task) => task.ref)).toEqual(['acme/API-2']);
    expect(byRole.tasks[0]).not.toHaveProperty('position');
    const blocked = await call<{ tasks: TaskOut[] }>(client, 'list_tasks', {
      project: 'API',
      blocked: 'yes',
    });
    expect(blocked.tasks.map((task) => task.ref)).toEqual(['acme/API-2']);
    const unassigned = await call<{ tasks: TaskOut[] }>(client, 'list_tasks', {
      project: 'API',
      assignee: ['unassigned'],
      status: ['open'],
    });
    expect(unassigned.tasks.map((task) => task.ref)).toEqual(['acme/API-1']);

    const updated = await call<TaskOut>(client, 'update_task', {
      task: 'API-2',
      assignees: { add: ['mia'] },
      assigneeRoles: { remove: [backend.slug] },
      blockedBy: { set: [] },
      dueDate: null,
    });
    expect(updated.assignees).toEqual({
      users: [expect.objectContaining({ username: 'mia' })],
      roles: [],
    });
    expect(updated.blockedBy).toEqual([]);

    const moved = await call<TaskOut>(client, 'move_task', { task: 'API-2', before: 'API-1' });
    expect(moved.ref).toBe('acme/API-2');
    const order = await call<{ tasks: TaskOut[] }>(client, 'list_tasks', { project: 'API' });
    expect(order.tasks.map((task) => task.ref)).toEqual(['acme/API-2', 'acme/API-1']);

    expect(await call(client, 'delete_task', { task: a.ref })).toMatchObject({
      ok: true,
      ref: 'acme/API-1',
    });
    expect(await callError(client, 'get_task', { task: 'API-1' })).toMatch(/not_found/);
    const restored = await call<TaskOut>(client, 'restore_task', { task: 'API-1' });
    expect(restored.ref).toBe('acme/API-1');
    expect(await callError(client, 'restore_task', { task: 'API-1' })).toMatch(/not in Trash/);
    expect(
      await callError(client, 'create_task', { project: 'API', title: 'X', priority: 'huge' }),
    ).toMatch(/priority/i);
  });

  it('creates a task from an issue and claims and releases it', async () => {
    const client = await connect(mia);
    createIssue(ctx.db, { project: project.project, title: 'Slow search', body: 'It takes 5s' });
    const task = await call<TaskOut & { description: string }>(client, 'create_task_from_issue', {
      issue: 'API#1',
    });
    expect(task.description).toContain('From issue [API#1]');
    expect(task.issues).toEqual([expect.objectContaining({ ref: 'acme/API#1', kind: 'fixes' })]);
    await call(client, 'claim_task', { task: task.ref, leaseMinutes: 10 });
    const renewed = await call<TaskOut & { claim: { expiresAt: string | null } }>(
      client,
      'renew_claim',
      {
        task: task.ref,
        leaseMinutes: 120,
      },
    );
    // Claims don't expire any more; renew_claim only confirms the holder.
    expect(renewed.claim.expiresAt).toBeNull();
    const released = await call<TaskOut & { replyCount: number }>(client, 'release_task', {
      task: task.ref,
      note: 'Stopping here: profiling shows the FTS query is fine.',
    });
    expect(released.claim).toBeNull();
    expect(released.replyCount).toBe(1);
    expect(await callError(client, 'renew_claim', { task: task.ref })).toMatch(/not claimed/);
  });

  it('never resolves an issue for an agent that may not resolve it (SEC-02)', async () => {
    const everyone = ctx.db.orm
      .select()
      .from(s.role)
      .where(eq(s.role.teamId, teamId))
      .all()
      .find((role) => role.isEveryone);
    ctx.db.orm
      .update(s.role)
      .set({ permissions: (everyone?.permissions ?? []).filter((p) => p !== 'RESOLVE_ISSUES') })
      .where(eq(s.role.id, everyone?.id ?? ''))
      .run();
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const client = await connect(mia);

    expect(
      await callError(client, 'create_task', {
        project: 'API',
        title: 'fix it',
        status: 'Done',
        issues: [{ issue: 'API#1' }],
      }),
    ).toMatch(/relates/);
    const task = await call<TaskOut>(client, 'create_task', {
      project: 'API',
      title: 'fix it',
      issues: [{ issue: 'API#1', kind: 'relates' }],
    });
    expect(
      await callError(client, 'update_task', {
        task: task.ref,
        issues: { add: [{ issue: 'API#1', kind: 'fixes' }] },
      }),
    ).toMatch(/relates/);
    const fromIssue = await call<TaskOut>(client, 'create_task_from_issue', { issue: 'API#1' });
    expect(fromIssue.issues).toEqual([
      expect.objectContaining({ ref: 'acme/API#1', kind: 'relates' }),
    ]);
    await call(client, 'move_task', { task: task.ref, status: 'Done' });
    await call(client, 'move_task', { task: fromIssue.ref, status: 'Done' });
    const row = ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get();
    expect(row).toMatchObject({ resolved: false, resolvedById: null });
  });
});
