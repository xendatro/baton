import { describe, expect, it } from 'vitest';
import type { Chain, HarnessId, JobBrief } from '@shared/schemas/agentRunner';
import type { BatonApi, RunnerJob } from '../src/main/api';
import type { HarnessAdapter, RunOptions, RunResult } from '../src/main/harness/types';
import { Runner, type RunnerStore } from '../src/main/runner';

/** The runner's job flow with a fake Baton and fake harnesses (no processes, no network). */

const job: RunnerJob = {
  jobId: 'job-1',
  kind: 'assigned',
  closing: false,
  project: { id: 'p1', ref: 'baton/BAT', name: 'Baton' },
  target: { type: 'task', ref: 'baton/BAT-24', title: 'Desktop app', url: 'https://x/t' },
  createdAt: new Date().toISOString(),
};

/** A reply by Caden in the same task's thread. */
const reply: RunnerJob = {
  ...job,
  jobId: 'job-2',
  kind: 'thread_reply',
  triggeredBy: 'caden',
  trigger: { body: 'Please also cover Windows', author: { username: 'caden' } },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function brief(chain: Chain): JobBrief {
  return {
    jobId: 'job-1',
    kind: 'assigned',
    project: job.project,
    target: { type: 'task', ref: 'baton/BAT-24', title: 'Desktop app', url: 'https://x/t' },
    difficulty: null,
    chain,
    chainSource: 'account default',
    resume: { codex: 'thread-9' },
    prompt: '# Baton job',
  };
}

function result(patch: Partial<RunResult>): RunResult {
  return {
    outcome: 'done',
    sessionId: null,
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.01,
    durationMs: 100,
    resetAt: null,
    error: null,
    ...patch,
  };
}

function fakeAdapter(
  id: HarnessId,
  outcomes: Array<Partial<RunResult>>,
  seen: RunOptions[],
): HarnessAdapter {
  return {
    id,
    label: id,
    headless: id,
    detect: () => Promise.resolve({ installed: true, path: `/bin/${id}`, version: '1' }),
    listModels: () => Promise.resolve([]),
    permissionModes: [{ id: 'auto', label: 'Auto', description: '', unattended: true }],
    run: (options) => {
      seen.push(options);
      const next = outcomes.shift() ?? {};
      if (next.outcome === 'killed') {
        return new Promise((resolve) =>
          options.signal.addEventListener('abort', () => resolve(result({ outcome: 'killed' }))),
        );
      }
      return Promise.resolve(result(next));
    },
  };
}

function setup(chain: Chain, adapters: HarnessAdapter[], folder: string | null = '/work/baton') {
  const calls: Array<{ call: string; args: unknown[] }> = [];
  /** What the next heartbeat answers as cancelled. */
  const server = { cancelledJobIds: [] as string[] };
  const api = {
    mcpUrl: 'https://baton/mcp',
    key: 'bat_key',
    register: () =>
      Promise.resolve({
        runner: {
          id: 'r1',
          machineId: 'm',
          machineName: 'MSI',
          harnesses: [],
          projectIds: ['p1'],
          running: 0,
          lastSeenAt: new Date().toISOString(),
          online: true,
        },
        paused: false,
        pausedReason: null,
        waitingCount: 0,
      }),
    heartbeat: (...args: unknown[]) => {
      calls.push({ call: 'heartbeat', args });
      return Promise.resolve({
        runner: { id: 'r1' },
        paused: false,
        pausedReason: null,
        waitingCount: 0,
        cancelledJobIds: server.cancelledJobIds,
      });
    },
    nextJobs: (_runnerId: string, _wait: number, signal: AbortSignal) =>
      new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ jobs: [] }), { once: true }),
      ),
    brief: () => Promise.resolve(brief(chain)),
    setSession: (...args: unknown[]) => {
      calls.push({ call: 'setSession', args });
      return Promise.resolve({ ok: true as const });
    },
    finish: (...args: unknown[]) => {
      calls.push({ call: 'finish', args });
      return Promise.resolve({});
    },
  } as unknown as BatonApi;
  const exhausted: Partial<Record<HarnessId, number>> = {};
  const store: RunnerStore = {
    machineId: () => 'm',
    machineName: () => 'MSI',
    projectIds: () => ['p1'],
    folderFor: () => folder,
    permissionMode: () => 'auto',
    exhaustedUntil: () => exhausted,
    setExhausted: (harness, until) => {
      exhausted[harness] = until;
    },
    clearExhausted: (harness) => {
      delete exhausted[harness];
    },
    pausedHere: () => false,
  };
  const runner = new Runner(
    api,
    new Map(adapters.map((adapter) => [adapter.id, adapter])),
    store,
    null,
  );
  return { runner, calls, exhausted, server };
}

async function ready(runner: Runner) {
  await runner.detect();
  // Registers without starting the loops.
  await (runner as unknown as { register(): Promise<string> }).register();
}

describe('runner', () => {
  it('runs the job in the mapped folder and completes it with the usage', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls } = setup(
      [{ harness: 'claude', model: 'opus', effort: 'high' }],
      [fakeAdapter('claude', [{ outcome: 'done', sessionId: 'sess-1' }], seen)],
    );
    await ready(runner);
    await runner.runJob(job);
    expect(seen[0]).toMatchObject({
      cwd: '/work/baton',
      model: 'opus',
      effort: 'high',
      prompt: '# Baton job',
      resumeId: null,
    });
    expect(seen[0]?.mcp).toMatchObject({ url: 'https://baton/mcp', apiKey: 'bat_key' });
    expect(calls).toEqual([
      {
        call: 'setSession',
        args: ['job-1', { runnerId: 'r1', harness: 'claude', sessionId: 'sess-1' }],
      },
      {
        call: 'finish',
        args: [
          'job-1',
          'complete',
          expect.objectContaining({
            usage: [expect.objectContaining({ harness: 'claude', model: 'opus', outcome: 'done' })],
            outcome: 'done',
            error: null,
          }),
        ],
      },
    ]);
  });

  it('moves down the chain when a harness is out of usage, resuming its session', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls, exhausted } = setup(
      [
        { harness: 'claude', model: 'opus', effort: '' },
        { harness: 'codex', model: '', effort: 'high' },
      ],
      [
        fakeAdapter('claude', [{ outcome: 'out_of_usage', resetAt: 9_999_999_999_999 }], seen),
        fakeAdapter('codex', [{ outcome: 'done' }], seen),
      ],
    );
    await ready(runner);
    await runner.runJob(job);
    expect(exhausted.claude).toBe(9_999_999_999_999);
    expect(seen.map((options) => options.resumeId)).toEqual([null, 'thread-9']);
    const finish = calls.find((call) => call.call === 'finish');
    expect(finish?.args[1]).toBe('complete');
    expect(
      (finish?.args[2] as { usage: Array<{ outcome: string }> }).usage.map((u) => u.outcome),
    ).toEqual(['out_of_usage', 'done']);
  });

  it('skips harnesses that aren’t installed, and holds jobs no harness here can run', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls } = setup(
      [{ harness: 'gemini', model: '', effort: '' }],
      [fakeAdapter('claude', [], seen)],
    );
    await ready(runner);
    await runner.runJob(job);
    expect(seen).toEqual([]);
    expect(calls).toEqual([
      {
        call: 'finish',
        args: [
          'job-1',
          'release',
          expect.objectContaining({
            usage: [],
            hold: true,
            // BAT#23: why, for Stopped runs.
            outcome: 'no_harness',
            error: expect.stringContaining('None of this job’s harnesses are installed here'),
          }),
        ],
      },
    ]);
  });

  it('holds a killed job for the owner’s OK', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls } = setup(
      [{ harness: 'claude', model: '', effort: '' }],
      [fakeAdapter('claude', [{ outcome: 'killed' }], seen)],
    );
    await ready(runner);
    const running = runner.runJob(job);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.snapshot().jobs.map((item) => item.jobId)).toEqual(['job-1']);
    runner.kill('job-1');
    await running;
    const finish = calls.find((call) => call.call === 'finish');
    expect(finish?.args.slice(1)).toEqual([
      'release',
      expect.objectContaining({
        usage: [expect.objectContaining({ outcome: 'killed' })],
        hold: true,
        outcome: 'killed',
      }),
    ]);
    expect(runner.snapshot().jobs).toEqual([]);
  });

  it('kills a job cancelled on Baton (its task was deleted) and releases it without holding', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls, server } = setup(
      [{ harness: 'claude', model: '', effort: '' }],
      [fakeAdapter('claude', [{ outcome: 'killed' }], seen)],
    );
    await ready(runner);
    const running = runner.runJob(job);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(1);
    server.cancelledJobIds = ['job-1'];
    // The heartbeat names the running jobs; its answer names the cancelled ones.
    await runner.start();
    await running;
    runner.stop();
    expect(calls.find((call) => call.call === 'heartbeat')?.args[1]).toMatchObject({
      running: 1,
      jobIds: ['job-1'],
      activeJobIds: ['job-1'],
    });
    const finish = calls.find((call) => call.call === 'finish');
    expect(finish?.args.slice(1)).toEqual([
      'release',
      {
        usage: [expect.objectContaining({ outcome: 'killed' })],
        outcome: 'killed',
        error: null,
        output: expect.stringContaining('cancelled on Baton'),
      },
    ]);
    expect(runner.snapshot().jobs).toEqual([]);
  });

  it('waits on usage, and Retry now runs it at once ignoring the stored limit (BAT#30)', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls, exhausted } = setup(
      [{ harness: 'codex', model: '', effort: '' }],
      [fakeAdapter('codex', [{ outcome: 'done' }], seen)],
    );
    exhausted.codex = Date.now() + 5 * 3_600_000;
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    const [waiting] = runner.snapshot().jobs;
    expect(waiting).toMatchObject({
      state: 'waiting-usage',
      waitingOn: [{ harness: 'codex', until: exhausted.codex }],
    });
    expect(waiting?.note).toMatch(/^Out of usage until .* \(Codex\)\.$/);
    expect(seen).toEqual([]);
    runner.retryNow('job-1');
    await running;
    expect(seen).toHaveLength(1);
    expect(calls.find((call) => call.call === 'finish')?.args[1]).toBe('complete');
    // Only that attempt ignores it: the stored limit stays until it resets or is cleared.
    expect(exhausted.codex).toBeGreaterThan(Date.now());
  });

  it('reports which jobs a harness runs, heartbeating early when that changes (BAT#42)', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls, exhausted } = setup(
      [{ harness: 'codex', model: '', effort: '' }],
      [fakeAdapter('codex', [{ outcome: 'killed' }], seen)],
    );
    exhausted.codex = Date.now() + 5 * 3_600_000;
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    await runner.start();
    await tick();
    const beats = () =>
      calls
        .filter((call) => call.call === 'heartbeat')
        .map((call) => call.args[1] as { jobIds: string[]; activeJobIds: string[] });
    // Waiting on usage: on the machine, but not working.
    expect(beats()).toEqual([expect.objectContaining({ jobIds: ['job-1'], activeJobIds: [] })]);
    runner.clearUsageLimit('codex');
    await tick();
    expect(seen).toHaveLength(1);
    // The harness started: Baton hears it within seconds, not at the next 30 s heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(beats().at(-1)).toMatchObject({ jobIds: ['job-1'], activeJobIds: ['job-1'] });
    runner.kill('job-1');
    await running;
    runner.stop();
  });

  it('Clear usage limit forgets the harness’s limit and the waiting job runs', async () => {
    const seen: RunOptions[] = [];
    const { runner, exhausted } = setup(
      [{ harness: 'codex', model: '', effort: '' }],
      [fakeAdapter('codex', [{ outcome: 'done' }], seen)],
    );
    exhausted.codex = Date.now() + 5 * 3_600_000;
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    runner.clearUsageLimit('codex');
    await running;
    expect(exhausted.codex).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('Kill stops a job waiting on usage and holds it; Retry now applies to its next claim', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls, exhausted } = setup(
      [{ harness: 'codex', model: '', effort: '' }],
      [fakeAdapter('codex', [{ outcome: 'done' }], seen)],
    );
    exhausted.codex = Date.now() + 5 * 3_600_000;
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    runner.kill('job-1');
    await running;
    expect(seen).toEqual([]);
    expect(calls.filter((call) => call.call === 'finish')).toEqual([
      {
        call: 'finish',
        args: [
          'job-1',
          'release',
          expect.objectContaining({ usage: [], hold: true, outcome: 'killed' }),
        ],
      },
    ]);
    expect(runner.snapshot().jobs).toEqual([]);
    expect(runner.snapshot().finished[0]).toMatchObject({ jobId: 'job-1', outcome: 'killed' });
    // The owner retries the held job: claimed again, it runs despite the stored limit.
    runner.retryNow('job-1');
    await runner.runJob(job);
    expect(seen).toHaveLength(1);
  });

  it('a harness out of usage for real is stored as exhausted, with the harness’s own error', async () => {
    const seen: RunOptions[] = [];
    const { runner, exhausted } = setup(
      [
        { harness: 'codex', model: '', effort: '' },
        { harness: 'claude', model: '', effort: '' },
      ],
      [
        fakeAdapter(
          'codex',
          [{ outcome: 'out_of_usage', resetAt: null, error: 'You’ve hit your usage limit.' }],
          seen,
        ),
        fakeAdapter('claude', [{ outcome: 'done' }], seen),
      ],
    );
    await ready(runner);
    const outputs: string[] = [];
    runner.on('output', ({ text }: { text: string }) => outputs.push(text));
    await runner.runJob(job);
    expect(exhausted.codex).toBeGreaterThan(Date.now());
    expect(outputs.join('\n')).toContain('Codex is out of usage until');
    expect(outputs.join('\n')).toContain('You’ve hit your usage limit.');
  });

  it('delivers a reply on the same task into the running session instead of a second run (BAT#31)', async () => {
    const seen: RunOptions[] = [];
    const sent: string[] = [];
    let finishRun: () => void = () => undefined;
    const claude: HarnessAdapter = {
      ...fakeAdapter('claude', [], []),
      run: (options) => {
        seen.push(options);
        options.attach?.({
          send: (text) => {
            sent.push(text);
            setTimeout(() => options.onEvent({ type: 'delivered' }), 0);
            return true;
          },
        });
        return new Promise((resolve) => {
          finishRun = () => resolve(result({ sessionId: 'sess-1' }));
        });
      },
    };
    const { runner, calls } = setup([{ harness: 'claude', model: '', effort: '' }], [claude]);
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    await runner.runJob(reply);
    await tick();
    expect(seen).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('@caden wrote on baton/BAT-24');
    expect(sent[0]).toContain('> Please also cover Windows');
    expect(sent[0]).toContain('The Baton app completes job `job-2` for you');
    expect(runner.snapshot().jobs).toEqual([
      expect.objectContaining({ jobId: 'job-1', delivered: 1, queued: 0 }),
    ]);
    expect(calls).toContainEqual({
      call: 'finish',
      args: ['job-2', 'complete', { usage: [], deliveredTo: 'job-1' }],
    });
    finishRun();
    await running;
    expect(calls.filter((call) => call.call === 'finish').map((call) => call.args[0])).toEqual([
      'job-2',
      'job-1',
    ]);
  });

  it('queues it for a harness without mid-run input and resumes the same session with it', async () => {
    const seen: RunOptions[] = [];
    const releases: Array<() => void> = [];
    const codex: HarnessAdapter = {
      ...fakeAdapter('codex', [], []),
      run: (options) => {
        seen.push(options);
        return new Promise((resolve) => {
          releases.push(() => resolve(result({ sessionId: 'thread-9' })));
        });
      },
    };
    const { runner, calls } = setup([{ harness: 'codex', model: '', effort: '' }], [codex]);
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    await runner.runJob(reply);
    await runner.runJob({ ...reply, jobId: 'job-3', trigger: { body: 'And Linux' } });
    expect(runner.snapshot().jobs[0]).toMatchObject({ queued: 2, delivered: 0 });
    expect(seen).toHaveLength(1);
    releases[0]?.();
    await tick();
    // One resumed run with both messages, not fresh runs.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.resumeId).toBe('thread-9');
    expect(seen[1]?.prompt).toContain('Please also cover Windows');
    expect(seen[1]?.prompt).toContain('And Linux');
    expect(seen[1]?.prompt).not.toContain('# Baton job');
    expect(runner.snapshot().jobs[0]).toMatchObject({ queued: 0, delivered: 2 });
    releases[1]?.();
    await running;
    const finishes = calls.filter((call) => call.call === 'finish');
    expect(finishes.map((call) => [call.args[0], call.args[1]])).toEqual([
      ['job-2', 'complete'],
      ['job-3', 'complete'],
      ['job-1', 'complete'],
    ]);
  });

  it('releases queued messages when the running job is killed first, so they run on their own', async () => {
    const seen: RunOptions[] = [];
    const { runner, calls } = setup(
      [{ harness: 'codex', model: '', effort: '' }],
      [fakeAdapter('codex', [{ outcome: 'killed' }], seen)],
    );
    await ready(runner);
    const running = runner.runJob(job);
    await tick();
    await runner.runJob(reply);
    runner.kill('job-1');
    await running;
    expect(seen).toHaveLength(1);
    expect(calls.filter((call) => call.call === 'finish')).toEqual([
      {
        call: 'finish',
        args: [
          'job-1',
          'release',
          expect.objectContaining({
            usage: [expect.objectContaining({ outcome: 'killed' })],
            hold: true,
            outcome: 'killed',
          }),
        ],
      },
      { call: 'finish', args: ['job-2', 'release', { usage: [] }] },
    ]);
  });

  it('runs jobs about different items in parallel', async () => {
    const seen: RunOptions[] = [];
    const { runner } = setup(
      [{ harness: 'claude', model: '', effort: '' }],
      [fakeAdapter('claude', [{ outcome: 'killed' }, { outcome: 'killed' }], seen)],
    );
    await ready(runner);
    const first = runner.runJob(job);
    const second = runner.runJob({
      ...reply,
      target: { ...job.target, ref: 'baton/BAT-25', title: 'Other task' },
    });
    await tick();
    expect(seen).toHaveLength(2);
    expect(runner.snapshot().jobs.map((item) => item.jobId)).toEqual(['job-1', 'job-2']);
    runner.kill('job-1');
    runner.kill('job-2');
    await Promise.all([first, second]);
  });

  it('holds jobs of projects without a folder here', async () => {
    const { runner, calls } = setup(
      [{ harness: 'claude', model: '', effort: '' }],
      [fakeAdapter('claude', [], [])],
      null,
    );
    await ready(runner);
    await runner.runJob(job);
    expect(calls).toEqual([
      {
        call: 'finish',
        args: [
          'job-1',
          'release',
          { usage: [], hold: true, outcome: 'no_folder', error: expect.any(String), output: '' },
        ],
      },
    ]);
  });
});
