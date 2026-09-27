import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@shared/schemas/common';
import type { Status } from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { coreTools } from '../mcp/tools/core';
import { registerTools } from '../mcp/tools/index';
import { projectsTools } from '../mcp/tools/projects';
import { tasksTools } from '../mcp/tools/tasks';
import {
  bearer,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createIssue } from './issues';
import { createStatus, listStatuses, updateStatus } from './statuses';
import { createTask, createTaskFromIssue } from './tasks';

/** BAT-34: "New tasks can start here" (`allowCreate`), a stage rule. */

let ctx: TestContext;
let owner: UserRow;
let projectId: string;
let open: Status;
let done: Status;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  const { team } = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  projectId = createProject(ctx.db, { teamId: team.id, key: 'API', createdById: owner.id }).project
    .id;
  [open, done] = statuses() as [Status, Status];
});

afterEach(() => {
  ctx.close();
});

function statuses(): Status[] {
  return listStatuses(ctx.deps, web(owner), projectId).items;
}

function failure(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('expected a failure');
}

function newTask(statusId?: string) {
  return createTask(ctx.deps, web(owner), projectId, {
    title: 'Ship it',
    ...(statusId ? { statusId } : {}),
  });
}

describe('new tasks can start here (allowCreate)', () => {
  it('is on for a new project’s Open and off for its Done and for new stages', () => {
    expect([open.name, open.rules?.allowCreate, done.name, done.rules?.allowCreate]).toEqual([
      'Open',
      true,
      'Done',
      false,
    ]);
    const review = createStatus(ctx.deps, web(owner), projectId, { name: 'Review' });
    expect(review.rules?.allowCreate).toBe(false);
  });

  it('refuses to start a task in a stage without it, over REST too', async () => {
    const refused = failure(() => newTask(done.id));
    expect(refused.code).toBe('validation_failed');
    expect(refused.message).toMatch(/can't start in "Done"/);
    const key = createApiKey(ctx.db, { userId: owner.id }).key;
    const response = await ctx.app.request(
      `/api/projects/${projectId}/tasks`,
      json('POST', { title: 'Ship it', statusId: done.id }, bearer(key)),
    );
    expect(response.status).toBe(400);
    expect(apiErrorSchema.parse(await response.json()).error.message).toMatch(/New tasks can/);
    expect(ctx.db.orm.select().from(s.task).all()).toHaveLength(0);

    updateStatus(ctx.deps, web(owner), done.id, { rules: { allowCreate: true } });
    expect(newTask(done.id).status.name).toBe('Done');
  });

  it('starts in the default stage when it allows it, else in the first stage that does', () => {
    expect(newTask().status.name).toBe('Open');
    const triage = createStatus(ctx.deps, web(owner), projectId, {
      name: 'Triage',
      rules: { allowCreate: true },
    });
    updateStatus(ctx.deps, web(owner), open.id, { rules: { allowCreate: false } });
    expect(newTask().status.id).toBe(triage.id);
    // Open is still the default; it just doesn't take new tasks.
    expect(statuses().find((status) => status.isDefault)?.id).toBe(open.id);
  });

  it('refuses with a clear message when no stage of the pipeline accepts new tasks', () => {
    updateStatus(ctx.deps, web(owner), open.id, { rules: { allowCreate: false } });
    const refused = failure(() => newTask());
    expect(refused.code).toBe('validation_failed');
    expect(refused.message).toMatch(
      /^No stage of .+ accepts new tasks; turn on "New tasks can start here" on one in its settings$/,
    );
    const issue = createIssue(ctx.deps, web(owner), projectId, { title: 'Crash' });
    expect(
      failure(() => createTaskFromIssue(ctx.deps, web(owner), projectId, { issueId: issue.id }))
        .message,
    ).toMatch(/accepts new tasks/);
  });

  it('is turned on by making a stage the default, and audited', () => {
    const review = createStatus(ctx.deps, web(owner), projectId, { name: 'Review' });
    const made = updateStatus(ctx.deps, web(owner), review.id, { isDefault: true });
    expect(made.rules?.allowCreate).toBe(true);
    const created = createStatus(ctx.deps, web(owner), projectId, {
      name: 'Inbox',
      isDefault: true,
    });
    expect(created.rules?.allowCreate).toBe(true);
    const updates = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, review.id))
      .all()
      .filter((row) => row.action === 'status.updated');
    expect(updates[0]?.changes).toMatchObject({ allowCreate: { from: false, to: true } });
  });

  it('is shown by list_statuses and set by create_status / update_status over MCP', async () => {
    const { apiKey } = createApiKey(ctx.db, { userId: owner.id, name: 'Claude on laptop' });
    const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
    registerTools(
      server,
      {
        deps: ctx.deps,
        actor: { userId: owner.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
      },
      [...coreTools, ...projectsTools, ...tasksTools],
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const created = await client.callTool({
        name: 'create_status',
        arguments: { project: 'API', name: 'Triage', allowCreate: true },
      });
      expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
      const listed = await client.callTool({
        name: 'list_statuses',
        arguments: { project: 'API' },
      });
      const items = (listed.structuredContent as { statuses: Status[] }).statuses;
      expect(items.map((item) => [item.name, item.rules?.allowCreate])).toEqual([
        ['Open', true],
        ['Done', false],
        ['Triage', true],
      ]);
      const updated = await client.callTool({
        name: 'update_status',
        arguments: { project: 'API', status: 'Triage', allowCreate: false },
      });
      expect((updated.structuredContent as Status).rules?.allowCreate).toBe(false);
      const refused = await client.callTool({
        name: 'create_task',
        arguments: { project: 'API', title: 'Ship it', status: 'Triage' },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
