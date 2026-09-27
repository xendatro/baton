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
  json,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { releaseJob, sweepListenerSessions } from './agentJobs';
import {
  agentStats,
  approveWaitingJob,
  dismissWaitingJob,
  finishJob,
  getModelMappings,
  jobBrief,
  listWaitingJobs,
  nextRunnerJobs,
  pauseAgentEverywhere,
  registerRunner,
  runnerHeartbeat,
  setHarnessSession,
  setJobSources,
  setModelMappings,
} from './agentRunner';
import { listDifficulties } from './difficulties';
import { getTeamPresence } from './presence';
import { createReply } from './replies';
import { decideApproval } from './pipelines';
import { updateStatus } from './statuses';
import { getTask, updateTask } from './tasks';

/**
 * The desktop app's runners (BAT-24): registering, claiming jobs, whose jobs run without asking,
 * briefs with the model chain and the session to resume, usage and stats.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let teamId: string;
let projectId: string;
let task: TaskRow;
let runnerKey: Actor;
let ethanWeb: Actor;
let cadenWeb: Actor;

async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

const mention = (actor: Actor, body = 'Please look at this @ethan-ai') =>
  createReply(ctx.deps, actor, { parentType: 'task', parentId: task.id, body });

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  projectId = project.id;
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Desktop app' });
  const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
  runnerKey = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' }, 'api');
  ethanWeb = { userId: ethan.id, source: 'web', key: null };
  cadenWeb = { userId: caden.id, source: 'web', key: null };
});

afterEach(() => ctx.close());

function register(projectIds = [projectId]) {
  return registerRunner(ctx.deps, runnerKey, {
    machineId: 'machine-msi-1',
    machineName: 'MSI',
    harnesses: [{ id: 'claude', version: '2.1.0' }],
    projectIds,
  }).runner;
}

describe('runners', () => {
  it('register once per machine, heartbeat, and show on the team’s presence', () => {
    const runner = register();
    expect(register().id).toBe(runner.id);
    const state = runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 2 });
    expect(state).toMatchObject({ paused: false, runner: { running: 2, online: true } });
    expect(getTeamPresence(ctx.deps, cadenWeb, teamId).runners).toEqual([
      { agentUserId: runnerKey.userId, machineName: 'MSI', running: 2 },
    ]);
    // Web sessions and other people's agents can't use it.
    return failure(() => runnerHeartbeat(ctx.deps, ethanWeb, runner.id, { running: 0 })).then(
      (code) => expect(code).toBe('validation_failed'),
    );
  });

  it('claims only accepted jobs of its projects; others wait for the owner’s OK', async () => {
    const runner = register();
    // Caden mentions Ethan's agent: by default only Ethan's own jobs run by themselves.
    mention(cadenWeb);
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toEqual([]);
    const waiting = listWaitingJobs(ctx.deps, ethanWeb).jobs;
    expect(waiting).toMatchObject([{ triggeredBy: 'caden', needsOk: true, kind: 'mention' }]);
    approveWaitingJob(ctx.deps, ethanWeb, waiting[0]?.jobId ?? '');
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    expect(job).toMatchObject({ kind: 'mention', needsOk: false, status: 'claimed' });

    // Ethan's own mention runs at once.
    finishJob(ctx.deps, runnerKey, job?.jobId ?? '', 'complete', {});
    mention(ethanWeb, 'Your turn @ethan-ai');
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toHaveLength(1);
  });

  it('widens the job sources to anyone, or to a who-rule; dismissing cancels', async () => {
    const runner = register();
    setJobSources(ctx.deps, ethanWeb, { mode: 'anyone', rule: null });
    mention(cadenWeb);
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toHaveLength(1);

    setJobSources(ctx.deps, ethanWeb, {
      mode: 'custom',
      rule: { allow: [{ type: 'user', userId: ethan.id }], deny: [] },
    });
    const other = createTask(ctx.db, {
      project: ctx.db.orm.select().from(s.project).where(eq(s.project.id, projectId)).get()!,
      authorId: caden.id,
      title: 'Another',
    });
    createReply(ctx.deps, cadenWeb, {
      parentType: 'task',
      parentId: other.id,
      body: 'And this @ethan-ai',
    });
    const [waiting] = listWaitingJobs(ctx.deps, runnerKey).jobs;
    expect(waiting?.target.title).toBe('Another');
    dismissWaitingJob(ctx.deps, runnerKey, waiting?.jobId ?? '');
    expect(listWaitingJobs(ctx.deps, ethanWeb).jobs).toEqual([]);
  });

  it('puts the claimed jobs of a vanished runner back', async () => {
    setJobSources(ctx.deps, ethanWeb, { mode: 'anyone', rule: null });
    const runner = register();
    mention(cadenWeb);
    await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0);
    ctx.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date(Date.now() - 120_000) })
      .where(eq(s.agentSession.id, runner.id))
      .run();
    expect(sweepListenerSessions(ctx.deps)).toBe(1);
  });
});

describe('job briefs, sessions and usage', () => {
  it('brief the task, stage and trigger, with the chain for its difficulty and the session to resume', async () => {
    const runner = register();
    const levels = listDifficulties(ctx.deps, ethanWeb, projectId).items;
    const hard = levels.find((level) => level.name === 'Hard');
    updateTask(ctx.deps, ethanWeb, task.id, { difficultyId: hard?.id ?? null });
    setModelMappings(ctx.deps, ethanWeb, {
      default: { chain: [{ harness: 'claude', model: 'sonnet', effort: '' }], levels: {} },
      projects: {
        [projectId]: {
          levels: { [hard?.id ?? '']: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }] },
        },
      },
    });
    mention(ethanWeb, 'Build the runner please @ethan-ai');
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const jobId = job?.jobId ?? '';
    setHarnessSession(ctx.deps, runnerKey, jobId, {
      runnerId: runner.id,
      harness: 'codex',
      sessionId: 'thread-123',
    });

    const brief = jobBrief(ctx.deps, runnerKey, jobId, runner.id);
    expect(brief).toMatchObject({
      difficulty: { name: 'Hard' },
      chain: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }],
      chainSource: 'Hard',
      resume: { codex: 'thread-123' },
      target: { ref: 'baton/BAT-1', title: 'Desktop app' },
    });
    expect(brief.prompt).toContain('You are **@ethan-ai**, the Baton agent of **@ethan**');
    expect(brief.prompt).toContain('Build the runner please @ethan-ai');
    expect(brief.prompt).toContain('- Difficulty: Hard');
    expect(brief.prompt).toContain(`complete_job { jobId: "${jobId}" }`);
    // Another machine starts fresh.
    const laptop = registerRunner(ctx.deps, runnerKey, {
      machineId: 'machine-laptop',
      machineName: 'Laptop',
      harnesses: [],
      projectIds: [projectId],
    }).runner;
    expect(jobBrief(ctx.deps, runnerKey, jobId, laptop.id).resume).toEqual({});
  });

  it('carries reviewers’ comments from earlier stages into the brief', async () => {
    const runner = register();
    const statuses = ctx.db.orm
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(s.status.position)
      .all();
    const [open, done] = statuses;
    if (!open || !done) throw new Error('statuses');
    updateStatus(ctx.deps, ethanWeb, open.id, {
      rules: {
        approvals: {
          count: 1,
          rule: { allow: [{ type: 'user', userId: ethan.id }], deny: [] },
          dismissOnChange: false,
        },
      },
    });
    decideApproval(ctx.deps, ethanWeb, task.id, {
      decision: 'approve',
      comment: 'Add a download link on the web too',
    });
    mention(ethanWeb, 'Go @ethan-ai');
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const brief = jobBrief(ctx.deps, runnerKey, job?.jobId ?? '', runner.id);
    expect(brief.prompt).toContain('What reviewers said');
    expect(brief.prompt).toContain('Add a download link on the web too');
    // Once the task moves on, the decision is still there, under the stage it was given in.
    updateTask(ctx.deps, ethanWeb, task.id, { statusId: done.id });
    expect(getTask(ctx.deps, ethanWeb, task.id).stage?.previousApprovals).toMatchObject([
      { status: { name: 'Open' }, decisions: [{ comment: 'Add a download link on the web too' }] },
    ]);
  });

  it('records usage when a job completes or is released, and sums it in stats', async () => {
    const runner = register();
    mention(ethanWeb, 'One @ethan-ai');
    const [first] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    finishJob(ctx.deps, runnerKey, first?.jobId ?? '', 'release', {
      usage: [
        {
          harness: 'claude',
          model: 'opus',
          tokensIn: 1000,
          tokensOut: 200,
          costUsd: 0.5,
          durationMs: 60_000,
          outcome: 'out_of_usage',
        },
      ],
    });
    const [again] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    expect(again?.jobId).toBe(first?.jobId);
    finishJob(ctx.deps, runnerKey, again?.jobId ?? '', 'complete', {
      usage: [
        { harness: 'codex', model: 'gpt-5', costUsd: 0.25, durationMs: 30_000, outcome: 'done' },
      ],
    });
    const stats = agentStats(ctx.deps, ethanWeb, 30);
    expect(stats.totals).toEqual({
      jobs: 1,
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.75,
      durationMs: 90_000,
    });
    expect(stats.byHarness.map((row) => [row.harness, row.jobs])).toEqual([
      ['claude', 1],
      ['codex', 1],
    ]);
    expect(stats.byOutcome).toEqual([
      { outcome: 'done', jobs: 1 },
      { outcome: 'out_of_usage', jobs: 1 },
    ]);
    expect(stats.byDifficulty).toMatchObject([{ difficulty: 'None', jobs: 1 }]);
  });

  it('holds killed runs for the owner’s OK, and leaves jobs the agent released itself alone', async () => {
    const runner = register();
    mention(ethanWeb, 'Try this @ethan-ai');
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const jobId = job?.jobId ?? '';
    const held = finishJob(ctx.deps, runnerKey, jobId, 'release', {
      usage: [{ harness: 'claude', outcome: 'killed' }],
      hold: true,
    });
    expect(held).toMatchObject({ status: 'pending', needsOk: true });
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toEqual([]);
    approveWaitingJob(ctx.deps, ethanWeb, jobId);
    await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0);
    // The agent releases it through MCP; the app's "complete" afterwards only records usage.
    releaseJob(ctx.deps, runnerKey, { jobId });
    expect(
      finishJob(ctx.deps, runnerKey, jobId, 'complete', {
        usage: [{ harness: 'claude', outcome: 'done' }],
      }).status,
    ).toBe('pending');
  });

  it('pauses the agent everywhere with the app’s key', () => {
    expect(pauseAgentEverywhere(ctx.deps, runnerKey).pausedAt).not.toBeNull();
    expect(runnerHeartbeat(ctx.deps, runnerKey, register().id, { running: 0 }).paused).toBe(true);
  });

  it('keeps mappings personal and checks their levels', async () => {
    expect(getModelMappings(ctx.deps, cadenWeb).default.chain).toEqual([
      { harness: 'claude', model: 'opus', effort: 'high' },
    ]);
    expect(
      await failure(() =>
        setModelMappings(ctx.deps, ethanWeb, {
          default: { chain: [], levels: {} },
          projects: {
            [projectId]: { levels: { nope: [{ harness: 'claude', model: '', effort: '' }] } },
          },
        }),
      ),
    ).toBe('validation_failed');
  });

  it('serves the app over REST with an API key', async () => {
    const { key } = createApiKey(ctx.db, { userId: ethan.id, name: 'REST' });
    const res = await ctx.app.request(
      '/api/agent/runners',
      json(
        'POST',
        {
          machineId: 'machine-rest-1',
          machineName: 'Desk',
          harnesses: [],
          projectIds: [projectId],
        },
        bearer(key),
      ),
    );
    expect(res.status).toBe(200);
    const state = (await res.json()) as { runner: { id: string } };
    const next = await ctx.app.request(
      `/api/agent/runners/${state.runner.id}/jobs/next?wait=0`,
      json('POST', {}, bearer(key)),
    );
    expect(await next.json()).toEqual({ jobs: [] });
    const stats = await ctx.app.request('/api/me/agent/stats?days=7', { headers: bearer(key) });
    expect(stats.status).toBe(200);
  });
});
