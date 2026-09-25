import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../context';
import * as s from '../../db/schema';
import { recordActivity } from '../../services/activity';
import { createReply, deleteReply } from '../../services/replies';
import { trashHandlers } from '../../services/trashHandlers';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { adminTools } from './admin';
import { coreTools } from './core';
import { registerTools } from './index';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

/** An MCP client acting as `user` through a new API key named `keyName`. */
async function connectAs(user: UserRow, keyName = 'Claude on laptop') {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  const actor: Actor = { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: keyName } };
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, { deps: ctx.deps, actor }, [...coreTools, ...adminTools]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, actor, keyId: apiKey.id };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function structured<T = Record<string, unknown>>(result: ToolResult): T {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

function errorText(result: ToolResult): string {
  expect(result.isError).toBe(true);
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first?.text ?? '';
}

describe('admin MCP tools', () => {
  it('describes every input field', async () => {
    const { client } = await connectAs(owner);
    const { tools } = await client.listTools();
    for (const name of ['list_trash', 'restore_item', 'get_audit_log_facets']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, name).toBeDefined();
      const properties = (tool?.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${name}.${field}`).toBeTruthy();
      }
    }
  });

  it('lists the trash and restores items by ref or id', async () => {
    const { client } = await connectAs(mia);
    const task = createTask(ctx.db, { project: project.project, authorId: mia.id, title: 'Old' });
    ctx.db.orm
      .update(s.task)
      .set({ deletedAt: new Date(), deletedById: mia.id })
      .where(eq(s.task.id, task.id))
      .run();
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    const reply = createReply(
      ctx.deps,
      { userId: mia.id, source: 'web', key: null },
      {
        parentType: 'issue',
        parentId: issue.id,
        body: 'Oops',
      },
    );
    deleteReply(ctx.deps, { userId: mia.id, source: 'web', key: null }, reply.id);

    const listed = structured<{ items: Array<{ type: string; id: string }>; nextCursor: null }>(
      await client.callTool({ name: 'list_trash', arguments: { team: 'acme' } }),
    );
    expect(listed.items.map((item) => item.type).sort()).toEqual(['reply', 'task']);
    const onlyReplies = structured<{ items: unknown[] }>(
      await client.callTool({ name: 'list_trash', arguments: { team: 'acme', type: 'reply' } }),
    );
    expect(onlyReplies.items).toHaveLength(1);

    const restored = structured(
      await client.callTool({ name: 'restore_item', arguments: { item: reply.id } }),
    );
    expect(restored).toEqual({
      ok: true,
      type: 'reply',
      id: reply.id,
      url: `${ctx.env.baseUrl}/t/acme/p/API/issues/${issue.number}#reply-${reply.id}`,
    });

    const restoredIds: string[] = [];
    const saved = trashHandlers.task;
    // Test-only task handler (the tasks module registers the real one).
    trashHandlers.task = {
      softDelete: () => undefined,
      restore: (deps, _actor, id) => {
        deps.db.orm.update(s.task).set({ deletedAt: null }).where(eq(s.task.id, id)).run();
        restoredIds.push(id);
      },
    };
    try {
      const byRef = structured(
        await client.callTool({
          name: 'restore_item',
          arguments: { item: `acme/API-${task.number}` },
        }),
      );
      expect(byRef).toMatchObject({
        type: 'task',
        id: task.id,
        url: `${ctx.env.baseUrl}/t/acme/p/API/tasks/${task.number}`,
      });
      expect(restoredIds).toEqual([task.id]);
    } finally {
      if (saved) trashHandlers.task = saved;
      else delete trashHandlers.task;
    }

    const live = await client.callTool({
      name: 'restore_item',
      arguments: { item: `API#${issue.number}` },
    });
    expect(errorText(live)).toMatch(/conflict: Issue API#\d+ is not in Trash/);
  });

  it('returns audit log facets and filters get_activity by key name and entity type', async () => {
    const { client, actor } = await connectAs(owner, 'Codex desktop');
    const log = (who: Actor, entityType: 'task' | 'role', action: string) =>
      ctx.db.write((tx) =>
        recordActivity(tx, who, {
          teamId: team.team.id,
          projectId: entityType === 'task' ? project.project.id : null,
          entityType,
          entityId: 'x',
          action,
        }),
      );
    log(actor, 'task', 'task.created');
    log({ userId: owner.id, source: 'web', key: null }, 'role', 'role.created');
    log({ userId: owner.id, source: 'web', key: null }, 'task', 'task.updated');

    const facets = structured<{ keys: Array<{ keyName: string }>; actions: string[] }>(
      await client.callTool({ name: 'get_audit_log_facets', arguments: { team: 'acme' } }),
    );
    expect(facets.keys.map((key) => key.keyName)).toEqual(['Codex desktop']);
    expect(facets.actions).toEqual(['role.created', 'task.created', 'task.updated']);

    const viaKey = structured<{ items: Array<{ action: string }> }>(
      await client.callTool({
        name: 'get_activity',
        arguments: { team: 'acme', key: 'codex desktop' },
      }),
    );
    expect(viaKey.items.map((item) => item.action)).toEqual(['task.created']);

    const roles = structured<{ items: Array<{ action: string }> }>(
      await client.callTool({
        name: 'get_activity',
        arguments: { team: 'acme', entityType: 'role' },
      }),
    );
    expect(roles.items.map((item) => item.action)).toEqual(['role.created']);

    const { client: miaClient } = await connectAs(mia);
    const denied = await miaClient.callTool({
      name: 'get_audit_log_facets',
      arguments: { team: 'acme' },
    });
    expect(errorText(denied)).toMatch(/forbidden/);
  });
});
