import { EventEmitter } from 'node:events';
import { runnableChain } from '@shared/agentChains';
import type {
  ChainEntry,
  HarnessId,
  HarnessInfo,
  JobBrief,
  JobUsage,
} from '@shared/schemas/agentRunner';
import { ApiError, type BatonApi, type RunnerJob } from './api';
import type { HarnessAdapter, RunResult } from './harness/types';
import { DEFAULT_BACKOFF_MS } from './harness/usageLimits';

/**
 * The runner (BAT-24): registers this machine, heartbeats, long-polls the server for the jobs of
 * the projects mapped to folders here (no tokens while idle), and runs each job in a fresh
 * headless harness session, with no cap on how many run at once. A job's chain is tried in
 * order: harnesses not installed or out of usage until later are skipped, and a harness that
 * runs out of usage mid-job hands the job to the next one. A killed or failed run goes back to
 * the owner ("Waiting for your OK") rather than straight back into the queue.
 */

const HEARTBEAT_MS = 30_000;
const POLL_WAIT_S = 50;
const OUTPUT_LINES = 400;

export interface RunnerStore {
  machineId(): string;
  machineName(): string;
  /** Mapped project ids. */
  projectIds(): string[];
  /** The folder a project's jobs run in (null: not mapped here). */
  folderFor(projectId: string): string | null;
  permissionMode(harness: HarnessId, adapter: HarnessAdapter): string;
  exhaustedUntil(): Partial<Record<HarnessId, number>>;
  setExhausted(harness: HarnessId, until: number): void;
  pausedHere(): boolean;
}

export interface PermissionHost {
  urlFor(jobId: string): string;
  token: string;
}

export type RunningState = 'starting' | 'running' | 'blocked' | 'waiting-usage' | 'finishing';

export interface RunningJob {
  jobId: string;
  ref: string | null;
  title: string | null;
  url: string | null;
  project: string | null;
  kind: string;
  harness: HarnessId | null;
  model: string;
  startedAt: number;
  state: RunningState;
  note: string | null;
  output: string[];
  controller: AbortController;
}

export type RunnerStatus = 'stopped' | 'connecting' | 'online' | 'paused' | 'offline';

export interface RunnerSnapshot {
  status: RunnerStatus;
  statusText: string | null;
  runnerId: string | null;
  waitingCount: number;
  jobs: Array<Omit<RunningJob, 'controller'>>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class Runner extends EventEmitter {
  private status: RunnerStatus = 'stopped';
  private statusText: string | null = null;
  private runnerId: string | null = null;
  private waitingCount = 0;
  private readonly running = new Map<string, RunningJob>();
  private installed = new Map<HarnessId, HarnessInfo>();
  private stopController: AbortController | null = null;

  constructor(
    private readonly api: BatonApi,
    private readonly adapters: Map<HarnessId, HarnessAdapter>,
    private readonly store: RunnerStore,
    private readonly permissions: PermissionHost | null,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  snapshot(): RunnerSnapshot {
    return {
      status: this.status,
      statusText: this.statusText,
      runnerId: this.runnerId,
      waitingCount: this.waitingCount,
      jobs: [...this.running.values()].map(({ controller: _controller, ...job }) => ({
        ...job,
        output: job.output.slice(-OUTPUT_LINES),
      })),
    };
  }

  private changed() {
    this.emit('change', this.snapshot());
  }

  private setStatus(status: RunnerStatus, text: string | null = null) {
    if (status === this.status && text === this.statusText) return;
    this.status = status;
    this.statusText = text;
    this.changed();
  }

  /** Installed harnesses on this machine (detected again on every start). */
  async detect(): Promise<Map<HarnessId, HarnessInfo>> {
    const found = new Map<HarnessId, HarnessInfo>();
    for (const [id, adapter] of this.adapters) {
      const result = await adapter.detect();
      if (result.installed) found.set(id, { id, version: result.version });
    }
    this.installed = found;
    return found;
  }

  async start(): Promise<void> {
    if (this.stopController) return;
    const controller = new AbortController();
    this.stopController = controller;
    this.setStatus('connecting');
    await this.detect();
    void this.heartbeatLoop(controller.signal);
    void this.pollLoop(controller.signal);
  }

  stop(): void {
    this.stopController?.abort();
    this.stopController = null;
    this.setStatus('stopped');
  }

  /** Stops a running job; it goes back to its owner ("Waiting for your OK"). */
  kill(jobId: string): void {
    this.running.get(jobId)?.controller.abort();
  }

  private async register(): Promise<string> {
    const state = await this.api.register({
      machineId: this.store.machineId(),
      machineName: this.store.machineName(),
      harnesses: [...this.installed.values()],
      projectIds: this.store.projectIds(),
    });
    this.runnerId = state.runner.id;
    this.waitingCount = state.waitingCount;
    this.setStatus(state.paused ? 'paused' : 'online', state.pausedReason);
    return state.runner.id;
  }

  /** Re-registers with the current folders and harnesses (after the setup changes). */
  async refresh(): Promise<void> {
    if (!this.stopController) return;
    await this.detect();
    await this.register().catch((error: unknown) => this.onError(error));
  }

  private onError(error: unknown) {
    if (error instanceof ApiError && error.code === 'agents_paused') {
      this.setStatus('paused', error.message);
    } else {
      this.setStatus('offline', error instanceof Error ? error.message : String(error));
    }
  }

  private async heartbeatLoop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const runnerId = this.runnerId ?? (await this.register());
        const state = await this.api.heartbeat(runnerId, {
          running: this.running.size,
          harnesses: [...this.installed.values()],
          projectIds: this.store.projectIds(),
        });
        this.waitingCount = state.waitingCount;
        this.setStatus(
          state.paused ? 'paused' : this.store.pausedHere() ? 'paused' : 'online',
          state.pausedReason ?? (this.store.pausedHere() ? 'Paused on this machine' : null),
        );
        this.changed();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) this.runnerId = null;
        this.onError(error);
      }
      await sleep(HEARTBEAT_MS, signal);
    }
  }

  private async pollLoop(signal: AbortSignal) {
    let backoff = 2_000;
    while (!signal.aborted) {
      if (
        this.store.pausedHere() ||
        this.status === 'paused' ||
        this.store.projectIds().length === 0
      ) {
        await sleep(5_000, signal);
        continue;
      }
      try {
        const runnerId = this.runnerId ?? (await this.register());
        const { jobs } = await this.api.nextJobs(runnerId, POLL_WAIT_S, signal);
        backoff = 2_000;
        if (this.status !== 'online') this.setStatus('online');
        for (const job of jobs) void this.runJob(job);
      } catch (error) {
        if (signal.aborted) return;
        this.onError(error);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Runs one job along its chain and reports it (exported for the test job and tests). */
  async runJob(job: RunnerJob): Promise<void> {
    const runnerId = this.runnerId;
    if (!runnerId) return;
    const entry: RunningJob = {
      jobId: job.jobId,
      ref: job.target.ref,
      title: job.target.title,
      url: job.target.url,
      project: job.project?.ref ?? null,
      kind: job.kind,
      harness: null,
      model: '',
      startedAt: this.now(),
      state: 'starting',
      note: null,
      output: [],
      controller: new AbortController(),
    };
    this.running.set(job.jobId, entry);
    this.changed();
    const usage: JobUsage[] = [];
    try {
      const brief = await this.api.brief(job.jobId, runnerId);
      const folder = job.project ? this.store.folderFor(job.project.id) : null;
      if (!folder) {
        entry.note = 'Needs a folder: map its project in Projects & folders.';
        await this.api.finish(job.jobId, 'release', { usage: [], hold: true });
        return;
      }
      const outcome = await this.runChain(entry, brief, folder, usage);
      entry.state = 'finishing';
      this.changed();
      if (outcome === 'done') {
        await this.api.finish(job.jobId, 'complete', { usage });
      } else {
        await this.api.finish(job.jobId, 'release', { usage, hold: outcome !== 'out_of_usage' });
      }
    } catch (error) {
      entry.note = error instanceof Error ? error.message : String(error);
      await this.api.finish(job.jobId, 'release', { usage, hold: true }).catch(() => undefined);
    } finally {
      this.running.delete(job.jobId);
      this.changed();
      this.emit('finished', { ...entry, controller: undefined });
    }
  }

  /**
   * Runs the chain: each runnable entry in turn until one finishes (done, failed, killed or
   * denied). Out of usage marks the harness exhausted and moves on; when every entry is out of
   * usage, waits for the earliest reset (the job stays claimed here) and tries again.
   */
  private async runChain(
    entry: RunningJob,
    brief: JobBrief,
    cwd: string,
    usage: JobUsage[],
  ): Promise<RunResult['outcome'] | 'no_harness'> {
    const { signal } = entry.controller;
    for (;;) {
      const installed = new Set(this.installed.keys());
      const exhausted = new Map(
        Object.entries(this.store.exhaustedUntil()) as Array<[HarnessId, number]>,
      );
      const chain = runnableChain(brief.chain, installed, exhausted, this.now());
      if (chain.length === 0) {
        const pending = brief.chain.filter((step) => installed.has(step.harness));
        if (pending.length === 0) {
          entry.note = `None of this job’s harnesses are installed here (${brief.chain
            .map((step) => step.harness)
            .join(', ')}).`;
          return 'no_harness';
        }
        const until = Math.min(...pending.map((step) => exhausted.get(step.harness) ?? this.now()));
        entry.state = 'waiting-usage';
        entry.note = `Out of usage; trying again at ${new Date(until).toLocaleTimeString()}.`;
        this.changed();
        await sleep(Math.max(until - this.now(), 1_000), signal);
        if (signal.aborted) return 'killed';
        continue;
      }
      for (const step of chain) {
        const result = await this.runStep(entry, brief, cwd, step);
        usage.push({
          harness: step.harness,
          model: step.model,
          effort: step.effort,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          outcome: result.outcome,
        });
        if (result.sessionId) {
          await this.api
            .setSession(brief.jobId, {
              runnerId: this.runnerId ?? '',
              harness: step.harness,
              sessionId: result.sessionId,
            })
            .catch(() => undefined);
        }
        if (result.outcome === 'out_of_usage') {
          this.store.setExhausted(step.harness, result.resetAt ?? this.now() + DEFAULT_BACKOFF_MS);
          this.log(entry, `${step.harness} is out of usage; moving on to the next harness.`);
          continue;
        }
        if (result.outcome !== 'done' && result.error) entry.note = result.error;
        return result.outcome;
      }
    }
  }

  private async runStep(entry: RunningJob, brief: JobBrief, cwd: string, step: ChainEntry) {
    const adapter = this.adapters.get(step.harness);
    if (!adapter) throw new Error(`No adapter for ${step.harness}`);
    entry.harness = step.harness;
    entry.model = step.model;
    entry.state = 'running';
    entry.note = null;
    this.changed();
    const mode = this.store.permissionMode(step.harness, adapter);
    return adapter.run({
      cwd,
      prompt: brief.prompt,
      model: step.model,
      effort: step.effort,
      resumeId: brief.resume[step.harness] ?? null,
      permissionMode: mode,
      mcp: {
        url: this.api.mcpUrl,
        apiKey: this.api.key,
        permissionServer: this.permissions
          ? { url: this.permissions.urlFor(brief.jobId), token: this.permissions.token }
          : null,
      },
      signal: entry.controller.signal,
      onEvent: (event) => {
        if (event.type === 'output' || event.type === 'log') this.log(entry, event.text);
        else if (event.type === 'status') this.log(entry, event.text);
      },
    });
  }

  /** The job is waiting on an Allow / Deny pop-up (or not any more). */
  setBlocked(jobId: string, blocked: boolean, what: string | null = null): void {
    const entry = this.running.get(jobId);
    if (!entry) return;
    entry.state = blocked ? 'blocked' : 'running';
    entry.note = blocked ? `Blocked on a permission: ${what ?? ''}` : null;
    this.log(entry, blocked ? `⏸ Waiting for your OK to ${what ?? 'continue'}` : '▶ Continuing');
  }

  private log(entry: RunningJob, text: string) {
    for (const line of text.split(/\r?\n/)) entry.output.push(line);
    if (entry.output.length > OUTPUT_LINES * 2)
      entry.output.splice(0, entry.output.length - OUTPUT_LINES);
    this.emit('output', { jobId: entry.jobId, text });
    this.changed();
  }
}
