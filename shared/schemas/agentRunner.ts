import { z } from 'zod';
import { principalRuleSchema } from '../principals';
import { idSchema, timestampSchema } from './common';

/**
 * The desktop app's automatic agents (BAT-24, docs/design/agents-and-pipelines.md §8): runners
 * that listen for an agent member's jobs with plain code and run each job in a headless session
 * of the person's own harness; the job brief; default model chains (account, per project) and
 * suggested models;
 * whose jobs run automatically; harness sessions; usage and stats.
 */

export const AGENT_RUNNER_LIMITS = {
  machineName: 100,
  harnesses: 20,
  projects: 100,
  chain: 8,
  model: 100,
  effort: 40,
  /** Models and efforts a harness reports per machine. */
  models: 200,
  efforts: 20,
  sessionId: 300,
  /** Replies included in a job brief. */
  briefReplies: 12,
  /** Items a run's session is linked to besides its job's (BAT#28). */
  touchedItems: 50,
  statsDays: 365,
  /** A run's last error (BAT#23), in characters. */
  error: 2_000,
  /** The tail of a run's output kept on Baton (BAT#23): lines and characters. */
  outputLines: 200,
  outputChars: 64_000,
} as const;

/** The last `max` characters of `text` (whole, when it fits). */
function tailOf(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/** Trimmed, at most `max` characters (its end), or null when empty. */
function lastError(value: string | null | undefined, max: number): string | null {
  const text = value?.trim() ?? '';
  return text ? tailOf(text, max) : null;
}

/** Harnesses with a headless mode the desktop app has adapters for. */
export const HARNESS_IDS = ['claude', 'codex', 'gemini', 'cursor', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  cursor: 'Cursor CLI',
  opencode: 'opencode',
};

export const harnessIdSchema = z.enum(HARNESS_IDS);

// ---------------------------------------------------------------------------------------------
// Model mappings (personal: each person's harness, each person's usage)
// ---------------------------------------------------------------------------------------------

/** One step of a fallback chain: a harness, a model (alias or id; empty = its default) and an effort. */
export const chainEntrySchema = z.object({
  harness: harnessIdSchema,
  model: z.string().trim().max(AGENT_RUNNER_LIMITS.model).default(''),
  effort: z.string().trim().max(AGENT_RUNNER_LIMITS.effort).default(''),
});
export type ChainEntry = z.infer<typeof chainEntrySchema>;

/** Tried in order: the next entry runs when a harness is out of usage or not installed. */
export const chainSchema = z.array(chainEntrySchema).max(AGENT_RUNNER_LIMITS.chain);
export type Chain = z.infer<typeof chainSchema>;

/**
 * The account default chain: what the owner's agent runs with when nothing more specific applies
 * (no suggestion it can run, no project default). Difficulty is gone (2026-09-29): `levels` (chains
 * by level name) is legacy data, kept in the database but no longer read or written.
 */
export const defaultMappingSchema = z.object({ chain: chainSchema });
export type DefaultMapping = z.infer<typeof defaultMappingSchema>;

/** The stored account default (`agent_settings.default_mapping`), with its legacy part. */
export type StoredDefaultMapping = DefaultMapping & { levels?: Record<string, Chain> };

/** A project's own default chain (over the account default); empty: use the account default. */
export const projectMappingSchema = z.object({ chain: chainSchema });
export type ProjectMapping = z.infer<typeof projectMappingSchema>;

/** `GET/PUT /api/me/agent/models`. */
export const modelMappingsSchema = z.object({
  default: defaultMappingSchema,
  /** Project id → its own default chain (projects without one use the account default). */
  projects: z.record(idSchema, projectMappingSchema).default({}),
});
export type ModelMappings = z.infer<typeof modelMappingsSchema>;

/**
 * A model someone suggests for a run (a requester in a reply, or a stage's rule): one harness,
 * model and effort. Only a suggestion: the owner's agent runs it when one of the owner's
 * computers has it, else the owner's default for the project.
 */
export const suggestedModelSchema = chainEntrySchema;
export type SuggestedModel = z.infer<typeof suggestedModelSchema>;

/** Where the model of a run came from (`JobBrief.modelSource`, shown with the run). */
export const MODEL_SOURCES = [
  'approval',
  'requester',
  'stage',
  'project',
  'account',
  'working_harness',
] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

/** A new account's default chain (Claude Code's latest Opus, high effort). */
export const DEFAULT_CHAIN: Chain = [{ harness: 'claude', model: 'opus', effort: 'high' }];

// ---------------------------------------------------------------------------------------------
// Whose jobs run on my machine
// ---------------------------------------------------------------------------------------------

/**
 * `me`: only jobs I triggered (my mentions, assignments and moves of my agent); `anyone`: anyone
 * who can mention or assign my agent; `custom`: people and agents matching `rule`. Other jobs wait
 * for my OK (`waiting_approval`).
 */
export const JOB_SOURCE_MODES = ['me', 'anyone', 'custom'] as const;
export type JobSourceMode = (typeof JOB_SOURCE_MODES)[number];

export const jobSourcesSchema = z
  .object({
    mode: z.enum(JOB_SOURCE_MODES),
    rule: principalRuleSchema.nullable().default(null),
  })
  .refine((value) => value.mode !== 'custom' || (value.rule?.allow.length ?? 0) > 0, {
    message: 'Choose whose jobs run',
    path: ['rule'],
  });
export type JobSources = z.infer<typeof jobSourcesSchema>;

export const DEFAULT_JOB_SOURCES: JobSources = { mode: 'me', rule: null };

// ---------------------------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------------------------

const effortNameSchema = z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.effort);

/**
 * A model a harness reports on a machine (the desktop app reads it from the harness itself: its
 * `--help`, a models cache, …; never a hardcoded list): its id or alias as the harness takes it,
 * a label, and the efforts it accepts (empty: the harness's `efforts` apply).
 */
export const harnessModelSchema = z.object({
  id: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.model),
  label: z.string().trim().max(AGENT_RUNNER_LIMITS.model).nullable().default(null),
  efforts: z.array(effortNameSchema).max(AGENT_RUNNER_LIMITS.efforts).default([]),
});
export type HarnessModel = z.infer<typeof harnessModelSchema>;

export const harnessInfoSchema = z.object({
  id: harnessIdSchema,
  version: z.string().trim().max(100).nullable().default(null),
  /**
   * The models the harness reports on that machine. Absent from desktop apps before 0.5 (their
   * harnesses then accept any model, unverified).
   */
  models: z.array(harnessModelSchema).max(AGENT_RUNNER_LIMITS.models).optional(),
  /** The efforts the harness accepts for models that don't list their own. */
  efforts: z.array(effortNameSchema).max(AGENT_RUNNER_LIMITS.efforts).optional(),
});
export type HarnessInfo = z.infer<typeof harnessInfoSchema>;

/** `POST /api/agent/runners`: the desktop app starts (or restarts) on a machine. */
export const registerRunnerInputSchema = z.object({
  /** Stable id the app keeps for this machine (harness sessions are per machine). */
  machineId: z.string().trim().min(8).max(100),
  machineName: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.machineName),
  harnesses: z.array(harnessInfoSchema).max(AGENT_RUNNER_LIMITS.harnesses),
  /** Projects mapped to a folder on this machine: only their jobs come here. */
  projectIds: z.array(idSchema).max(AGENT_RUNNER_LIMITS.projects),
});
export type RegisterRunnerInput = z.infer<typeof registerRunnerInputSchema>;

/** `POST /api/agent/runners/:runnerId/heartbeat` (every 30 s at least). */
export const runnerHeartbeatInputSchema = z.object({
  harnesses: z.array(harnessInfoSchema).max(AGENT_RUNNER_LIMITS.harnesses).optional(),
  projectIds: z.array(idSchema).max(AGENT_RUNNER_LIMITS.projects).optional(),
  /** Jobs running now. */
  running: z.number().int().nonnegative().max(10_000).default(0),
  /** Ids of the jobs running now: the answer names those cancelled meanwhile (BAT-33). */
  jobIds: z.array(idSchema).max(1_000).optional(),
  /**
   * BAT#42: of `jobIds`, those whose harness is running now (not starting, waiting for usage or
   * finishing): the items show "… is working". Older apps omit it and all of `jobIds` count.
   */
  activeJobIds: z.array(idSchema).max(1_000).optional(),
});
export type RunnerHeartbeatInput = z.infer<typeof runnerHeartbeatInputSchema>;

export const runnerSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  machineName: z.string(),
  harnesses: z.array(harnessInfoSchema),
  projectIds: z.array(z.string()),
  running: z.number().int().nonnegative(),
  lastSeenAt: timestampSchema,
  online: z.boolean(),
});
export type Runner = z.infer<typeof runnerSchema>;

/** What a heartbeat answers: whether the owner paused agents (the app stops taking jobs). */
export const runnerStateSchema = z.object({
  runner: runnerSchema,
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  /** Jobs from people outside my job sources, waiting for my OK. */
  waitingCount: z.number().int().nonnegative(),
  /**
   * Of the heartbeat's `jobIds`, those cancelled meanwhile (e.g. their task was deleted): the app
   * kills their harness and doesn't hold them for the owner (BAT-33). Absent from older servers.
   */
  cancelledJobIds: z.array(z.string()).optional(),
});
export type RunnerState = z.infer<typeof runnerStateSchema>;

/** `POST /api/agent/runners/:runnerId/jobs/next?wait=`: jobs claimed for this runner. */
export const runnerNextQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(110).default(50),
});

// ---------------------------------------------------------------------------------------------
// Job brief, harness sessions, usage
// ---------------------------------------------------------------------------------------------

/** `GET /api/agent/jobs/:jobId/brief?runner=`. */
export const jobBriefQuerySchema = z.object({ runner: idSchema.optional() });

export const jobBriefSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  project: z.object({ id: z.string(), ref: z.string(), name: z.string() }).nullable(),
  target: z.object({
    type: z.string(),
    ref: z.string().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
  }),
  /** Deprecated (difficulty was removed): always null, kept for desktop apps before 0.6. */
  difficulty: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Chain to run (the app skips harnesses it doesn't have): its first entry is the model. */
  chain: chainSchema,
  /** Where the chain came from, in words ("suggested by @caden", "your default for API"). */
  chainSource: z.string(),
  /** Where the chain came from (optional: older servers). */
  modelSource: z.enum(MODEL_SOURCES).optional(),
  /** Harness → session id to resume on this machine (the same task, harness and machine). */
  resume: z.record(z.string(), z.string()),
  /** The prompt: task, stage, what's missing, replies, the job and the rules. */
  prompt: z.string(),
});
export type JobBrief = z.infer<typeof jobBriefSchema>;

/** `PUT /api/agent/jobs/:jobId/session`: the harness session a job ran in (resumed next time). */
export const harnessSessionInputSchema = z.object({
  runnerId: idSchema,
  harness: harnessIdSchema,
  sessionId: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.sessionId),
  /**
   * BAT#28: tasks the run created or replied in (refs or ids, from the harness's tool calls):
   * their next jobs resume this session too, unless they have one of their own for the harness.
   */
  items: z
    .array(z.string().trim().min(1).max(300))
    .max(AGENT_RUNNER_LIMITS.touchedItems)
    .optional(),
});
export type HarnessSessionInput = z.infer<typeof harnessSessionInputSchema>;

export const JOB_OUTCOMES = [
  'done',
  'released',
  'killed',
  'out_of_usage',
  'failed',
  'permission_denied',
] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];

/**
 * How a job's run ended on the desktop app (BAT#23): a harness outcome, or `no_harness` (none of
 * the chain's harnesses is installed there), `no_folder` (its project has no folder there) or
 * `error` (the app itself failed).
 */
export const RUN_OUTCOMES = [...JOB_OUTCOMES, 'no_harness', 'no_folder', 'error'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

const tokenCount = z.number().int().nonnegative().default(0);

/**
 * What a run cost, reported when a job completes, is released or killed. `tokensIn` is all input
 * (cache reads and writes included) and `tokensOut` all output (reasoning included); the cache and
 * reasoning counts break them down (BAT#25; 0 from older apps).
 */
export const jobUsageSchema = z.object({
  harness: harnessIdSchema,
  /** The chain's model (alias or id) as written; empty for the harness's default. */
  model: z.string().trim().max(AGENT_RUNNER_LIMITS.model).default(''),
  /** The model the harness said it ran (e.g. Claude Code's init event), when it said. */
  reportedModel: z
    .string()
    .default('')
    .transform((value) => value.trim().slice(0, AGENT_RUNNER_LIMITS.model)),
  effort: z.string().trim().max(AGENT_RUNNER_LIMITS.effort).default(''),
  tokensIn: tokenCount,
  tokensOut: tokenCount,
  /** Cached input read (Claude's cache_read_input_tokens, Codex's cached_input_tokens). */
  tokensCacheRead: tokenCount,
  /** Cache writes (Claude's cache_creation_input_tokens). */
  tokensCacheWrite: tokenCount,
  /** Reasoning output (Codex's reasoning_output_tokens), part of `tokensOut`. */
  tokensReasoning: tokenCount,
  /** What the harness reported it cost (0: it didn't, and the stats estimate it). */
  costUsd: z.number().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  outcome: z.enum(JOB_OUTCOMES),
  /** The last error the harness printed, when the run didn't finish (BAT#23). */
  error: z
    .string()
    .nullable()
    .default(null)
    .transform((value) => lastError(value, AGENT_RUNNER_LIMITS.error)),
});
export type JobUsage = z.input<typeof jobUsageSchema>;

/** `POST /api/agent/jobs/:jobId/complete` and `/release` from the app. */
export const finishJobInputSchema = z.object({
  usage: z.array(jobUsageSchema).max(AGENT_RUNNER_LIMITS.chain).default([]),
  agreeDone: z.boolean().optional(),
  /**
   * Release only: put it under "Stopped runs" for the owner instead of back in the queue (a
   * killed or failed run), so the same runner doesn't take it again at once.
   */
  hold: z.boolean().optional(),
  /** How the run ended (BAT#23; from older apps it is taken from the last usage entry). */
  outcome: z.enum(RUN_OUTCOMES).optional(),
  /** The last error line, when it didn't finish. */
  error: z
    .string()
    .nullable()
    .optional()
    .transform((value) => lastError(value, AGENT_RUNNER_LIMITS.error)),
  /**
   * The tail of the run's output: Baton keeps at most the last 200 lines and 64 000 characters.
   * The full log stays on the computer.
   */
  output: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : tailOf(
            value.split(/\r?\n/).slice(-AGENT_RUNNER_LIMITS.outputLines).join('\n'),
            AGENT_RUNNER_LIMITS.outputChars,
          ),
    ),
  /**
   * Complete only (BAT#31): the job's message was handed to the running session of this other
   * job (same item, same runner) instead of starting one of its own.
   */
  deliveredTo: idSchema.optional(),
});
export type FinishJobInput = z.input<typeof finishJobInputSchema>;

// ---------------------------------------------------------------------------------------------
// The owner's jobs: needing their OK, stopped runs, cleared ones (BAT#22, BAT#29, BAT#23)
// ---------------------------------------------------------------------------------------------

/**
 * `needs_ok`: from someone outside "Whose jobs run" (Approve / Decline); `stopped`: the owner's
 * own run that failed or was killed (Retry / Trash); `cleared`: either, whose item finished
 * meanwhile, listed for a day and then dropped.
 */
export const OWNER_JOB_GROUPS = ['needs_ok', 'stopped', 'cleared'] as const;
export type OwnerJobGroup = (typeof OWNER_JOB_GROUPS)[number];

/**
 * Why a job was cleared: its task finished (a stage that doesn't block dependents), was deleted,
 * its issue was resolved, the task left the stage the job was for, or the agent isn't assigned
 * any more.
 */
export const CLEARED_REASONS = ['finished', 'deleted', 'resolved', 'moved', 'unassigned'] as const;
export type ClearedReason = (typeof CLEARED_REASONS)[number];

/** Cleared jobs stay listed this long. */
export const CLEARED_JOBS_SHOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The model a run actually used: the harness, the model it reported (else the chain's, '' for
 * the harness's default) and the effort ('' for the default). From the run's last usage row.
 */
export const ranWithSchema = z.object({
  harness: z.string(),
  model: z.string(),
  effort: z.string(),
});
export type RanWith = z.infer<typeof ranWithSchema>;

/**
 * `GET /api/agent-runs?itemType=&itemId=`: the agent jobs about a task or issue that ran or are
 * running (newest first), each with the model it ran with. Visible to whoever can see the item.
 */
export const itemAgentRunSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  /** claimed (running) | done | released | cancelled. */
  status: z.string(),
  agent: z.object({ id: z.string(), username: z.string().nullable(), name: z.string() }),
  /** Who started it (null: nobody in particular, e.g. a stage hand-off by the system). */
  triggeredBy: z
    .object({ id: z.string(), username: z.string().nullable(), name: z.string() })
    .nullable(),
  stage: z.string().nullable(),
  /** The model of its last run (null: nothing reported yet, e.g. an MCP listener's job). */
  ranWith: ranWithSchema.nullable(),
  /** How its last run on a desktop app ended (null: still running, or not run by an app). */
  outcome: z.string().nullable(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
});
export type ItemAgentRun = z.infer<typeof itemAgentRunSchema>;

export const itemAgentRunsSchema = z.object({ runs: z.array(itemAgentRunSchema) });
export type ItemAgentRuns = z.infer<typeof itemAgentRunsSchema>;

export const jobRunSchema = z.object({
  outcome: z.string(),
  error: z.string().nullable(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  /** The effort it ran with ('' / null: the harness's default). */
  effort: z.string().nullable().default(null),
  endedAt: timestampSchema,
  /** An output tail is stored (`GET /api/me/agent/jobs/:jobId/output`). */
  hasOutput: z.boolean(),
});
export type JobRun = z.infer<typeof jobRunSchema>;

/** One entry of `GET /api/me/agent/waiting`. */
export const ownerJobSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  triggeredBy: z.string().nullable(),
  needsOk: z.boolean(),
  project: z.object({ id: z.string(), ref: z.string(), name: z.string() }).nullable(),
  target: z.object({
    ref: z.string().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
  }),
  trigger: z.object({ body: z.string() }).nullable(),
  group: z.enum(OWNER_JOB_GROUPS),
  /** The last run (null before anything ran). */
  run: jobRunSchema.nullable(),
  clearedAt: timestampSchema.nullable(),
  clearedReason: z.enum(CLEARED_REASONS).nullable(),
});
export type OwnerJob = z.infer<typeof ownerJobSchema>;

export const ownerJobsSchema = z.object({ jobs: z.array(ownerJobSchema) });

/** `GET /api/me/agent/jobs/:jobId/output`: the stored tail of the job's last run. */
export const jobOutputSchema = z.object({
  jobId: z.string(),
  run: jobRunSchema.nullable(),
  output: z.string(),
});
export type JobOutput = z.infer<typeof jobOutputSchema>;

/**
 * `GET /api/me/agent/model-failures`: per harness and model (as written in a chain), the error of
 * its latest run when that run failed, shown next to the chain entry ("Last run failed: …").
 */
export const modelFailureSchema = z.object({
  harness: z.string(),
  /** `canonicalModel` of the chain's model ('' for the harness's default). */
  model: z.string(),
  error: z.string(),
  at: timestampSchema,
});
export type ModelFailure = z.infer<typeof modelFailureSchema>;
export const modelFailuresSchema = z.object({ failures: z.array(modelFailureSchema) });

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

export const agentStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(AGENT_RUNNER_LIMITS.statsDays).default(30),
});

const count = z.number().int().nonnegative();

const totalsSchema = z.object({
  jobs: count,
  /** All input tokens, cache reads and writes included (uncached input: the difference). */
  tokensIn: count,
  /** All output tokens, reasoning included. */
  tokensOut: count,
  tokensCacheRead: count,
  tokensCacheWrite: count,
  tokensReasoning: count,
  /** What the harnesses reported the runs cost. */
  costUsd: z.number().nonnegative(),
  /** Estimated API cost of the runs without a reported cost (`shared/modelPrices.ts`). */
  costEstimatedUsd: z.number().nonnegative(),
  /** Runs with neither a reported cost nor a known price: not in either cost. */
  unpricedRuns: count,
  durationMs: count,
});
export type AgentUsageTotals = z.infer<typeof totalsSchema>;

/** `GET /api/me/agent/stats?days=`. */
export const agentStatsSchema = z.object({
  days: z.number().int().positive(),
  totals: totalsSchema,
  byDay: z.array(totalsSchema.extend({ day: z.string() })),
  byHarness: z.array(totalsSchema.extend({ harness: z.string() })),
  /** The model the harness reported, else the chain's, as `canonicalModel` ('' = default). */
  byModel: z.array(totalsSchema.extend({ harness: z.string(), model: z.string() })),
  byOutcome: z.array(z.object({ outcome: z.string(), jobs: z.number().int().nonnegative() })),
});
export type AgentStats = z.infer<typeof agentStatsSchema>;

/**
 * `GET /api/projects/:projectId/agent-connection?taskId=`: can the viewer's own agent run jobs in
 * this project right now? `covered`: an online desktop runner maps the project to a folder, or an
 * MCP listener (`start_listener`) is listening to it. Without that, the agent's jobs here wait
 * (pending) with nothing to take them, which the web app says loudly ("Connect now").
 */
export const agentConnectionQuerySchema = z.object({ taskId: idSchema.optional() });

export const AGENT_PAUSED_BY = ['owner', 'team', 'project'] as const;

export const agentConnectionRunnerSchema = z.object({
  id: z.string(),
  machineName: z.string(),
  online: z.boolean(),
  /** The project is mapped to a folder on that machine. */
  coversProject: z.boolean(),
});
export type AgentConnectionRunner = z.infer<typeof agentConnectionRunnerSchema>;

export const agentConnectionSchema = z.object({
  /** The viewer's agent member (a key's own agent); null when there is none yet. */
  agent: z.object({ id: z.string(), username: z.string().nullable(), name: z.string() }).nullable(),
  project: z.object({
    id: z.string(),
    /** `team-slug/KEY`. */
    ref: z.string(),
    name: z.string(),
    repoUrl: z.string().nullable(),
  }),
  paused: z.boolean(),
  pausedReason: z.string().nullable(),
  /** Who paused it: the owner (resumable in Settings → Agent), the team or the project. */
  pausedBy: z.enum(AGENT_PAUSED_BY).nullable(),
  /** The agent can see the project (without that, no jobs are queued for it here at all). */
  agentCanView: z.boolean(),
  covered: z.boolean(),
  runners: z.array(agentConnectionRunnerSchema),
  /** An MCP `start_listener` session is listening to this project now. */
  listening: z.boolean(),
  /** The agent's pending jobs in this project (including those waiting for the owner's OK). */
  pendingJobs: z.number().int().nonnegative(),
  /** With `taskId`: the agent's pending jobs about that task (its thread included). */
  pendingJobsForTask: z.number().int().nonnegative().optional(),
  /**
   * With `taskId`: the task involves the agent (assigned to it in the current stage, claimable by
   * it from the pool, the stage hands off to it or asks its approval, or it has jobs there).
   */
  taskInvolvesAgent: z.boolean().optional(),
});
export type AgentConnection = z.infer<typeof agentConnectionSchema>;

// ---------------------------------------------------------------------------------------------
// Model options: what the owner's computers can run
// ---------------------------------------------------------------------------------------------

/** How long a runner not seen any more still counts for the model options. */
export const MODEL_OPTIONS_RUNNER_DAYS = 30;

export const modelOptionSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  /** Efforts it accepts (empty: the harness's). */
  efforts: z.array(z.string()),
  /** On a computer online now. */
  online: z.boolean(),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

export const harnessOptionSchema = z.object({
  id: harnessIdSchema,
  /** Installed on a computer online now. */
  online: z.boolean(),
  /** The computers that have it (most recently seen first). */
  machines: z.array(z.string()),
  /**
   * A computer reported the harness's models: only those count as available. False with older
   * desktop apps, which don't report them (any model is accepted there, unverified).
   */
  reported: z.boolean(),
  models: z.array(modelOptionSchema),
  /** Efforts for models that don't list their own. */
  efforts: z.array(z.string()),
});
export type HarnessOption = z.infer<typeof harnessOptionSchema>;

/**
 * `GET /api/me/agent/model-options`: the harnesses, models and efforts the owner's computers
 * report (the union over their desktop apps seen in the last 30 days, online ones marked).
 */
export const modelOptionsSchema = z.object({ harnesses: z.array(harnessOptionSchema) });
export type ModelOptions = z.infer<typeof modelOptionsSchema>;
