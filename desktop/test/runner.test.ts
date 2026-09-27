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
    pausedHere: () => false,
  };
  const runner = new Runner(
    api,
    new Map(adapters.map((adapter) => [adapter.id, adapter])),
    store,
    null,
  );
  return { runner, calls, exhausted };
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
          {
            usage: [expect.objectContaining({ harness: 'claude', model: 'opus', outcome: 'done' })],
          },
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
      { call: 'finish', args: ['job-1', 'release', { usage: [], hold: true }] },
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
      { usage: [expect.objectContaining({ outcome: 'killed' })], hold: true },
    ]);
    expect(runner.snapshot().jobs).toEqual([]);
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
      { call: 'finish', args: ['job-1', 'release', { usage: [], hold: true }] },
    ]);
  });
});
