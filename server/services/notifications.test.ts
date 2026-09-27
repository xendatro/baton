import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notificationListResponseSchema, type Notification } from '@shared/schemas/core';
import type { Actor } from '../context';
import { coreTools } from '../mcp/tools/core';
import { registerTools } from '../mcp/tools/index';
import {
  addMember,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  signIn,
  web as sessionHeaders,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createIssue, deleteIssue, restoreIssue, updateIssue } from './issues';
import { deleteProject, restoreProject, updateProject } from './projects';
import { createReply, deleteReply, editReply } from './replies';
import { createTask, deleteTask, updateTask } from './tasks';

/**
 * The inbox never shows deleted content (SEC-04, SPEC §1.12): notifications about an issue, task,
 * reply or project in Trash (directly or through its parent) are hidden from the list, the unread
 * count and MCP, and edits refresh the stored title and snippet.
 */

let ctx: TestContext;
let leo: UserRow;
let maya: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
/** Maya's web session (her keys act as her agent, which has no inbox: agents A). */
let mayaSession: Record<string, string>;
let clients: Client[];

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(async () => {
  ctx = createTestContext();
  const owner = createUser(ctx.db, { username: 'owner' });
  leo = createUser(ctx.db, { username: 'leo' });
  maya = createUser(ctx.db, { username: 'maya' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: leo.id, roleIds: [team.adminRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: maya.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  mayaSession = sessionHeaders(ctx, await signIn(ctx, maya));
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function inbox(): Promise<{ items: Notification[]; unread: number }> {
  const list = await ctx.app.request('/api/notifications', { headers: mayaSession });
  const count = await ctx.app.request('/api/notifications/unread-count', {
    headers: mayaSession,
  });
  return {
    items: notificationListResponseSchema.parse(await list.json()).items,
    unread: ((await count.json()) as { count: number }).count,
  };
}

/**
 * The MCP inbox tool over Maya's own inbox. (Real MCP callers are agents, whose inbox is empty;
 * this keeps the tool's filtering covered.)
 */
async function mcpInbox(): Promise<Notification[]> {
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    { deps: ctx.deps, actor: { userId: maya.id, source: 'mcp', key: null } },
    coreTools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  const result = await client.callTool({ name: 'list_notifications', arguments: {} });
  expect(result.isError).toBeFalsy();
  return (result.structuredContent as { items: Notification[] }).items;
}

describe('notifications about deleted items (SEC-04)', () => {
  it('hides a deleted issue’s notifications from the inbox, the count and MCP until it is restored', async () => {
    const issue = createIssue(ctx.deps, web(leo), project.project.id, {
      title: 'Oops wrong audience',
      body: '@maya token=abc123secret',
    });
    expect((await inbox()).items.map((n) => n.snippet)).toEqual(['@maya token=abc123secret']);

    deleteIssue(ctx.deps, web(leo), issue.id);
    expect(await inbox()).toEqual({ items: [], unread: 0 });
    expect(await mcpInbox()).toEqual([]);

    restoreIssue(ctx.deps, web(leo), issue.id);
    expect((await inbox()).unread).toBe(1);
  });

  it('hides replies that are deleted or whose issue, task or project is deleted', async () => {
    const issue = createIssue(ctx.deps, web(leo), project.project.id, { title: 'Staging' });
    const reply = createReply(ctx.deps, web(leo), {
      parentType: 'issue',
      parentId: issue.id,
      body: '@maya the staging password is hunter2',
    });
    const task = createTask(ctx.deps, web(leo), project.project.id, { title: 'Rotate' });
    createReply(ctx.deps, web(leo), {
      parentType: 'task',
      parentId: task.id,
      body: '@maya also this one',
    });
    const assigned = createTask(ctx.deps, web(leo), project.project.id, {
      title: 'Yours',
      assigneeUserIds: [maya.id],
    });
    expect((await inbox()).unread).toBe(3);

    deleteReply(ctx.deps, web(leo), reply.id);
    deleteTask(ctx.deps, web(leo), task.id);
    const left = await inbox();
    expect(left.items.map((n) => [n.type, n.entityId])).toEqual([['assigned', assigned.id]]);
    expect(await mcpInbox()).toHaveLength(1);

    deleteProject(ctx.deps, web(leo), project.project.id);
    expect(await inbox()).toEqual({ items: [], unread: 0 });
    restoreProject(ctx.deps, web(leo), project.project.id);
    expect((await inbox()).unread).toBe(1);
  });

  it('hides README mentions of a deleted project', async () => {
    updateProject(ctx.deps, web(leo), project.project.id, { readme: 'Ask @maya' });
    expect((await inbox()).unread).toBe(1);
    deleteProject(ctx.deps, web(leo), project.project.id);
    expect((await inbox()).items).toEqual([]);
  });
});

describe('notifications after edits (SEC-04)', () => {
  it('refreshes titles and quoted text, so edited-out text leaves the inbox', async () => {
    const issue = createIssue(ctx.deps, web(leo), project.project.id, {
      title: 'Secret 1',
      body: '@maya token=abc123secret',
    });
    updateIssue(ctx.deps, web(leo), issue.id, { title: 'Rotated', body: '@maya token rotated' });
    const task = createTask(ctx.deps, web(leo), project.project.id, {
      title: 'Task',
      description: 'password hunter2',
      assigneeUserIds: [maya.id],
    });
    updateTask(ctx.deps, web(leo), task.id, { description: 'see the vault' });
    const reply = createReply(ctx.deps, web(leo), {
      parentType: 'issue',
      parentId: issue.id,
      body: '@maya key=sk_live_1',
    });
    editReply(ctx.deps, web(leo), reply.id, { body: '@maya key removed' });
    updateProject(ctx.deps, web(leo), project.project.id, { readme: '@maya pin 1234' });
    updateProject(ctx.deps, web(leo), project.project.id, { readme: '@maya pin removed' });

    const items = (await inbox()).items;
    const text = JSON.stringify(items);
    for (const secret of ['abc123secret', 'hunter2', 'sk_live_1', '1234', 'Secret 1']) {
      expect(text).not.toContain(secret);
    }
    expect(items.map((n) => [n.type, n.title, n.snippet]).sort()).toEqual(
      [
        ['assigned', 'API-1: Task', 'see the vault'],
        ['mention', 'API#1: Rotated', '@maya token rotated'],
        ['mention', 'API#1: Rotated', '@maya key removed'],
        ['mention', `${project.project.name} README`, '@maya pin removed'],
      ].sort(),
    );
  });
});
