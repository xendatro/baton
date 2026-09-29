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
import { queueJobs, releaseJob, sweepListenerSessions, sweepSettledJobs } from './agentJobs';
import {
  agentStats,
  approveWaitingJob,
  dismissWaitingJob,
  finishJob,
  getModelMappings,
  jobBrief,
  jobOutput,
  listWaitingJobs,
  modelFailures,
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
import { deleteTask, getTask, moveTask, restoreTask, updateTask } from './tasks';

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

  it('cancels the jobs of a deleted task; the heartbeat tells the runner to kill them (BAT-33)', async () => {
    const runner = register();
    mention(ethanWeb, 'Build it @ethan-ai');
    const [running] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const runningId = running?.jobId ?? '';
    // Another job waits in the queue (a reply in the task's thread).
    mention(ethanWeb, 'And the tests @ethan-ai');
    const jobStatus = (id: string) =>
      ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, id)).get()?.status;
    const queued = ctx.db.orm
      .select()
      .from(s.agentJob)
      .where(eq(s.agentJob.status, 'pending'))
      .all();
    expect(queued).toHaveLength(1);
    expect(
      runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, jobIds: [runningId] })
        .cancelledJobIds,
    ).toEqual([]);

    deleteTask(ctx.deps, cadenWeb, task.id);
    expect(jobStatus(runningId)).toBe('cancelled');
    expect(jobStatus(queued[0]?.id ?? '')).toBe('cancelled');
    expect(
      runnerHeartbeat(ctx.deps, runnerKey, runner.id, { running: 1, jobIds: [runningId] })
        .cancelledJobIds,
    ).toEqual([runningId]);
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toEqual([]);
    // The killed run's report records its usage but neither holds nor reopens the job.
    finishJob(ctx.deps, runnerKey, runningId, 'release', { hold: true });
    expect(jobStatus(runningId)).toBe('cancelled');
    expect(listWaitingJobs(ctx.deps, ethanWeb).jobs).toEqual([]);

    // Restoring the task doesn't bring the cancelled jobs back.
    restoreTask(ctx.deps, cadenWeb, task.id);
    expect(jobStatus(runningId)).toBe('cancelled');
    expect((await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs).toEqual([]);
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

  it('picks the chain from the difficulty of the stage the job is for (BAT-28)', async () => {
    const runner = register();
    const levels = listDifficulties(ctx.deps, ethanWeb, projectId).items;
    const byName = (name: string) => levels.find((level) => level.name === name)?.id ?? '';
    const [open, done] = ctx.db.orm
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(s.status.position)
      .all();
    if (!open || !done) throw new Error('statuses');
    setModelMappings(ctx.deps, ethanWeb, {
      default: { chain: [{ harness: 'claude', model: 'sonnet', effort: '' }], levels: {} },
      projects: {
        [projectId]: {
          levels: {
            [byName('Hard')]: [{ harness: 'claude', model: 'opus', effort: 'high' }],
            [byName('Easy')]: [{ harness: 'claude', model: 'haiku', effort: '' }],
          },
        },
      },
    });
    // Hard in Open, Easy once in Done.
    updateTask(ctx.deps, ethanWeb, task.id, { difficultyId: byName('Hard') });
    updateTask(ctx.deps, ethanWeb, task.id, { statusId: done.id, difficultyId: byName('Easy') });
    // A job for the Open stage (e.g. an approval asked there) and one for the task as it is now.
    ctx.db.write((tx) =>
      queueJobs(tx, [
        {
          agentUserId: runnerKey.userId,
          teamId,
          projectId,
          kind: 'approval',
          targetType: 'task',
          targetId: task.id,
          payload: { stage: 'Open', statusId: open.id },
          triggeredById: ethan.id,
        },
      ]),
    );
    mention(ethanWeb, 'Have a look @ethan-ai');
    const jobs = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const forOpen = jobBrief(
      ctx.deps,
      runnerKey,
      jobs.find((job) => job.kind === 'approval')?.jobId ?? '',
      runner.id,
    );
    expect(forOpen).toMatchObject({
      difficulty: { name: 'Hard' },
      chain: [{ model: 'opus' }],
    });
    expect(forOpen.prompt).toContain('- Difficulty: Hard (the task’s difficulty in Open');
    const current = jobBrief(
      ctx.deps,
      runnerKey,
      jobs.find((job) => job.kind === 'mention')?.jobId ?? '',
      runner.id,
    );
    expect(current).toMatchObject({ difficulty: { name: 'Easy' }, chain: [{ model: 'haiku' }] });
  });

  it('puts the send-back reason at the top of the brief (BAT-27)', async () => {
    const runner = register();
    const [open, done] = ctx.db.orm
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(s.status.position)
      .all();
    if (!open || !done) throw new Error('statuses');
    updateTask(ctx.deps, ethanWeb, task.id, { assigneeUsers: { set: [runnerKey.userId] } });
    updateTask(ctx.deps, ethanWeb, task.id, { statusId: done.id });
    moveTask(ctx.deps, ethanWeb, task.id, {
      statusId: open.id,
      reason: 'The download link is broken',
    });
    const jobs = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const job = jobs.find((item) => item.kind === 'assigned');
    expect(job?.payload).toMatchObject({ returnReason: 'The download link is broken' });
    expect(job?.instructions).toContain('was sent back to Open from Done because');
    const { prompt } = jobBrief(ctx.deps, runnerKey, job?.jobId ?? '', runner.id);
    expect(prompt).toContain('## Sent back because\n\n> The download link is broken');
    expect(prompt.indexOf('## Sent back because')).toBeLessThan(prompt.indexOf('## The job'));
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
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      costUsd: 0.75,
      costEstimatedUsd: 0,
      unpricedRuns: 0,
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

  it('breaks tokens down, estimates API costs the harness didn’t report, and merges model spellings (BAT#25)', async () => {
    const runner = register();
    mention(ethanWeb, 'Stats @ethan-ai');
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    finishJob(ctx.deps, runnerKey, job?.jobId ?? '', 'complete', {
      usage: [
        // Codex reports no cost: priced at gpt-5's API rates.
        {
          harness: 'codex',
          model: 'GPT-5 ',
          tokensIn: 2_000_000,
          tokensCacheRead: 1_000_000,
          tokensOut: 100_000,
          tokensReasoning: 40_000,
          outcome: 'failed',
        },
        { harness: 'codex', model: 'gpt-5', tokensIn: 1_000_000, outcome: 'failed' },
        // A model nobody knows the price of: counted, not priced.
        { harness: 'codex', model: 'gpt-6-sol', tokensIn: 5_000_000, outcome: 'failed' },
        // Claude Code reports its model and cost.
        {
          harness: 'claude',
          model: 'opus',
          reportedModel: 'claude-opus-4-6-20260101',
          tokensIn: 300,
          tokensCacheRead: 100,
          tokensCacheWrite: 50,
          costUsd: 0.1,
          outcome: 'done',
        },
      ],
    });
    const stats = agentStats(ctx.deps, ethanWeb, 30);
    expect(stats.totals).toMatchObject({
      tokensIn: 8_000_300,
      tokensCacheRead: 1_000_100,
      tokensCacheWrite: 50,
      tokensOut: 100_000,
      tokensReasoning: 40_000,
      costUsd: 0.1,
      unpricedRuns: 1,
    });
    // gpt-5: 1M uncached × $1.25 + 1M cached × $0.125 + 0.1M out × $10, then 1M × $1.25.
    expect(stats.totals.costEstimatedUsd).toBeCloseTo(1.25 + 0.125 + 1 + 1.25, 6);
    expect(stats.byModel.map((row) => [row.harness, row.model, row.jobs])).toEqual([
      ['claude', 'claude-opus-4-6', 1],
      ['codex', 'gpt-5', 1],
      ['codex', 'gpt-6-sol', 1],
    ]);
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

describe('stopped runs, jobs needing an OK, cleared jobs (BAT#22, BAT#23, BAT#29)', () => {
  const statuses = () => {
    const [open, done] = ctx.db.orm
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(s.status.position)
      .all();
    if (!open || !done) throw new Error('statuses');
    return { open, done };
  };

  /** Ethan's own job, claimed by the runner and reported as failed (held for him). */
  async function failedRun(body = 'Build it @ethan-ai') {
    const runner = register();
    mention(ethanWeb, body);
    const [job] = (await nextRunnerJobs(ctx.deps, runnerKey, runner.id, 0)).jobs;
    const jobId = job?.jobId ?? '';
    finishJob(ctx.deps, runnerKey, jobId, 'release', {
      usage: [
        {
          harness: 'codex',
          model: 'luna',
          outcome: 'failed',
          error: 'The luna model is not supported when using Codex with a ChatGPT account',
        },
      ],
      hold: true,
      outcome: 'failed',
      output: Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'),
    });
    return jobId;
  }

  /** Caden mentions Ethan's agent on another task: it waits for Ethan's OK. */
  const othersJob = (title = 'Another') => {
    const other = createTask(ctx.db, {
      project: ctx.db.orm.select().from(s.project).where(eq(s.project.id, projectId)).get()!,
      authorId: caden.id,
      title,
    });
    createReply(ctx.deps, cadenWeb, {
      parentType: 'task',
      parentId: other.id,
      body: 'From me @ethan-ai',
    });
    return other;
  };

  it('splits others’ jobs from your stopped runs, with the error and the output’s tail', async () => {
    const jobId = await failedRun();
    othersJob();
    const jobs = listWaitingJobs(ctx.deps, ethanWeb).jobs;
    expect(jobs.map((job) => [job.group, job.triggeredBy])).toEqual([
      ['stopped', 'ethan'],
      ['needs_ok', 'caden'],
    ]);
    expect(jobs[0]?.run).toMatchObject({
      outcome: 'failed',
      error: 'The luna model is not supported when using Codex with a ChatGPT account',
      harness: 'codex',
      model: 'luna',
      hasOutput: true,
    });
    const output = jobOutput(ctx.deps, ethanWeb, jobId);
    const lines = output.output.split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line 51');
    expect(lines.at(-1)).toBe('line 250');
    expect(await failure(() => jobOutput(ctx.deps, cadenWeb, jobId))).toBe('not_found');

    // The chain editors show the failure next to that model.
    expect(modelFailures(ctx.deps, ethanWeb).failures).toMatchObject([
      {
        harness: 'codex',
        model: 'luna',
        error: 'The luna model is not supported when using Codex with a ChatGPT account',
      },
    ]);

    // Retry: it runs again, and is no longer a stopped run.
    approveWaitingJob(ctx.deps, ethanWeb, jobId);
    expect(listWaitingJobs(ctx.deps, ethanWeb).jobs.map((job) => job.group)).toEqual(['needs_ok']);
  });

  it('clears held jobs when their task finishes, shows them for a day, then drops them', async () => {
    const jobId = await failedRun();
    const { done } = statuses();
    updateTask(ctx.deps, cadenWeb, task.id, { statusId: done.id });
    const [cleared] = listWaitingJobs(ctx.deps, ethanWeb).jobs;
    expect(cleared).toMatchObject({
      jobId,
      group: 'cleared',
      status: 'cancelled',
      clearedReason: 'finished',
    });
    // Nothing to approve any more.
    approveWaitingJob(ctx.deps, ethanWeb, jobId);
    const row = ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
    expect(row?.status).toBe('cancelled');
    ctx.db.orm
      .update(s.agentJob)
      .set({ clearedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(s.agentJob.id, jobId))
      .run();
    expect(listWaitingJobs(ctx.deps, ethanWeb).jobs).toEqual([]);
  });

  it('clears jobs of a deleted task, and the sweep catches finishes the moves didn’t report', async () => {
    await failedRun();
    deleteTask(ctx.deps, cadenWeb, task.id);
    expect(
      listWaitingJobs(ctx.deps, ethanWeb).jobs.map((job) => [job.group, job.clearedReason]),
    ).toEqual([['cleared', 'deleted']]);

    const other = othersJob();
    ctx.db.orm.update(s.task).set({ completedAt: new Date() }).where(eq(s.task.id, other.id)).run();
    expect(sweepSettledJobs(ctx.deps)).toBe(1);
    const open = listWaitingJobs(ctx.deps, ethanWeb).jobs.filter((job) => job.group !== 'cleared');
    expect(open).toEqual([]);
  });

  it('clears a stage’s job when the task leaves that stage, and keeps mentions', () => {
    const { open, done } = statuses();
    // A pool job for the Open stage from Caden: it waits for Ethan's OK.
    const [jobId] = ctx.db.write((tx) =>
      queueJobs(tx, [
        {
          agentUserId: runnerKey.userId,
          teamId,
          projectId,
          kind: 'pool',
          targetType: 'task',
          targetId: task.id,
          payload: { stage: open.name, statusId: open.id },
          triggeredById: caden.id,
        },
      ]),
    );
    mention(cadenWeb, 'Also @ethan-ai');
    expect(listWaitingJobs(ctx.deps, ethanWeb).jobs.map((job) => job.group)).toEqual([
      'needs_ok',
      'needs_ok',
    ]);
    // Another open stage to move to.
    const review = ctx.db.orm
      .insert(s.status)
      .values({
        id: '01J00000000000000000REVIEW',
        projectId,
        pipelineId: open.pipelineId,
        name: 'Review',
        color: '#000000',
        position: (open.position + done.position) / 2,
      })
      .returning()
      .get();
    updateTask(ctx.deps, cadenWeb, task.id, { statusId: review.id });
    const jobs = listWaitingJobs(ctx.deps, ethanWeb).jobs;
    expect(jobs.find((job) => job.jobId === jobId)).toMatchObject({
      group: 'cleared',
      clearedReason: 'moved',
    });
    expect(jobs.find((job) => job.kind === 'mention')).toMatchObject({ group: 'needs_ok' });
  });

  it('serves the output and model failures over REST', async () => {
    const jobId = await failedRun();
    const { key } = createApiKey(ctx.db, { userId: ethan.id, name: 'REST' });
    const output = await ctx.app.request(`/api/me/agent/jobs/${jobId}/output`, {
      headers: bearer(key),
    });
    expect(output.status).toBe(200);
    expect(((await output.json()) as { output: string }).output).toContain('line 250');
    const failures = await ctx.app.request('/api/me/agent/model-failures', {
      headers: bearer(key),
    });
    expect(((await failures.json()) as { failures: unknown[] }).failures).toHaveLength(1);
  });
});
