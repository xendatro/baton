import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskStage } from '@shared/schemas/pipelines';
import type { Actor } from '../../context';
import {
  addMember,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type RoleRow,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { createStatus, reorderStatuses, updateStatus } from '../../services/statuses';
import { createTask } from '../../services/tasks';
import { coreTools } from './core';
import { registerTools } from './index';
import { tasksTools } from './tasks';

/** Pipelines over MCP (design §5): get_task's stage, move_task evidence, approve_task, pools. */

let ctx: TestContext;
let owner: UserRow;
let ann: UserRow;
let ben: UserRow;
let reviewer: RoleRow;
let project: CreatedProject;
let clients: Client[];
let reviewId: string;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ann = createUser(ctx.db, { username: 'ann' });
  ben = createUser(ctx.db, { username: 'ben' });
  const team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  reviewer = createRole(ctx.db, { teamId: team.team.id, name: 'Reviewer' });
  addMember(ctx.db, { teamId: team.team.id, userId: ann.id, roleIds: [reviewer.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: ben.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  const [open, done] = project.statuses;
  if (!open || !done) throw new Error('statuses');
  const o = web(owner);
  const doing = createStatus(ctx.deps, o, project.project.id, {
    name: 'In Progress',
    rules: { exitCriteria: [{ id: 'tests', text: 'Tests pass' }], allowCreate: true },
  });
  const review = createStatus(ctx.deps, o, project.project.id, {
    name: 'In Review',
    rules: { allowCreate: true },
  });
  reviewId = review.id;
  reorderStatuses(ctx.deps, o, project.project.id, {
    statusIds: [open.id, doing.id, review.id, done.id],
  });
  updateStatus(ctx.deps, o, review.id, {
    rules: {
      instructions: 'Check the PR.',
      approvals: {
        count: 1,
        rule: { allow: [{ type: 'role', roleId: reviewer.id, scope: 'both' }], deny: [] },
        dismissOnChange: false,
      },
      autoAdvance: true,
    },
  });
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
  ref: string;
  status: { name: string };
  stage?: TaskStage;
}

describe('pipelines over MCP', () => {
  it('walks a task through the pipeline: evidence, approval, auto-advance', async () => {
    const task = createTask(ctx.deps, web(owner), project.project.id, { title: 'Feature' });
    const benClient = await connect(ben);
    await call(benClient, 'move_task', { task: 'API-1', status: 'In Progress' });

    const blocked = await callError(benClient, 'move_task', { task: 'API-1', status: 'In Review' });
    expect(blocked).toContain('evidence for “Tests pass” (criterion tests)');
    expect(blocked).toContain('move_task evidence: [{ criterion, text }]');

    const skipped = await callError(benClient, 'move_task', { task: 'API-1', status: 'Done' });
    expect(skipped).toContain('tasks only move on to In Review');

    const got = await call<TaskOut>(benClient, 'get_task', { task: 'API-1' });
    expect(got.stage?.criteria).toEqual([{ id: 'tests', text: 'Tests pass', evidence: null }]);
    expect(got.stage?.blockedMoves.Done).toContain('tasks only move on to In Review');
    expect(got.stage?.next).toEqual({ id: reviewId, name: 'In Review' });

    // Evidence alone is saved without moving.
    const saved = await call<TaskOut>(benClient, 'move_task', {
      task: 'API-1',
      evidence: [{ criterion: 'tests', text: 'CI green' }],
    });
    expect(saved.status.name).toBe('In Progress');
    expect(saved.stage?.criteria[0]?.evidence?.text).toBe('CI green');
    const unknown = await callError(benClient, 'move_task', {
      task: 'API-1',
      evidence: [{ criterion: 'nope', text: 'x' }],
    });
    expect(unknown).toContain('Its criteria: tests (Tests pass)');

    const inReview = await call<TaskOut>(benClient, 'move_task', {
      task: 'API-1',
      status: 'In Review',
    });
    expect(inReview.stage).toMatchObject({
      instructions: 'Check the PR.',
      approvals: { required: 1, approved: 0, rule: 'Reviewer', canApprove: false },
      missing: ['1 approval from Reviewer'],
    });

    expect(
      await callError(benClient, 'approve_task', { task: 'API-1', decision: 'approve' }),
    ).toContain('Only Reviewer can approve tasks in In Review');
    const annClient = await connect(ann);
    const approved = await call<TaskOut>(annClient, 'approve_task', {
      task: 'API-1',
      decision: 'approve',
      comment: 'Looks good',
    });
    expect(approved.status.name).toBe('Done');
    expect(task.id).toBeTruthy();
  });

  it('sends a task back only with a reason, and approve_task changes picks the stage', async () => {
    createTask(ctx.deps, web(owner), project.project.id, { title: 'Feature', statusId: reviewId });
    const annClient = await connect(ann);
    const got = await call<TaskOut>(annClient, 'get_task', { task: 'API-1' });
    expect(got.stage?.canMoveTo).toEqual({
      forward: {
        id: expect.any(String) as string,
        name: 'Done',
        missing: ['1 approval from Reviewer'],
      },
      back: [
        { id: expect.any(String) as string, name: 'In Progress' },
        { id: expect.any(String) as string, name: 'Open' },
      ],
    });
    expect(
      await callError(annClient, 'move_task', { task: 'API-1', status: 'In Progress' }),
    ).toContain('Give a reason for sending API-1 back to In Progress (reason)');
    expect(
      await callError(annClient, 'approve_task', { task: 'API-1', decision: 'changes' }),
    ).toContain('Say what has to change (comment)');
    const back = await call<TaskOut>(annClient, 'approve_task', {
      task: 'API-1',
      decision: 'changes',
      comment: 'Start again',
      sendBackTo: 'Open',
    });
    expect(back.status.name).toBe('Open');
    expect(back.stage?.returnReason).toMatchObject({
      reason: 'Start again',
      from: { name: 'In Review' },
    });
  });

  it('claims a pool task with claim_task, assigning the claimer', async () => {
    updateStatus(ctx.deps, web(owner), reviewId, {
      rules: {
        approvals: null,
        autoAdvance: false,
        handoff: {
          mode: 'pool',
          rule: { allow: [{ type: 'role', roleId: reviewer.id, scope: 'both' }], deny: [] },
        },
      },
    });
    createTask(ctx.deps, web(owner), project.project.id, {
      title: 'Pooled',
      statusId: reviewId,
    });
    const benClient = await connect(ben);
    const got = await call<TaskOut>(benClient, 'get_task', { task: 'API-1' });
    expect(got.stage?.pool).toEqual({ rule: 'Reviewer', canClaim: false });
    expect(await callError(benClient, 'claim_task', { task: 'API-1' })).toContain(
      'waits in a pool: only Reviewer can claim it',
    );
    const annClient = await connect(ann);
    const claimed = await call<TaskOut & { assignees: { users: Array<{ username: string }> } }>(
      annClient,
      'claim_task',
      { task: 'API-1' },
    );
    expect(claimed.assignees.users.map((user) => user.username)).toEqual(['ann']);
    expect(claimed.stage?.pool).toBeNull();
  });
});
