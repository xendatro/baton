import { z } from 'zod';
import { principalRuleSchema } from '../principals';
import { idSchema, timestampSchema } from './common';

/**
 * The desktop app's automatic agents (BAT-24, docs/design/agents-and-pipelines.md §8): runners
 * that listen for an agent member's jobs with plain code and run each job in a headless session
 * of the person's own harness; the job brief; model mappings by difficulty with fallback chains;
 * whose jobs run automatically; harness sessions; usage and stats.
 */

export const AGENT_RUNNER_LIMITS = {
  machineName: 100,
  harnesses: 20,
  projects: 100,
  chain: 8,
  model: 100,
  effort: 40,
  sessionId: 300,
  /** Replies included in a job brief. */
  briefReplies: 12,
  /** Items a run's session is linked to besides its job's (BAT#28). */
  touchedItems: 50,
  statsDays: 365,
} as const;

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
 * The account default: a chain for tasks without a level (and levels nothing else maps), plus
 * chains by level name (case-insensitive), which apply in every project with a level of that name.
 */
export const defaultMappingSchema = z.object({
  chain: chainSchema,
  levels: z.record(z.string().trim().min(1).max(40), chainSchema).default({}),
});
export type DefaultMapping = z.infer<typeof defaultMappingSchema>;

/** A project's mapping: chains by difficulty level id. */
export const projectMappingSchema = z.object({
  levels: z.record(idSchema, chainSchema).default({}),
});
export type ProjectMapping = z.infer<typeof projectMappingSchema>;

/** `GET/PUT /api/me/agent/models`. */
export const modelMappingsSchema = z.object({
  default: defaultMappingSchema,
  /** Project id → mapping. */
  projects: z.record(idSchema, projectMappingSchema).default({}),
});
export type ModelMappings = z.infer<typeof modelMappingsSchema>;

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

export const harnessInfoSchema = z.object({
  id: harnessIdSchema,
  version: z.string().trim().max(100).nullable().default(null),
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
  difficulty: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Chain to run, from the owner's mappings (the app skips harnesses it doesn't have). */
  chain: chainSchema,
  /** Where the chain came from, in words ("Hard in API", "account default"). */
  chainSource: z.string(),
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

/** What a run cost, reported when a job completes, is released or killed. */
export const jobUsageSchema = z.object({
  harness: harnessIdSchema,
  model: z.string().trim().max(AGENT_RUNNER_LIMITS.model).default(''),
  effort: z.string().trim().max(AGENT_RUNNER_LIMITS.effort).default(''),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
  outcome: z.enum(JOB_OUTCOMES),
});
export type JobUsage = z.input<typeof jobUsageSchema>;

/** `POST /api/agent/jobs/:jobId/complete` and `/release` from the app. */
export const finishJobInputSchema = z.object({
  usage: z.array(jobUsageSchema).max(AGENT_RUNNER_LIMITS.chain).default([]),
  agreeDone: z.boolean().optional(),
  /**
   * Release only: put it under "Waiting for your OK" instead of back in the queue (a killed or
   * failed run), so the same runner doesn't take it again at once.
   */
  hold: z.boolean().optional(),
  /**
   * Complete only (BAT#31): the job's message was handed to the running session of this other
   * job (same item, same runner) instead of starting one of its own.
   */
  deliveredTo: idSchema.optional(),
});
export type FinishJobInput = z.input<typeof finishJobInputSchema>;

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

export const agentStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(AGENT_RUNNER_LIMITS.statsDays).default(30),
});

const totalsSchema = z.object({
  jobs: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type AgentUsageTotals = z.infer<typeof totalsSchema>;

/** `GET /api/me/agent/stats?days=`. */
export const agentStatsSchema = z.object({
  days: z.number().int().positive(),
  totals: totalsSchema,
  byDay: z.array(totalsSchema.extend({ day: z.string() })),
  byHarness: z.array(totalsSchema.extend({ harness: z.string() })),
  byModel: z.array(totalsSchema.extend({ harness: z.string(), model: z.string() })),
  byDifficulty: z.array(totalsSchema.extend({ difficulty: z.string() })),
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
