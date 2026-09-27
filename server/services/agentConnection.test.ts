import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { getAgentConnection } from './agentConnection';
import { startListener } from './agentJobs';
import { registerRunner } from './agentRunner';
import { updateAgentSettings } from './agents';
import { createReply } from './replies';

/** "Your agent isn't connected to this project": runners' folders, listeners, pauses, jobs. */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let teamId: string;
let projectId: string;
let otherProjectId: string;
let task: TaskRow;
let otherTask: TaskRow;
let ethanKey: Actor;
let ethanPlainKey: string;
let ethanWeb: Actor;
let cadenWeb: Actor;

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  projectId = project.id;
  otherProjectId = createProject(ctx.db, { teamId, key: 'WEB', createdById: ethan.id }).project.id;
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Desktop app' });
  otherTask = createTask(ctx.db, { project, authorId: caden.id, title: 'Other' });
  const { apiKey, key } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
  ethanPlainKey = key;
  ethanKey = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' }, 'api');
  ethanWeb = { userId: ethan.id, source: 'web', key: null };
  cadenWeb = { userId: caden.id, source: 'web', key: null };
});

afterEach(() => ctx.close());

const register = (projectIds: string[], machineId = 'msi') =>
  registerRunner(ctx.deps, ethanKey, {
    machineId,
    machineName: machineId.toUpperCase(),
    harnesses: [{ id: 'claude', version: '2.1.0' }],
    projectIds,
  }).runner;

const connection = (actor: Actor = ethanWeb, taskId?: string) =>
  getAgentConnection(ctx.deps, actor, projectId, taskId ? { taskId } : {});

describe('agent connection', () => {
  it('is not covered without runners or listeners', () => {
    expect(connection()).toMatchObject({
      agent: { id: ethanKey.userId, username: 'ethan-ai' },
      project: { id: projectId, ref: 'baton/BAT' },
      covered: false,
      listening: false,
      runners: [],
      paused: false,
      pausedBy: null,
      agentCanView: true,
      pendingJobs: 0,
    });
  });

  it('is covered by an online runner mapping the project, not by one mapping others', () => {
    const other = register([otherProjectId], 'laptop');
    expect(connection()).toMatchObject({
      covered: false,
      runners: [{ id: other.id, machineName: 'LAPTOP', online: true, coversProject: false }],
    });
    register([projectId, otherProjectId]);
    const state = connection();
    expect(state.covered).toBe(true);
    expect(state.runners).toHaveLength(2);
    expect(state.runners.find((runner) => runner.machineName === 'MSI')).toMatchObject({
      online: true,
      coversProject: true,
    });
  });

  it('is not covered by an offline runner', () => {
    const runner = register([projectId]);
    ctx.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(s.agentSession.id, runner.id))
      .run();
    expect(connection()).toMatchObject({
      covered: false,
      runners: [{ online: false, coversProject: true }],
    });
  });

  it('is covered by a live MCP listener of the project', async () => {
    await startListener(ctx.deps, ethanKey, { projects: ['WEB'], timeoutSeconds: 0 });
    expect(connection()).toMatchObject({ covered: false, listening: false });
    await startListener(ctx.deps, ethanKey, { projects: ['BAT'], timeoutSeconds: 0 });
    expect(connection()).toMatchObject({ covered: true, listening: true });
    // The key's own view (its agent) says the same.
    expect(connection(ethanKey)).toMatchObject({ covered: true, agent: { id: ethanKey.userId } });
  });

  it('reports the owner’s pause', () => {
    updateAgentSettings(ctx.deps, ethanWeb, { paused: true });
    expect(connection()).toMatchObject({ paused: true, pausedBy: 'owner' });
    expect(connection().pausedReason).toContain('paused this agent');
  });

  it('counts pending jobs of the project and of the task, and involvement', () => {
    createReply(ctx.deps, ethanWeb, {
      parentType: 'task',
      parentId: task.id,
      body: 'Please look @ethan-ai',
    });
    expect(connection().pendingJobs).toBe(1);
    expect(connection(ethanWeb, task.id)).toMatchObject({
      pendingJobsForTask: 1,
      taskInvolvesAgent: true,
    });
    expect(connection(ethanWeb, otherTask.id)).toMatchObject({
      pendingJobsForTask: 0,
      taskInvolvesAgent: false,
    });
    // A pool the agent may claim from involves it too.
    ctx.db.orm
      .update(s.task)
      .set({ poolRule: { allow: [{ type: 'user', userId: ethanKey.userId }], deny: [] } })
      .where(eq(s.task.id, otherTask.id))
      .run();
    expect(connection(ethanWeb, otherTask.id).taskInvolvesAgent).toBe(true);
  });

  it('hides projects from non-members and tasks of other projects', () => {
    const stranger = createUser(ctx.db, { username: 'zoe' });
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return isAppError(error) ? error.code : 'other';
      }
      return 'ok';
    };
    expect(code(() => connection({ userId: stranger.id, source: 'web', key: null }))).toBe(
      'not_found',
    );
    const foreign = createTask(ctx.db, {
      project: ctx.db.orm.select().from(s.project).where(eq(s.project.id, otherProjectId)).get()!,
      authorId: caden.id,
      title: 'Elsewhere',
    });
    expect(code(() => connection(ethanWeb, foreign.id))).toBe('not_found');
    // Caden sees his own agent's state, not Ethan's.
    register([projectId]);
    expect(connection(cadenWeb)).toMatchObject({ covered: false, runners: [] });
  });

  it('GET /api/projects/:projectId/agent-connection', async () => {
    register([projectId]);
    const res = await ctx.app.request(
      `/api/projects/${projectId}/agent-connection?taskId=${task.id}`,
      { headers: bearer(ethanPlainKey) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      covered: true,
      pendingJobsForTask: 0,
      taskInvolvesAgent: false,
    });
    const missing = await ctx.app.request(
      `/api/projects/${projectId}/agent-connection?taskId=nope`,
      { headers: bearer(ethanPlainKey) },
    );
    expect(missing.status).toBe(404);
  });
});
