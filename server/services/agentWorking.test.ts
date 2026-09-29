import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { listIssuesQuerySchema } from '@shared/schemas/issues';
import { boardQuerySchema, listTasksQuerySchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type ProjectRow,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { completeJob, startListener } from './agentJobs';
import { finishJob, nextRunnerJobs, registerRunner, runnerHeartbeat } from './agentRunner';
import { RUNNER_REPORT_FRESH_MS, sweepWorking } from './agentWorking';
import { getChatPage } from './chat';
import { listIssues } from './issues';
import { createReply } from './replies';
import { getBoard, getTask, listTasks } from './tasks';

/**
 * BAT#42: "Ethan AI is working" (the chat line and the pulsing dot) only while a harness actually
 * runs a job about the item, or a live MCP listener claimed one, until the agent answers.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let projectId: string;
let projectRow: ProjectRow;
let task: TaskRow;
let runnerKey: Actor;
let ethanWeb: Actor;
let cadenWeb: Actor;
let events: LiveEvent[];

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  const teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  projectId = project.id;
  projectRow = project;
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Desktop app' });
  const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
  runnerKey = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' }, 'api');
  ethanWeb = { userId: ethan.id, source: 'web', key: null };
  cadenWeb = { userId: caden.id, source: 'web', key: null };
  events = [];
  ctx.deps.events.subscribe((event) => {
    if (event.type === 'item.working_changed') events.push(event);
  });
});

afterEach(() => ctx.close());

const agentName = () =>
  ctx.db.orm.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, runnerKey.userId)).get()
    ?.name;

function register() {
  return registerRunner(ctx.deps, runnerKey, {
    machineId: 'machine-msi-1',
    machineName: 'MSI',
    harnesses: [{ id: 'claude', version: '2.1.0' }],
    projectIds: [projectId],
  }).runner;
}

/** Ethan mentions his agent on the task; the runner claims the job. */
async function claimedMention() {
  const runner = register();
  const trigger = createReply(ctx.deps, ethanWeb, {
    parentType: 'task',
    parentId: task.id,
    body: 'Please look at this @ethan-ai',
  });
  const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
  if (!job) throw new Error('expected a job');
  return { runner, jobId: job.jobId, triggerId: trigger.id };
}

const chatWorking = () =>
  getChatPage(ctx.deps, cadenWeb, { type: 'task', id: task.id }, {}).workingAgents.map(
    (agent) => agent.id,
  );

function card() {
  return listTasks(ctx.deps, cadenWeb, projectId, listTasksQuerySchema.parse({})).items.find(
    (item) => item.id === task.id,
  );
}

function boardCard() {
  return getBoard(ctx.deps, cadenWeb, projectId, boardQuerySchema.parse({}))
    .columns.flatMap((column) => column.tasks)
    .find((item) => item.id === task.id);
}

const taskEvents = () =>
  events.filter((event) => event.entityType === 'task' && event.entityId === task.id);

describe('agent working state', () => {
  it('a job only claimed by a runner is not working (the bug: "working" with 0 running)', async () => {
    const { runner, jobId } = await claimedMention();
    expect(chatWorking()).toEqual([]);
    expect(card()?.agentWorking).toBeNull();
    // Queued on the machine or waiting for usage: reported in jobIds, not among the active ones.
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, {
      running: 1,
      jobIds: [jobId],
      activeJobIds: [],
    });
    expect(chatWorking()).toEqual([]);
    expect(boardCard()?.agentWorking).toBeNull();
    expect(taskEvents()).toEqual([]);
  });

  it('is working while a heartbeat reports the harness running, until complete', async () => {
    const { runner, jobId } = await claimedMention();
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, {
      running: 1,
      jobIds: [jobId],
      activeJobIds: [jobId],
    });
    expect(chatWorking()).toEqual([runnerKey.userId]);
    const working = { agentIds: [runnerKey.userId], names: [agentName()] };
    expect(card()?.agentWorking).toEqual(working);
    expect(boardCard()?.agentWorking).toEqual(working);
    expect(getTask(ctx.deps, cadenWeb, task.id).agentWorking).toEqual(working);
    expect(taskEvents()).toHaveLength(1);
    expect(taskEvents()[0]).toMatchObject({ projectId, teamId: task.teamId, actorId: null });

    // Another heartbeat with the same jobs publishes nothing new.
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, activeJobIds: [jobId] });
    expect(taskEvents()).toHaveLength(1);

    finishJob(ctx.deps, runnerKey, jobId, 'complete', {});
    expect(chatWorking()).toEqual([]);
    expect(card()?.agentWorking).toBeNull();
    expect(taskEvents()).toHaveLength(2);
  });

  it('older apps: every job of the heartbeat counts', async () => {
    const { runner, jobId } = await claimedMention();
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, jobIds: [jobId] });
    expect(chatWorking()).toEqual([runnerKey.userId]);
  });

  it('stops as soon as the agent answers the reply that asked, before complete_job', async () => {
    const { runner, jobId, triggerId } = await claimedMention();
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, activeJobIds: [jobId] });
    expect(chatWorking()).toEqual([runnerKey.userId]);
    createReply(ctx.deps, runnerKey, {
      parentType: 'task',
      parentId: task.id,
      body: 'Done: see the PR',
      parentReplyId: triggerId,
    });
    expect(chatWorking()).toEqual([]);
    expect(card()?.agentWorking).toBeNull();
    expect(taskEvents()).toHaveLength(2);
    completeJob(ctx.deps, runnerKey, { jobId });
    expect(taskEvents()).toHaveLength(2);
  });

  it('stops when the harness stops (heartbeat) or the report goes stale (sweep)', async () => {
    const { runner, jobId } = await claimedMention();
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, activeJobIds: [jobId] });
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, {
      running: 1,
      jobIds: [jobId],
      activeJobIds: [],
    });
    expect(chatWorking()).toEqual([]);
    expect(taskEvents()).toHaveLength(2);

    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, activeJobIds: [jobId] });
    expect(taskEvents()).toHaveLength(3);
    ctx.db.orm
      .update(s.agentSession)
      .set({ runningReportedAt: new Date(Date.now() - RUNNER_REPORT_FRESH_MS - 1_000) })
      .where(eq(s.agentSession.id, runner.id))
      .run();
    expect(chatWorking()).toEqual([]);
    sweepWorking(ctx.deps);
    expect(taskEvents()).toHaveLength(4);
    sweepWorking(ctx.deps);
    expect(taskEvents()).toHaveLength(4);
  });

  it('a released (held) run is not working', async () => {
    const { runner, jobId } = await claimedMention();
    runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, activeJobIds: [jobId] });
    finishJob(ctx.deps, runnerKey, jobId, 'release', { hold: true });
    expect(chatWorking()).toEqual([]);
    expect(taskEvents()).toHaveLength(2);
  });

  it('an MCP listener works on what it claims at once; issues show it too', async () => {
    const issue = createIssue(ctx.db, {
      project: projectRow,
      authorId: caden.id,
      title: 'Dot',
    });
    const trigger = createReply(ctx.deps, ethanWeb, {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Ideas @ethan-ai?',
    });
    const mcpKey: Actor = { ...runnerKey, source: 'mcp' };
    const listened = await startListener(ctx.deps, mcpKey, {
      projects: ['BAT'],
      timeoutSeconds: 0,
    });
    const [job] = listened.jobs;
    expect(job).toBeDefined();
    const row = listIssues(
      ctx.deps,
      cadenWeb,
      projectId,
      listIssuesQuerySchema.parse({}),
    ).items.find((item) => item.id === issue.id);
    expect(row?.agentWorking?.agentIds).toEqual([runnerKey.userId]);
    expect(
      events.filter((event) => event.entityType === 'issue' && event.entityId === issue.id),
    ).toHaveLength(1);
    createReply(ctx.deps, mcpKey, {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Some',
      parentReplyId: trigger.id,
    });
    expect(
      getChatPage(ctx.deps, cadenWeb, { type: 'issue', id: issue.id }, {}).workingAgents,
    ).toEqual([]);
    const pending = ctx.db.orm
      .select({ status: s.agentJob.status })
      .from(s.agentJob)
      .where(and(eq(s.agentJob.id, job?.jobId ?? ''), eq(s.agentJob.status, 'claimed')))
      .get();
    expect(pending?.status).toBe('claimed');
  });
});
