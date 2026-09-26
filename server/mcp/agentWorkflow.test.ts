import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import * as s from '../db/schema';
import {
  addMember,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../test/helpers';

/**
 * A whole agent session over the real MCP endpoint (`POST /mcp`, Streamable HTTP, bearer keys):
 * one agent files an issue, another turns it into a task, claims it, reports progress and
 * finishes it; the issue resolves itself, its author hears about it, and every step is
 * attributed to the key that made it. Then the finished work is searched, trashed and restored.
 */

let ctx: TestContext;
let server: ServerType;
let origin: string;
let ethan: UserRow;
let maya: UserRow;
let clients: Client[];
let events: LiveEvent[];

beforeEach(async () => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  maya = createUser(ctx.db, { username: 'maya', name: 'Maya' });
  const { team } = createTeam(ctx.db, { ownerId: ethan.id, slug: 'northwind', name: 'Northwind' });
  addMember(ctx.db, { teamId: team.id, userId: maya.id });
  const { project } = createProject(ctx.db, {
    teamId: team.id,
    key: 'WEB',
    name: 'Web App',
    createdById: ethan.id,
  });
  ctx.db.orm
    .insert(s.status)
    .values({
      projectId: project.id,
      name: 'In Progress',
      color: '#f59e0b',
      category: 'open',
      position: 1,
    })
    .run();
  clients = [];
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
  origin = await new Promise<string>((resolve) => {
    server = serve({ fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) =>
      resolve(`http://127.0.0.1:${info.port}`),
    );
  });
});

afterEach(async () => {
  for (const client of clients) await client.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
  ctx.close();
});

async function connect(user: UserRow, keyName: string): Promise<Client> {
  const { key } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'agent-workflow-test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type Json = Record<string, unknown>;

async function call<T = Json>(client: Client, name: string, args: Json = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
  return result.structuredContent as T;
}

interface ActivityItem {
  action: string;
  actor: { user: { username: string } | null; via: { keyName: string } | null; source: string };
  meta: Json;
  changes: Record<string, { from: unknown; to: unknown }>;
}

describe('MCP agent workflow', () => {
  it('whoami → issue → task from issue → claim → reply → done → issue resolved, all via the key', async () => {
    const reporter = await connect(maya, 'Codex desktop');
    const agent = await connect(ethan, 'Claude on laptop');

    // Orientation.
    const me = await call<{
      user: { username: string };
      via: { keyName: string } | null;
      teams: Array<{ slug: string; projects: Array<{ key: string; ref: string }> }>;
    }>(agent, 'whoami');
    expect(me.user.username).toBe('ethan');
    expect(me.via?.keyName).toBe('Claude on laptop');
    expect(me.teams[0]?.projects.map((project) => project.ref)).toEqual(['northwind/WEB']);

    const { projects } = await call<{ projects: Array<{ key: string; url: string }> }>(
      agent,
      'list_projects',
    );
    expect(projects.map((project) => project.key)).toEqual(['WEB']);
    expect(projects[0]?.url).toMatch(/^https?:\/\/.+\/t\/northwind\/p\/WEB$/);

    // Maya's agent files an issue.
    const issue = await call<{ ref: string; url: string; resolved: boolean }>(
      reporter,
      'create_issue',
      {
        project: 'WEB',
        title: 'Checkout button does nothing on Safari',
        body: 'Clicking **Pay** on Safari 18 does nothing. Console shows a CSP error.',
      },
    );
    expect(issue.ref).toBe('northwind/WEB#1');
    expect(issue.resolved).toBe(false);

    // Ethan's agent turns it into a task and claims it.
    const fromIssue = await call<{ ref: string; issues: Array<{ ref: string; kind: string }> }>(
      agent,
      'create_task_from_issue',
      { issue: 'WEB#1' },
    );
    expect(fromIssue.ref).toBe('northwind/WEB-1');
    expect(fromIssue.issues).toEqual([
      expect.objectContaining({ ref: 'northwind/WEB#1', kind: 'fixes' }),
    ]);

    events.length = 0;
    const claimed = await call<{
      task: {
        ref: string;
        status: { name: string };
        claim: { user: { username: string }; via: { keyName: string } | null } | null;
      } | null;
    }>(agent, 'claim_next_task', { project: 'WEB', moveToStatus: 'In Progress' });
    expect(claimed.task?.ref).toBe('northwind/WEB-1');
    expect(claimed.task?.status.name).toBe('In Progress');
    expect(claimed.task?.claim).toMatchObject({
      user: { username: 'ethan' },
      via: { keyName: 'Claude on laptop' },
    });
    // Boards learn about the claim live.
    expect(events.map((event) => event.type)).toContain('task.claimed');

    await call(agent, 'add_reply', {
      item: 'WEB-1',
      body: 'Found it: the payment iframe is blocked by `frame-src`. Fix incoming.',
    });

    // Finishing the task resolves the issue it fixes and releases the claim.
    events.length = 0;
    const done = await call<{ status: { name: string; category: string }; claim: unknown }>(
      agent,
      'move_task',
      { task: 'WEB-1', status: 'Done' },
    );
    expect(done.status).toMatchObject({ name: 'Done', category: 'done' });
    expect(done.claim).toBeNull();
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task.updated', 'task.released', 'issue.updated']),
    );

    const resolved = await call<{
      resolved: boolean;
      resolvedBy: { username: string } | null;
      linkedTasks: Array<{ ref: string; kind: string; status: { category: string } }>;
    }>(agent, 'get_issue', { issue: 'WEB#1' });
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedBy?.username).toBe('ethan');
    expect(resolved.linkedTasks).toMatchObject([
      { ref: 'northwind/WEB-1', kind: 'fixes', status: { category: 'done' } },
    ]);

    // The issue's author is told, with the key that did it.
    const inbox = await call<{
      items: Array<{ type: string; title: string; viaKeyName: string | null; url: string }>;
    }>(reporter, 'list_notifications', { unreadOnly: true });
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        type: 'issue_resolved',
        title: 'WEB#1: Checkout button does nothing on Safari',
        viaKeyName: 'Claude on laptop',
      }),
    );

    // Every step of the task's history names the key.
    const history = await call<{ items: ActivityItem[] }>(agent, 'get_activity', { item: 'WEB-1' });
    const actions = history.items.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['task.created', 'task.claimed', 'task.moved', 'task.released']),
    );
    for (const entry of history.items) {
      expect(entry.actor.via?.keyName, entry.action).toBe('Claude on laptop');
      expect(entry.actor.source).toBe('mcp');
    }
    const issueHistory = await call<{ items: ActivityItem[] }>(agent, 'get_activity', {
      item: 'WEB#1',
    });
    expect(issueHistory.items.map((entry) => [entry.action, entry.actor.via?.keyName])).toEqual([
      ['issue.created', 'Codex desktop'],
      ['issue.links_changed', 'Claude on laptop'],
      ['issue.resolved', 'Claude on laptop'],
    ]);
  });

  it('finds, trashes and restores the work through search, delete_* and restore_item', async () => {
    const agent = await connect(ethan, 'Claude on laptop');
    await call(agent, 'create_issue', {
      project: 'WEB',
      title: 'Invoices export times out',
      body: 'Exporting a year of invoices takes minutes.',
    });
    await call(agent, 'create_task_from_issue', { issue: 'WEB#1' });
    await call(agent, 'add_reply', { item: 'WEB-1', body: 'Streaming the CSV fixes the timeout.' });

    const search = async (query: string) =>
      (
        await call<{ results: Array<{ entityType: string; ref: string }> }>(agent, 'search', {
          query,
        })
      ).results.map((result) => `${result.entityType}:${result.ref}`);
    expect(await search('invoices export')).toEqual(
      expect.arrayContaining(['task:northwind/WEB-1', 'issue:northwind/WEB#1']),
    );
    expect(await search('streaming CSV')).toEqual(['reply:northwind/WEB-1']);

    await call(agent, 'delete_task', { task: 'WEB-1' });
    await call(agent, 'delete_issue', { issue: 'WEB#1' });
    expect(await search('invoices')).toEqual([]);

    const trash = await call<{ items: Array<{ type: string; ref: string | null }> }>(
      agent,
      'list_trash',
      { team: 'northwind' },
    );
    expect(trash.items.map((item) => `${item.type}:${item.ref}`)).toEqual(
      expect.arrayContaining(['task:northwind/WEB-1', 'issue:northwind/WEB#1']),
    );

    const restoredIssue = await call<{ type: string; url: string | null }>(agent, 'restore_item', {
      item: 'WEB#1',
    });
    expect(restoredIssue).toMatchObject({ type: 'issue' });
    expect(restoredIssue.url).toMatch(/\/t\/northwind\/p\/WEB\/issues\/1$/);
    const restoredTask = await call<{ type: string; url: string | null }>(agent, 'restore_item', {
      item: 'WEB-1',
    });
    expect(restoredTask.url).toMatch(/\/t\/northwind\/p\/WEB\/tasks\/1$/);

    expect(await search('invoices')).toEqual(
      expect.arrayContaining(['task:northwind/WEB-1', 'issue:northwind/WEB#1']),
    );
    const task = await call<{ issues: Array<{ ref: string }> }>(agent, 'get_task', {
      task: 'WEB-1',
    });
    expect(task.issues.map((linked) => linked.ref)).toEqual(['northwind/WEB#1']);
  });
});
