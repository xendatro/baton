import { EventEmitter } from 'node:events';
import { runnableChain } from '@shared/agentChains';
import {
  HARNESS_LABELS,
  type ChainEntry,
  type FinishJobInput,
  type HarnessId,
  type HarnessInfo,
  type JobBrief,
  type JobUsage,
  type RunOutcome,
} from '@shared/schemas/agentRunner';
import { ApiError, type BatonApi, type RunnerJob } from './api';
import type { HarnessAdapter, RunControls, RunResult } from './harness/types';
import { DEFAULT_BACKOFF_MS } from './harness/usageLimits';

/**
 * The runner (BAT-24): registers this machine, heartbeats, long-polls the server for the jobs of
 * the projects mapped to folders here (no tokens while idle), and runs each job in a fresh
 * headless harness session, with no cap on how many run at once. A job's chain is tried in
 * order: harnesses not installed or out of usage until later are skipped, and a harness that
 * runs out of usage mid-job hands the job to the next one. A killed or failed run goes back to
 * the owner ("Waiting for your OK") rather than straight back into the queue. A job cancelled on
 * Baton meanwhile (its task was deleted, BAT-33) is killed when a heartbeat reports it, and isn't
 * held.
 *
 * BAT#30: a job waiting on usage can be retried now (ignoring the stored limits once) or killed,
 * and a harness's stored limit can be cleared. BAT#31: a job about an item that a job running
 * here already works on doesn't start a second session: its message goes to the running one
 * (mid-run when the harness takes input, else as soon as the run ends, resuming its session),
 * and the job is completed on Baton once the session has it.
 */

const HEARTBEAT_MS = 30_000;
/** BAT#42: an early heartbeat (a harness started or stopped) comes at most this often. */
const EARLY_HEARTBEAT_GAP_MS = 2_000;
const POLL_WAIT_S = 50;
const OUTPUT_LINES = 400;
/** Output lines reported to Baton when a job ends (BAT#23). */
const REPORTED_OUTPUT_LINES = 200;
const FINISHED_KEPT = 20;
/** "Retry now" on a job not running here counts for its next claim within this time. */
const RETRY_WINDOW_MS = 10 * 60 * 1000;

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
  /** Forgets a harness's stored usage limit (the owner's "Clear usage limit"). */
  clearExhausted(harness: HarnessId): void;
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
  /** The chain step's effort ('' = the harness's default). */
  effort: string;
  startedAt: number;
  state: RunningState;
  note: string | null;
  output: string[];
  /** Waiting on usage: the chain's harnesses here and when each may run again. */
  waitingOn: Array<{ harness: HarnessId; until: number }>;
  /** BAT#31: messages of later jobs about the same item that the session has taken in… */
  delivered: number;
  /** …and those waiting for its next turn. */
  queued: number;
  controller: AbortController;
}

/** A job that ended here recently, with why (shown next to the jobs waiting for the owner). */
export interface FinishedJob {
  jobId: string;
  ref: string | null;
  title: string | null;
  harness: HarnessId | null;
  outcome: string;
  note: string | null;
  finishedAt: number;
}

export type RunnerStatus = 'stopped' | 'connecting' | 'online' | 'paused' | 'offline';

export interface RunnerSnapshot {
  status: RunnerStatus;
  statusText: string | null;
  runnerId: string | null;
  waitingCount: number;
  jobs: Array<Omit<RunningJob, 'controller'>>;
  finished: FinishedJob[];
}

/** A later job's message for a running session (BAT#31). */
interface Merged {
  jobId: string;
  text: string;
}

/** What the runner keeps about a running job besides what it shows. */
interface JobInternals {
  /** `task:<id>`: jobs about the same item share a session. */
  targetKey: string | null;
  /** The running harness session's controls, while it takes messages. */
  controls: RunControls | null;
  /** Sent to the running session, not taken in yet (oldest first). */
  sent: Merged[];
  /** Not sent yet: they go with the session's next run. */
  queue: Merged[];
  /** "Retry now": the next attempt ignores the stored usage limits. */
  ignoreLimits: boolean;
  /** Aborted to end a wait for usage early. */
  wake: AbortController;
  /** Items the current run created or replied in (their sessions resume this one). */
  touched: Set<string>;
}

/** Waits `ms`, or until any of `signals` aborts (at once when one already has). */
function sleep(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((signal) => signal.aborted)) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    for (const signal of signals) signal.addEventListener('abort', done, { once: true });
  });
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Out of usage until 01:00 (Codex), 03:00 (Claude Code)". */
export function usageNote(waitingOn: ReadonlyArray<{ harness: HarnessId; until: number }>): string {
  return `Out of usage until ${waitingOn
    .map((item) => `${clock(item.until)} (${HARNESS_LABELS[item.harness]})`)
    .join(', ')}.`;
}

function targetKeyOf(job: RunnerJob): string | null {
  const id = job.target.id ?? job.target.ref;
  return id ? `${job.target.type}:${id}` : null;
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** The message a later job about the same item puts into the running session. */
export function mergedMessage(job: RunnerJob): string {
  const who = job.trigger?.author?.username ?? job.triggeredBy ?? null;
  const ref = job.target.ref ?? 'this item';
  const what = job.trigger
    ? `@${who ?? 'someone'} wrote on ${ref}${job.trigger.replyId ? ` (reply id \`${job.trigger.replyId}\`)` : ''}:\n\n${quote(job.trigger.body)}`
    : `${job.kind.replace('_', ' ')} on ${ref}${who ? ` by @${who}` : ''}${job.instructions ? `:\n\n${job.instructions}` : '.'}`;
  return [
    `New in Baton while you work on ${ref} (Baton job \`${job.jobId}\`). ${what}`,
    `Take it into account in what you are doing; if it asks something, answer in the thread with add_reply. The Baton app completes job \`${job.jobId}\` for you: don’t call complete_job or release_job for it.`,
  ].join('\n\n');
}

export class Runner extends EventEmitter {
  private status: RunnerStatus = 'stopped';
  private statusText: string | null = null;
  private runnerId: string | null = null;
  private waitingCount = 0;
  private readonly running = new Map<string, RunningJob>();
  private readonly internals = new Map<string, JobInternals>();
  /** Running jobs cancelled on Baton: killed, and released without holding them. */
  private readonly cancelled = new Set<string>();
  /** "Retry now" on jobs not running here: job id → until when it counts. */
  private readonly retrying = new Map<string, number>();
  private finished: FinishedJob[] = [];
  private installed = new Map<HarnessId, HarnessInfo>();
  private stopController: AbortController | null = null;
  /** BAT#42: the active jobs the last heartbeat reported; a change wakes the heartbeat early. */
  private reportedActive = '';
  private heartbeatWake = new AbortController();

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
      finished: this.finished,
    };
  }

  private changed() {
    this.emit('change', this.snapshot());
    // BAT#42: Baton shows "… is working" from the heartbeat; tell it now, not in up to 30 s.
    if (this.activeJobIds().join(',') !== this.reportedActive) this.heartbeatWake.abort();
  }

  /** Jobs whose harness is running now (not starting, waiting on usage or finishing). */
  private activeJobIds(): string[] {
    return [...this.running.values()]
      .filter((job) => job.state === 'running' || job.state === 'blocked')
      .map((job) => job.jobId);
  }

  private setStatus(status: RunnerStatus, text: string | null = null) {
    if (status === this.status && text === this.statusText) return;
    this.status = status;
    this.statusText = text;
    this.changed();
  }

  /**
   * Installed harnesses on this machine (detected again on every start), with the models and
   * efforts each reports, which Baton's model pickers offer. A harness that can't say still
   * counts as installed (sent without them).
   */
  async detect(): Promise<Map<HarnessId, HarnessInfo>> {
    const found = new Map<HarnessId, HarnessInfo>();
    for (const [id, adapter] of this.adapters) {
      const result = await adapter.detect();
      if (!result.installed) continue;
      const info: HarnessInfo = { id, version: result.version };
      try {
        const reported = await adapter.capabilities?.();
        if (reported) {
          info.models = reported.models;
          info.efforts = reported.efforts;
        }
      } catch {
        // Reported without models: Baton then accepts any model for it, unverified.
      }
      found.set(id, info);
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

  /**
   * Stops a running job, also one waiting on usage; it goes back to its owner ("Waiting for your
   * OK") and doesn't start again by itself.
   */
  kill(jobId: string): void {
    this.running.get(jobId)?.controller.abort();
  }

  /**
   * "Retry now" (BAT#30): the job's next attempt ignores the stored usage limits. A job waiting
   * on usage here tries at once; for one not running here (held for the owner's OK), it counts
   * when this computer claims it next.
   */
  retryNow(jobId: string): void {
    const internals = this.internals.get(jobId);
    if (internals) {
      internals.ignoreLimits = true;
      internals.wake.abort();
      return;
    }
    const now = this.now();
    for (const [id, until] of this.retrying) if (until <= now) this.retrying.delete(id);
    this.retrying.set(jobId, now + RETRY_WINDOW_MS);
  }

  /** "Clear usage limit" (BAT#30): forgets the harness's stored limit; waiting jobs try again. */
  clearUsageLimit(harness: HarnessId): void {
    this.store.clearExhausted(harness);
    for (const internals of this.internals.values()) internals.wake.abort();
    this.changed();
  }

  private takeRetry(jobId: string): boolean {
    const until = this.retrying.get(jobId);
    this.retrying.delete(jobId);
    return until !== undefined && until > this.now();
  }

  /** Kills the harness of jobs cancelled on Baton (e.g. their task was deleted, BAT-33). */
  cancel(jobIds: readonly string[]): void {
    for (const jobId of jobIds) {
      const entry = this.running.get(jobId);
      if (!entry || this.cancelled.has(jobId)) continue;
      this.cancelled.add(jobId);
      this.log(
        entry,
        '■ This job was cancelled on Baton (its task may have been deleted); stopping.',
      );
      entry.controller.abort();
    }
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
      const beatAt = this.now();
      try {
        const runnerId = this.runnerId ?? (await this.register());
        const active = this.activeJobIds();
        const state = await this.api.heartbeat(runnerId, {
          running: this.running.size,
          jobIds: [...this.running.keys()],
          activeJobIds: active,
          harnesses: [...this.installed.values()],
          projectIds: this.store.projectIds(),
        });
        this.reportedActive = active.join(',');
        this.waitingCount = state.waitingCount;
        this.cancel(state.cancelledJobIds ?? []);
        this.setStatus(
          state.paused ? 'paused' : this.store.pausedHere() ? 'paused' : 'online',
          state.pausedReason ?? (this.store.pausedHere() ? 'Paused on this machine' : null),
        );
        this.changed();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) this.runnerId = null;
        this.onError(error);
      }
      await sleep(HEARTBEAT_MS, signal, this.heartbeatWake.signal);
      if (this.heartbeatWake.signal.aborted) {
        this.heartbeatWake = new AbortController();
        await sleep(Math.max(0, beatAt + EARLY_HEARTBEAT_GAP_MS - this.now()), signal);
      }
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

  /** The running job already working on this item, if one still takes messages. */
  private hostFor(targetKey: string): RunningJob | null {
    for (const [jobId, internals] of this.internals) {
      const entry = this.running.get(jobId);
      if (
        entry &&
        internals.targetKey === targetKey &&
        entry.state !== 'finishing' &&
        !entry.controller.signal.aborted &&
        !this.cancelled.has(jobId)
      ) {
        return entry;
      }
    }
    return null;
  }

  /**
   * BAT#31: a job about an item a running job works on goes to that session instead of a new
   * one: sent now when the harness takes messages mid-run, else queued for its next run.
   */
  private merge(host: RunningJob, job: RunnerJob) {
    const internals = this.internals.get(host.jobId);
    if (!internals) return;
    const message: Merged = { jobId: job.jobId, text: mergedMessage(job) };
    const who = job.trigger?.author?.username ?? job.triggeredBy;
    const what = `${job.kind.replace('_', ' ')}${who ? ` from @${who}` : ''}`;
    if (internals.controls?.send(message.text)) {
      internals.sent.push(message);
      this.log(host, `✉ New ${what}: sent to the running session (read after its current step).`);
    } else {
      internals.queue.push(message);
      this.log(host, `✉ New ${what}: queued for this session’s next turn.`);
    }
    this.count(host, internals);
  }

  private count(entry: RunningJob, internals: JobInternals) {
    entry.queued = internals.sent.length + internals.queue.length;
    this.changed();
  }

  /** The session has the message: its job is done on Baton. */
  private delivered(entry: RunningJob, internals: JobInternals, message: Merged) {
    entry.delivered += 1;
    this.count(entry, internals);
    void this.api
      .finish(message.jobId, 'complete', { usage: [], deliveredTo: entry.jobId })
      .catch(() => undefined);
  }

  /** Runs one job along its chain and reports it (exported for the test job and tests). */
  async runJob(job: RunnerJob): Promise<void> {
    const runnerId = this.runnerId;
    if (!runnerId) return;
    const targetKey = targetKeyOf(job);
    const host = targetKey ? this.hostFor(targetKey) : null;
    if (host) {
      this.merge(host, job);
      return;
    }
    const entry: RunningJob = {
      jobId: job.jobId,
      ref: job.target.ref,
      title: job.target.title,
      url: job.target.url,
      project: job.project?.ref ?? null,
      kind: job.kind,
      harness: null,
      model: '',
      effort: '',
      startedAt: this.now(),
      state: 'starting',
      note: null,
      output: [],
      waitingOn: [],
      delivered: 0,
      queued: 0,
      controller: new AbortController(),
    };
    const internals: JobInternals = {
      targetKey,
      controls: null,
      sent: [],
      queue: [],
      ignoreLimits: this.takeRetry(job.jobId),
      wake: new AbortController(),
      touched: new Set(),
    };
    this.running.set(job.jobId, entry);
    this.internals.set(job.jobId, internals);
    this.changed();
    const usage: JobUsage[] = [];
    let outcome: RunOutcome = 'failed';
    try {
      const brief = await this.api.brief(job.jobId, runnerId);
      const folder = job.project ? this.store.folderFor(job.project.id) : null;
      if (!folder) {
        entry.note = 'Needs a folder: map its project in Projects & folders.';
        outcome = 'no_folder';
        await this.api.finish(job.jobId, 'release', {
          usage: [],
          hold: true,
          ...this.report(entry, 'no_folder'),
        });
        return;
      }
      outcome = await this.runChain(entry, internals, brief, folder, usage);
      entry.state = 'finishing';
      this.changed();
      // BAT#23: how it ended, its last error and the output's tail go to Baton with the usage.
      const report = this.report(entry, outcome);
      if (this.cancelled.has(job.jobId)) {
        entry.note = 'Cancelled on Baton; stopped.';
        await this.api.finish(job.jobId, 'release', { usage, ...report });
      } else if (outcome === 'done') {
        await this.api.finish(job.jobId, 'complete', { usage, ...report });
      } else {
        await this.api.finish(job.jobId, 'release', {
          usage,
          hold: outcome !== 'out_of_usage',
          ...report,
        });
      }
    } catch (error) {
      entry.note = error instanceof Error ? error.message : String(error);
      await this.api
        .finish(job.jobId, 'release', {
          usage,
          hold: !this.cancelled.has(job.jobId),
          ...this.report(entry, 'error'),
        })
        .catch(() => undefined);
    } finally {
      this.running.delete(job.jobId);
      this.internals.delete(job.jobId);
      this.cancelled.delete(job.jobId);
      // Messages the session never took in: their jobs run on their own after all.
      for (const message of [...internals.sent, ...internals.queue]) {
        await this.api.finish(message.jobId, 'release', { usage: [] }).catch(() => undefined);
      }
      this.finished = [
        {
          jobId: entry.jobId,
          ref: entry.ref,
          title: entry.title,
          harness: entry.harness,
          outcome,
          note: entry.note,
          finishedAt: this.now(),
        },
        ...this.finished.filter((item) => item.jobId !== entry.jobId),
      ].slice(0, FINISHED_KEPT);
      this.changed();
      this.emit('finished', { ...entry, controller: undefined });
    }
  }

  /**
   * BAT#23: what Baton keeps of a run: how it ended, its last error (the note shown here) and the
   * tail of its output (the server keeps the last 200 lines); the full log stays in the app.
   */
  private report(
    entry: RunningJob,
    outcome: RunOutcome,
  ): Pick<FinishJobInput, 'outcome' | 'error' | 'output'> {
    return {
      outcome,
      error: outcome === 'done' ? null : entry.note,
      output: entry.output.slice(-REPORTED_OUTPUT_LINES).join('\n'),
    };
  }

  /**
   * Runs the chain: each runnable entry in turn until one finishes (done, failed, killed or
   * denied). Out of usage marks the harness exhausted and moves on; when every entry is out of
   * usage, waits for the earliest reset (the job stays claimed here) and tries again, at once
   * after "Retry now" or "Clear usage limit". Kill ends the wait.
   */
  private async runChain(
    entry: RunningJob,
    internals: JobInternals,
    brief: JobBrief,
    cwd: string,
    usage: JobUsage[],
  ): Promise<RunResult['outcome'] | 'no_harness'> {
    const { signal } = entry.controller;
    for (;;) {
      if (signal.aborted) return 'killed';
      const installed = new Set(this.installed.keys());
      const ignoreLimits = internals.ignoreLimits;
      internals.ignoreLimits = false;
      const exhausted = new Map(
        ignoreLimits
          ? []
          : (Object.entries(this.store.exhaustedUntil()) as Array<[HarnessId, number]>),
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
        const waitingOn = [...new Set(pending.map((step) => step.harness))].map((harness) => ({
          harness,
          until: exhausted.get(harness) ?? this.now(),
        }));
        const until = Math.min(...waitingOn.map((item) => item.until));
        entry.state = 'waiting-usage';
        entry.waitingOn = waitingOn;
        entry.note = usageNote(waitingOn);
        this.changed();
        internals.wake = new AbortController();
        await sleep(Math.max(until - this.now(), 1_000), signal, internals.wake.signal);
        entry.waitingOn = [];
        if (signal.aborted) return 'killed';
        continue;
      }
      for (const step of chain) {
        let result = await this.runStep(
          entry,
          internals,
          cwd,
          step,
          brief.prompt,
          brief.resume[step.harness] ?? null,
          brief.jobId,
        );
        await this.record(brief, step, result, usage, internals);
        // BAT#31: messages that came when the session no longer took them: resume it with them.
        while (result.outcome === 'done' && internals.queue.length > 0 && !signal.aborted) {
          result = await this.runStep(
            entry,
            internals,
            cwd,
            step,
            result.sessionId ? null : brief.prompt,
            result.sessionId,
            brief.jobId,
          );
          await this.record(brief, step, result, usage, internals);
        }
        if (result.outcome === 'out_of_usage') {
          const until = result.resetAt ?? this.now() + DEFAULT_BACKOFF_MS;
          this.store.setExhausted(step.harness, until);
          this.log(
            entry,
            `${HARNESS_LABELS[step.harness]} is out of usage until ${clock(until)}${
              result.error ? ` (${result.error})` : ''
            }; moving on to the next harness.`,
          );
          continue;
        }
        if (result.outcome !== 'done' && result.error) entry.note = result.error;
        return result.outcome;
      }
    }
  }

  /** What a run cost, and the harness session it ran in (with the items it touched). */
  private async record(
    brief: JobBrief,
    step: ChainEntry,
    result: RunResult,
    usage: JobUsage[],
    internals: JobInternals,
  ) {
    usage.push({
      harness: step.harness,
      model: step.model,
      effort: step.effort,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      outcome: result.outcome,
      // BAT#25 / BAT#23: the breakdown, the model it reported and its error.
      reportedModel: result.model ?? '',
      tokensCacheRead: result.cacheReadTokens ?? 0,
      tokensCacheWrite: result.cacheWriteTokens ?? 0,
      tokensReasoning: result.reasoningTokens ?? 0,
      error: result.outcome === 'done' ? null : result.error,
    });
    const items = [...internals.touched];
    internals.touched.clear();
    if (!result.sessionId) return;
    await this.api
      .setSession(brief.jobId, {
        runnerId: this.runnerId ?? '',
        harness: step.harness,
        sessionId: result.sessionId,
        ...(items.length > 0 ? { items } : {}),
      })
      .catch(() => undefined);
  }

  /**
   * One harness run. `prompt` null: a resumed session gets only the queued messages. Queued
   * messages always go with the run's prompt (they are delivered then); messages sent mid-run
   * and never taken in are queued again for the next run.
   */
  private async runStep(
    entry: RunningJob,
    internals: JobInternals,
    cwd: string,
    step: ChainEntry,
    prompt: string | null,
    resumeId: string | null,
    jobId: string,
  ) {
    const adapter = this.adapters.get(step.harness);
    if (!adapter) throw new Error(`No adapter for ${step.harness}`);
    entry.harness = step.harness;
    entry.model = step.model;
    entry.effort = step.effort;
    entry.state = 'running';
    entry.note = null;
    const queued = internals.queue.splice(0);
    const text = [prompt, ...queued.map((message) => message.text)]
      .filter((part): part is string => Boolean(part))
      .join('\n\n---\n\n');
    for (const message of queued) this.delivered(entry, internals, message);
    this.changed();
    const mode = this.store.permissionMode(step.harness, adapter);
    try {
      return await adapter.run({
        cwd,
        prompt: text,
        model: step.model,
        effort: step.effort,
        resumeId,
        permissionMode: mode,
        mcp: {
          url: this.api.mcpUrl,
          apiKey: this.api.key,
          permissionServer: this.permissions
            ? { url: this.permissions.urlFor(jobId), token: this.permissions.token }
            : null,
        },
        signal: entry.controller.signal,
        attach: (controls) => {
          internals.controls = controls;
        },
        onEvent: (event) => {
          if (event.type === 'output' || event.type === 'log' || event.type === 'status') {
            this.log(entry, event.text);
          } else if (event.type === 'delivered') {
            const message = internals.sent.shift();
            if (message) {
              this.log(entry, '✓ The session has the new message.');
              this.delivered(entry, internals, message);
            }
          } else if (event.type === 'touched') {
            internals.touched.add(event.item);
          }
        },
      });
    } finally {
      internals.controls = null;
      internals.queue.unshift(...internals.sent.splice(0));
      this.count(entry, internals);
    }
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
