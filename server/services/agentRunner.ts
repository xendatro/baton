import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { AGENT_LISTENER, PRIORITIES } from '@shared/constants';
import {
  harnessOfAgentName,
  preferHarness,
  resolveChain,
  type ResolvedChain,
} from '@shared/agentChains';
import { canonicalModel, estimateCost } from '@shared/modelPrices';
import {
  AGENT_RUNNER_LIMITS,
  CLEARED_JOBS_SHOWN_MS,
  DEFAULT_CHAIN,
  HARNESS_IDS,
  HARNESS_LABELS,
  MODEL_OPTIONS_RUNNER_DAYS,
  harnessIdSchema,
  type HarnessId,
  type HarnessInfo,
  type HarnessOption,
  type ModelOptions,
  type AgentStats,
  type AgentUsageTotals,
  type FinishJobInput,
  type HarnessSessionInput,
  type JobBrief,
  type JobOutput,
  type JobRun,
  type JobSources,
  type ModelFailure,
  type ModelMappings,
  type OwnerJob,
  type RegisterRunnerInput,
  type Runner,
  type RunnerHeartbeatInput,
  type RunnerState,
} from '@shared/schemas/agentRunner';
import { finishJobInputSchema } from '@shared/schemas/agentRunner';
import type { TaskStage } from '@shared/schemas/pipelines';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { canViewProject, getProjectAccess } from './access';
import {
  cancelledJobIds,
  clearSettledJobs,
  completeJob,
  jobChanged,
  jobContexts,
  jobItem,
  jobSourcesOf,
  listen,
  releaseJob,
  requireListeningAgent,
  type AgentJobContext,
} from './agentJobs';
import { approveAgentRequest, declineAgentRequest, isOpenRequest } from './agentRequests';
import { agentPauseReason, findAgentId, updateAgentSettings } from './agents';
import { emitEvent } from './events';
import { stageOf } from './pipelines';
import { pipelineIdOfStatus, pipelineRow } from './projectPipelines';
import { isSessionListening, refreshPresence } from './presence';
import { resolveTask } from './refs';
import { catchUpBriefMessages, catchUpPrompt } from './chat';
import { taskDraftPrompt } from './taskDrafts';
import { getUserSummaries } from './users';

/**
 * The desktop app's automatic agents (BAT-24, docs/design/agents-and-pipelines.md §8). A runner
 * is the app on one machine: an `agent_session` of kind `runner` that registers, heartbeats and
 * long-polls for the jobs of the projects mapped to folders there (claimed atomically, and put
 * back when it isn't seen for 90 s, like listener sessions). Jobs caused by people outside the
 * owner's job sources wait for the owner's OK. For each job the app reads a brief (the prompt,
 * the model chain from the owner's mappings, the harness session to resume on that machine),
 * runs it, stores the harness session and reports usage when it completes or releases the job.
 */

type SessionRow = typeof s.agentSession.$inferSelect;
type JobRow = typeof s.agentJob.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Owners (settings, stats, waiting jobs): the person, from the web or through their agent's key
// ---------------------------------------------------------------------------------------------

interface Owner {
  ownerId: string;
  agentId: string | null;
}

function requireOwner(deps: AppDeps, actor: Actor): Owner {
  if (actor.ownerId) return { ownerId: actor.ownerId, agentId: actor.userId };
  const user = deps.db.orm
    .select({ kind: s.user.kind })
    .from(s.user)
    .where(eq(s.user.id, actor.userId))
    .get();
  if (user?.kind !== 'human') throw errors.forbidden('Only people have agent settings');
  return { ownerId: actor.userId, agentId: findAgentId(deps.db.orm, actor.userId) };
}

// ---------------------------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------------------------

function isOnline(deps: AppDeps, row: SessionRow, now = Date.now()): boolean {
  return (
    now - row.lastSeenAt.getTime() < AGENT_LISTENER.sessionTimeoutMs ||
    isSessionListening(deps, row.id)
  );
}

function toRunner(deps: AppDeps, row: SessionRow): Runner {
  return {
    id: row.id,
    machineId: row.machineId ?? '',
    machineName: row.machineName ?? 'Unknown machine',
    harnesses: row.harnesses,
    projectIds: row.projectIds,
    running: row.running,
    lastSeenAt: row.lastSeenAt.toISOString(),
    online: isOnline(deps, row),
  };
}

/** What a runner row keeps of a harness: its version, and its models and efforts when reported. */
function harnessRecord(harness: RegisterRunnerInput['harnesses'][number]): HarnessInfo {
  return {
    id: harness.id,
    version: harness.version,
    ...(harness.models ? { models: harness.models } : {}),
    ...(harness.efforts ? { efforts: harness.efforts } : {}),
  };
}

/** The projects of `ids` the agent can see (others are dropped silently). */
function visibleProjects(db: DbExecutor, agentId: string, ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((projectId) => {
    const access = getProjectAccess(db, agentId, projectId);
    return access !== null && canViewProject(access);
  });
}

function waitingCount(db: DbExecutor, agentId: string): number {
  return db
    .select({ id: s.agentJob.id })
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, agentId),
        eq(s.agentJob.status, 'pending'),
        eq(s.agentJob.needsOk, true),
      ),
    )
    .all().length;
}

function runnerState(
  deps: AppDeps,
  agent: { id: string; ownerId: string },
  row: SessionRow,
): RunnerState {
  const reason = agentPauseReason(deps.db.orm, { agentId: agent.id, ownerId: agent.ownerId }, null);
  return {
    runner: toRunner(deps, row),
    paused: reason !== null,
    pausedReason: reason,
    waitingCount: waitingCount(deps.db.orm, agent.id),
  };
}

/** The agent behind a key (paused agents may still register and heartbeat, to show it). */
function requireKeyAgent(actor: Actor): { id: string; ownerId: string } {
  if (!actor.key || !actor.ownerId) {
    throw errors.validation('The desktop app connects with an API key of your account');
  }
  return { id: actor.userId, ownerId: actor.ownerId };
}

function requireRunner(deps: AppDeps, agentId: string, runnerId: string): SessionRow {
  const row = deps.db.orm
    .select()
    .from(s.agentSession)
    .where(
      and(
        eq(s.agentSession.id, runnerId),
        eq(s.agentSession.agentUserId, agentId),
        eq(s.agentSession.kind, 'runner'),
      ),
    )
    .get();
  if (!row) throw errors.notFound('Runner');
  return row;
}

function announce(deps: AppDeps, agent: { id: string; ownerId: string }, row: SessionRow) {
  refreshPresence(deps, [agent.id]);
  emitEvent(deps, {
    type: 'agent_job.changed',
    teamId: null,
    entityType: 'agent_job',
    entityId: row.id,
    actorId: agent.id,
    userId: agent.ownerId,
  });
}

/**
 * `POST /api/agent/runners`: the app on a machine starts. One runner per (agent, machine): a
 * restart updates it (same id), so harness sessions and presence carry over.
 */
export function registerRunner(
  deps: AppDeps,
  actor: Actor,
  input: RegisterRunnerInput,
): RunnerState {
  const agent = requireKeyAgent(actor);
  const { orm } = deps.db;
  const projectIds = visibleProjects(orm, agent.id, input.projectIds);
  const now = new Date();
  const existing = orm
    .select()
    .from(s.agentSession)
    .where(
      and(
        eq(s.agentSession.agentUserId, agent.id),
        eq(s.agentSession.kind, 'runner'),
        eq(s.agentSession.machineId, input.machineId),
      ),
    )
    .get();
  const values = {
    keyId: actor.key?.id ?? null,
    machineName: input.machineName,
    harnesses: input.harnesses.map(harnessRecord),
    projectIds,
    lastSeenAt: now,
  };
  const row = existing
    ? orm
        .update(s.agentSession)
        .set(values)
        .where(eq(s.agentSession.id, existing.id))
        .returning()
        .get()
    : orm
        .insert(s.agentSession)
        .values({
          id: newId(),
          agentUserId: agent.id,
          kind: 'runner',
          machineId: input.machineId,
          startedAt: now,
          running: 0,
          ...values,
        })
        .returning()
        .get();
  announce(deps, agent, row);
  return runnerState(deps, agent, row);
}

/** `POST /api/agent/runners/:runnerId/heartbeat`: still here (and what changed). */
export function runnerHeartbeat(
  deps: AppDeps,
  actor: Actor,
  runnerId: string,
  input: RunnerHeartbeatInput,
): RunnerState {
  const agent = requireKeyAgent(actor);
  const current = requireRunner(deps, agent.id, runnerId);
  const { orm } = deps.db;
  const row = orm
    .update(s.agentSession)
    .set({
      lastSeenAt: new Date(),
      running: input.running ?? 0,
      ...(input.harnesses ? { harnesses: input.harnesses.map(harnessRecord) } : {}),
      ...(input.projectIds ? { projectIds: visibleProjects(orm, agent.id, input.projectIds) } : {}),
    })
    .where(eq(s.agentSession.id, current.id))
    .returning()
    .get();
  if (!isOnline(deps, current) || current.running !== row.running) announce(deps, agent, row);
  return {
    ...runnerState(deps, agent, row),
    cancelledJobIds: cancelledJobIds(orm, agent.id, input.jobIds ?? []),
  };
}

/**
 * `POST /api/agent/runners/:runnerId/jobs/next?wait=`: the next jobs of the runner's projects,
 * claimed by it (at most 10), or waits up to `wait` seconds for the first. Jobs waiting for the
 * owner's OK are skipped. A paused agent gets `agents_paused`.
 */
export async function nextRunnerJobs(
  deps: AppDeps,
  actor: Actor,
  runnerId: string,
  wait: number,
  signal?: AbortSignal,
): Promise<{ jobs: AgentJobContext[] }> {
  const agent = requireListeningAgent(deps, actor);
  const runner = requireRunner(deps, agent.id, runnerId);
  deps.db.orm
    .update(s.agentSession)
    .set({ lastSeenAt: new Date() })
    .where(eq(s.agentSession.id, runner.id))
    .run();
  const rows = await listen(
    deps,
    agent,
    runner.id,
    runner.projectIds,
    { limit: AGENT_LISTENER.maxJobsPerCall, timeoutSeconds: wait, acceptedOnly: true },
    signal,
  );
  return { jobs: jobContexts(deps, rows) };
}

/**
 * `GET /api/me/agent/model-options`: the union of what the owner's desktop apps report (seen in
 * the last 30 days): per harness the computers that have it, its models and efforts, and whether
 * one of them is online now. The source of truth for every model picker.
 */
export function modelOptions(deps: AppDeps, actor: Actor): ModelOptions {
  const owner = requireOwner(deps, actor);
  if (!owner.agentId) return { harnesses: [] };
  const since = new Date(Date.now() - MODEL_OPTIONS_RUNNER_DAYS * 24 * 60 * 60 * 1000);
  const rows = deps.db.orm
    .select()
    .from(s.agentSession)
    .where(
      and(
        eq(s.agentSession.agentUserId, owner.agentId),
        eq(s.agentSession.kind, 'runner'),
        gte(s.agentSession.lastSeenAt, since),
      ),
    )
    .orderBy(desc(s.agentSession.lastSeenAt))
    .all();
  const harnesses = new Map<HarnessId, HarnessOption>();
  for (const row of rows) {
    const online = isOnline(deps, row);
    for (const info of row.harnesses) {
      const parsed = harnessIdSchema.safeParse(info.id);
      if (!parsed.success) continue;
      let entry = harnesses.get(parsed.data);
      if (!entry) {
        entry = {
          id: parsed.data,
          online: false,
          machines: [],
          reported: false,
          models: [],
          efforts: [],
        };
        harnesses.set(parsed.data, entry);
      }
      entry.online ||= online;
      const machine = row.machineName ?? 'Unknown machine';
      if (!entry.machines.includes(machine)) entry.machines.push(machine);
      if (info.models) entry.reported = true;
      for (const model of info.models ?? []) {
        const known = entry.models.find(
          (candidate) => candidate.id.toLowerCase() === model.id.toLowerCase(),
        );
        if (known) {
          known.online ||= online;
          known.label ??= model.label ?? null;
          for (const effort of model.efforts) {
            if (!known.efforts.includes(effort)) known.efforts.push(effort);
          }
        } else {
          entry.models.push({
            id: model.id,
            label: model.label ?? null,
            efforts: [...model.efforts],
            online,
          });
        }
      }
      for (const effort of info.efforts ?? []) {
        if (!entry.efforts.includes(effort)) entry.efforts.push(effort);
      }
    }
  }
  return {
    harnesses: HARNESS_IDS.flatMap((id) => {
      const entry = harnesses.get(id);
      return entry ? [entry] : [];
    }),
  };
}

/** The owner's runners (most recently seen first), for the web and the app. */
export function listRunners(deps: AppDeps, actor: Actor): { runners: Runner[] } {
  const owner = requireOwner(deps, actor);
  if (!owner.agentId) return { runners: [] };
  const rows = deps.db.orm
    .select()
    .from(s.agentSession)
    .where(and(eq(s.agentSession.agentUserId, owner.agentId), eq(s.agentSession.kind, 'runner')))
    .orderBy(desc(s.agentSession.lastSeenAt))
    .all();
  return { runners: rows.map((row) => toRunner(deps, row)) };
}

// ---------------------------------------------------------------------------------------------
// Waiting for the owner's OK
// ---------------------------------------------------------------------------------------------

/** The last run of each job (BAT#23): its outcome and error, with the harness and model. */
function jobRuns(db: DbExecutor, rows: readonly JobRow[]): Map<string, JobRun> {
  const runs = new Map<string, JobRun>();
  const ran = rows.filter((row) => row.runOutcome && row.runEndedAt);
  if (ran.length === 0) return runs;
  const usage = db
    .select({
      jobId: s.agentUsage.jobId,
      harness: s.agentUsage.harness,
      model: s.agentUsage.model,
      reportedModel: s.agentUsage.reportedModel,
    })
    .from(s.agentUsage)
    .where(
      inArray(
        s.agentUsage.jobId,
        ran.map((row) => row.id),
      ),
    )
    .orderBy(asc(s.agentUsage.createdAt), asc(s.agentUsage.id))
    .all();
  const last = new Map(usage.map((row) => [row.jobId, row]));
  for (const row of ran) {
    const entry = last.get(row.id);
    runs.set(row.id, {
      outcome: row.runOutcome ?? 'failed',
      error: row.runError,
      harness: entry?.harness ?? null,
      model: entry ? entry.reportedModel || entry.model || null : null,
      endedAt: (row.runEndedAt ?? row.createdAt).toISOString(),
      hasOutput: Boolean(row.runOutput),
    });
  }
  return runs;
}

/**
 * `GET /api/me/agent/waiting`: the owner's runs that wait on them (BAT#22) — runs that failed or
 * were killed (`stopped`) — plus those cleared in the last day because their item finished
 * (BAT#29). Requests from people who may only ask are on `GET /api/me/agent/requests`.
 */
export function listWaitingJobs(deps: AppDeps, actor: Actor): { jobs: OwnerJob[] } {
  const owner = requireOwner(deps, actor);
  if (!owner.agentId) return { jobs: [] };
  const { orm } = deps.db;
  const rows = orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, owner.agentId),
        // Requests (agent access) have their own page: only held runs are listed here.
        isNotNull(s.agentJob.heldAt),
        or(
          and(eq(s.agentJob.status, 'pending'), eq(s.agentJob.needsOk, true)),
          gte(s.agentJob.clearedAt, new Date(Date.now() - CLEARED_JOBS_SHOWN_MS)),
        ),
      ),
    )
    .orderBy(asc(s.agentJob.createdAt), asc(s.agentJob.id))
    .all();
  const contexts = jobContexts(deps, rows);
  const runs = jobRuns(orm, rows);
  return {
    jobs: rows.map((row, index) => {
      const context = contexts[index] as AgentJobContext;
      return {
        jobId: row.id,
        kind: row.kind,
        status: row.status,
        createdAt: context.createdAt,
        triggeredBy: context.triggeredBy,
        needsOk: row.needsOk,
        project: context.project,
        target: {
          ref: context.target.ref,
          title: context.target.title,
          url: context.target.url,
        },
        trigger: context.trigger ? { body: context.trigger.body } : null,
        group: row.clearedAt ? 'cleared' : row.heldAt ? 'stopped' : 'needs_ok',
        run: runs.get(row.id) ?? null,
        clearedAt: row.clearedAt?.toISOString() ?? null,
        clearedReason: row.clearedReason ?? null,
      };
    }),
  };
}

function requireOwnersJob(deps: AppDeps, owner: Owner, jobId: string): JobRow {
  const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || job.agentUserId !== owner.agentId) throw errors.notFound('Job');
  return job;
}

/**
 * `GET /api/me/agent/jobs/:jobId/output` (BAT#23): the tail of the job's last run as the desktop
 * app reported it, with its outcome and error. The full log stays on that computer.
 */
export function jobOutput(deps: AppDeps, actor: Actor, jobId: string): JobOutput {
  const owner = requireOwner(deps, actor);
  const job = requireOwnersJob(deps, owner, jobId);
  return {
    jobId: job.id,
    run: jobRuns(deps.db.orm, [job]).get(job.id) ?? null,
    output: job.runOutput ?? '',
  };
}

/**
 * Approve (someone else's job) or Retry (a stopped run): the job goes to the owner's runners like
 * any other.
 */
export function approveWaitingJob(deps: AppDeps, actor: Actor, jobId: string): AgentJobContext {
  const owner = requireOwner(deps, actor);
  const job = requireOwnersJob(deps, owner, jobId);
  if (isOpenRequest(job)) {
    // A request (agent access): approved without a model choice.
    approveAgentRequest(deps, actor, jobId);
  } else if (job.needsOk && job.status === 'pending') {
    deps.db.write((tx) => {
      tx.update(s.agentJob)
        .set({ needsOk: false, heldAt: null })
        .where(eq(s.agentJob.id, job.id))
        .run();
      jobChanged(tx, job, owner.ownerId);
    });
  }
  return jobContexts(deps, [requireOwnersJob(deps, owner, jobId)])[0] as AgentJobContext;
}

/** Decline (someone else's job) or Trash (a stopped run): the job is cancelled. */
export function dismissWaitingJob(deps: AppDeps, actor: Actor, jobId: string): AgentJobContext {
  const owner = requireOwner(deps, actor);
  const job = requireOwnersJob(deps, owner, jobId);
  if (isOpenRequest(job)) {
    declineAgentRequest(deps, actor, jobId);
  } else if (job.status === 'pending') {
    deps.db.write((tx) => {
      tx.update(s.agentJob)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(s.agentJob.id, job.id))
        .run();
      jobChanged(tx, job, owner.ownerId);
    });
  }
  return jobContexts(deps, [requireOwnersJob(deps, owner, jobId)])[0] as AgentJobContext;
}

// ---------------------------------------------------------------------------------------------
// Settings: whose jobs run, model mappings
// ---------------------------------------------------------------------------------------------

export function getJobSources(deps: AppDeps, actor: Actor): JobSources {
  const owner = requireOwner(deps, actor);
  return jobSourcesOf(deps.db.orm, owner.ownerId);
}

export function setJobSources(deps: AppDeps, actor: Actor, input: JobSources): JobSources {
  const owner = requireOwner(deps, actor);
  const value: JobSources = input.mode === 'custom' ? input : { mode: input.mode, rule: null };
  upsertSettings(deps, owner.ownerId, { jobSources: value });
  return value;
}

function upsertSettings(
  deps: AppDeps,
  userId: string,
  patch: Partial<Pick<typeof s.agentSettings.$inferInsert, 'jobSources' | 'defaultMapping'>>,
): void {
  const now = new Date();
  deps.db.orm
    .insert(s.agentSettings)
    .values({ userId, ...patch, updatedAt: now })
    .onConflictDoUpdate({ target: s.agentSettings.userId, set: { ...patch, updatedAt: now } })
    .run();
}

export function getModelMappings(deps: AppDeps, actor: Actor): ModelMappings {
  const owner = requireOwner(deps, actor);
  const { orm } = deps.db;
  const settings = orm
    .select({ defaultMapping: s.agentSettings.defaultMapping })
    .from(s.agentSettings)
    .where(eq(s.agentSettings.userId, owner.ownerId))
    .get();
  const projects = Object.fromEntries(
    orm
      .select()
      .from(s.agentProjectMapping)
      .where(eq(s.agentProjectMapping.userId, owner.ownerId))
      .all()
      .map((row) => [row.projectId, { levels: row.levels }]),
  );
  return {
    default: settings?.defaultMapping ?? { chain: DEFAULT_CHAIN, levels: {} },
    projects,
  };
}

/**
 * Replaces the owner's mappings. Project mappings must be of projects they can see, and name
 * that project's levels; empty chains are dropped.
 */
export function setModelMappings(deps: AppDeps, actor: Actor, input: ModelMappings): ModelMappings {
  const owner = requireOwner(deps, actor);
  const { orm } = deps.db;
  const projects: Array<{
    projectId: string;
    levels: Record<string, ModelMappings['default']['chain']>;
  }> = [];
  for (const [projectId, mapping] of Object.entries(input.projects)) {
    const access = getProjectAccess(orm, owner.ownerId, projectId);
    if (!access || !canViewProject(access)) throw errors.notFound('Project');
    const levelIds = new Set(
      orm
        .select({ id: s.difficulty.id })
        .from(s.difficulty)
        .where(eq(s.difficulty.projectId, projectId))
        .all()
        .map((row) => row.id),
    );
    const levels = Object.fromEntries(
      Object.entries(mapping.levels).filter(([, chain]) => chain.length > 0),
    );
    const unknown = Object.keys(levels).filter((id) => !levelIds.has(id));
    if (unknown.length > 0) {
      throw errors.validation('Mappings can only name difficulty levels of their project', {
        projectId,
        levels: unknown,
      });
    }
    if (Object.keys(levels).length > 0) projects.push({ projectId, levels });
  }
  const defaults = {
    chain: input.default.chain,
    levels: Object.fromEntries(
      Object.entries(input.default.levels).filter(([, chain]) => chain.length > 0),
    ),
  };
  deps.db.write((tx) => {
    const now = new Date();
    tx.insert(s.agentSettings)
      .values({ userId: owner.ownerId, defaultMapping: defaults, updatedAt: now })
      .onConflictDoUpdate({
        target: s.agentSettings.userId,
        set: { defaultMapping: defaults, updatedAt: now },
      })
      .run();
    tx.delete(s.agentProjectMapping).where(eq(s.agentProjectMapping.userId, owner.ownerId)).run();
    for (const project of projects) {
      tx.insert(s.agentProjectMapping)
        .values({ userId: owner.ownerId, ...project, updatedAt: now })
        .run();
    }
  });
  return getModelMappings(deps, actor);
}

// ---------------------------------------------------------------------------------------------
// Job brief
// ---------------------------------------------------------------------------------------------

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function stageSection(stage: TaskStage): string {
  const parts = [`## Stage: ${stage.status.name}`];
  if (stage.instructions.trim())
    parts.push(`### What to do in this stage\n\n${stage.instructions.trim()}`);
  if (stage.criteria.length > 0) {
    parts.push(
      `### Exit criteria (give evidence with move_task { evidence: [{ criterion, text }] })\n\n${stage.criteria
        .map(
          (criterion) =>
            `- [${criterion.evidence ? 'x' : ' '}] \`${criterion.id}\`: ${criterion.text}${
              criterion.evidence ? ` — evidence: ${criterion.evidence.text}` : ''
            }`,
        )
        .join('\n')}`,
    );
  }
  if (stage.approvals) {
    parts.push(
      `### Approvals\n\n${stage.approvals.approved} of ${stage.approvals.required} from ${stage.approvals.rule}${
        stage.approvals.canApprove ? ' (you may approve)' : ''
      }.`,
    );
  }
  const decisions = [
    ...(stage.previousApprovals ?? []).flatMap((group) =>
      group.decisions.map((decision) => ({ ...decision, stage: group.status.name })),
    ),
    ...(stage.approvals?.given ?? []).map((decision) => ({
      ...decision,
      stage: stage.status.name,
    })),
  ].filter((decision) => decision.comment?.trim());
  if (decisions.length > 0) {
    parts.push(
      `### What reviewers said (follow it)\n\n${decisions
        .map(
          (decision) =>
            `- **@${decision.user?.username ?? 'someone'}** ${
              decision.decision === 'approve' ? 'approved' : 'requested changes'
            } in ${decision.stage}:\n${quote(decision.comment ?? '')}`,
        )
        .join('\n')}`,
    );
  }
  if (stage.missing.length > 0) {
    parts.push(
      `### Still missing before it can move on\n\n${stage.missing.map((item) => `- ${item}`).join('\n')}`,
    );
  }
  if (stage.moveRule) parts.push(`Only ${stage.moveRule} can move it on.`);
  parts.push(
    stage.next
      ? `Next stage: **${stage.next.name}** (the only stage it moves on to).`
      : 'This is the last stage.',
  );
  const back = stage.canMoveTo?.back ?? [];
  if (back.length > 0) {
    parts.push(
      `It can be sent back to ${back.map((item) => `**${item.name}**`).join(', ')} with move_task { status, reason } (the reason is required).`,
    );
  }
  return parts.join('\n\n');
}

/**
 * BAT-27: "Sent back because", at the top of the brief of a job for a stage the task was sent
 * back into (the job's `returnReason`, else the current visit's while the job is for it). A
 * resumed harness session gets it as the start of its new prompt.
 */
function sentBackSection(job: JobRow, stage: TaskStage | null): string[] {
  const payloadReason =
    typeof job.payload.returnReason === 'string' ? job.payload.returnReason : '';
  const forStage =
    typeof job.payload.statusId !== 'string' || job.payload.statusId === stage?.status.id;
  const visit = forStage ? stage?.returnReason : null;
  const reason = payloadReason || visit?.reason || '';
  if (!reason.trim()) return [];
  const from =
    typeof job.payload.returnedFrom === 'string'
      ? job.payload.returnedFrom
      : (visit?.from?.name ?? null);
  const by = !payloadReason && visit?.by ? ` by @${visit.by.username ?? 'someone'}` : '';
  return [
    `## Sent back because\n\n${quote(reason)}\n\nThe task was sent back${from ? ` from ${from}` : ''}${by}. Deal with this first: it is why the task is here again.`,
  ];
}

/**
 * BAT-28: the difficulty of the stage a job is for — the task's difficulty in `payload.statusId`
 * when the job names another stage it has been in, else its current stage's.
 */
function jobDifficultyId(
  db: DbExecutor,
  job: Pick<JobRow, 'payload'>,
  task: { id: string; statusId: string; difficultyId: string | null },
): string | null {
  const statusId = typeof job.payload.statusId === 'string' ? job.payload.statusId : null;
  if (statusId && statusId !== task.statusId) {
    const row = db
      .select({ difficultyId: s.taskStageDifficulty.difficultyId })
      .from(s.taskStageDifficulty)
      .where(
        and(
          eq(s.taskStageDifficulty.taskId, task.id),
          eq(s.taskStageDifficulty.statusId, statusId),
        ),
      )
      .get();
    if (row) return row.difficultyId;
  }
  return task.difficultyId;
}

/**
 * The chain the owner's model mappings give a job (BAT-24, BAT-28: by the difficulty of the stage
 * it is for), with that level. What runs unless the owner chose a model when approving it.
 */
export function mappedChain(
  db: DbExecutor,
  ownerId: string,
  job: Pick<JobRow, 'payload' | 'projectId' | 'targetType' | 'targetId'>,
  loadedTask?: { id: string; statusId: string; difficultyId: string | null },
): { level: { id: string; name: string } | undefined; resolved: ResolvedChain } {
  let task = loadedTask;
  if (!task) {
    const item = jobItem(db, job);
    task =
      item?.type === 'task'
        ? db
            .select({ id: s.task.id, statusId: s.task.statusId, difficultyId: s.task.difficultyId })
            .from(s.task)
            .where(eq(s.task.id, item.id))
            .get()
        : undefined;
  }
  const levels = db
    .select()
    .from(s.difficulty)
    .where(eq(s.difficulty.projectId, job.projectId))
    .all();
  const difficultyId = task ? jobDifficultyId(db, job, task) : null;
  const level = difficultyId ? levels.find((row) => row.id === difficultyId) : undefined;
  const mappings = db
    .select({ defaultMapping: s.agentSettings.defaultMapping })
    .from(s.agentSettings)
    .where(eq(s.agentSettings.userId, ownerId))
    .get();
  const projectMapping = db
    .select({ levels: s.agentProjectMapping.levels })
    .from(s.agentProjectMapping)
    .where(
      and(
        eq(s.agentProjectMapping.userId, ownerId),
        eq(s.agentProjectMapping.projectId, job.projectId),
      ),
    )
    .get();
  return {
    level,
    resolved: resolveChain({
      levels,
      difficultyId: level?.id ?? null,
      project: projectMapping ? { levels: projectMapping.levels } : null,
      defaults: mappings?.defaultMapping ?? null,
    }),
  };
}

function recentReplies(
  db: DbExecutor,
  item: { type: string; id: string },
): Array<{ author: string; body: string; createdAt: Date; id: string }> {
  const rows = db
    .select()
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, item.type as 'task' | 'issue'),
        eq(s.reply.parentId, item.id),
        isNull(s.reply.deletedAt),
      ),
    )
    .orderBy(desc(s.reply.createdAt))
    .limit(AGENT_RUNNER_LIMITS.briefReplies)
    .all()
    .reverse();
  const authors = getUserSummaries(
    db,
    rows.map((row) => row.authorId),
  );
  return rows.map((row) => ({
    id: row.id,
    author: row.authorId
      ? `@${authors.get(row.authorId)?.username ?? 'someone'}`
      : 'a former member',
    body: row.body,
    createdAt: row.createdAt,
  }));
}

/** Jobs that follow up on an item the agent may already be working on (BAT#28). */
const FOLLOW_UP_KINDS = new Set<string>(['thread_reply', 'mention']);

/**
 * BAT#28: the harness of the agent's most recent write on an item — creating it or replying in
 * it — from the agent name snapshotted on that write's activity (the key's current agent for
 * rows from before the snapshot existed). Null when none of them names a known harness.
 */
function lastWriteHarness(
  db: DbExecutor,
  agentId: string,
  item: { type: 'task' | 'issue'; id: string },
): HarnessId | null {
  const replyIds = db
    .select({ id: s.reply.id })
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, item.type),
        eq(s.reply.parentId, item.id),
        eq(s.reply.authorId, agentId),
      ),
    )
    .all()
    .map((row) => row.id);
  const created = and(
    eq(s.activity.entityType, item.type),
    eq(s.activity.entityId, item.id),
    eq(s.activity.action, `${item.type}.created`),
  );
  const replied =
    replyIds.length > 0
      ? and(
          eq(s.activity.entityType, 'reply'),
          inArray(s.activity.entityId, replyIds),
          eq(s.activity.action, 'reply.created'),
        )
      : undefined;
  const rows = db
    .select({
      agentName: s.activity.viaAgentName,
      keyAgentName: s.apiKey.agentName,
    })
    .from(s.activity)
    .leftJoin(s.apiKey, eq(s.apiKey.id, s.activity.viaKeyId))
    .where(and(eq(s.activity.actorId, agentId), replied ? or(created, replied) : created))
    .orderBy(desc(s.activity.createdAt), desc(s.activity.id))
    .limit(20)
    .all();
  for (const row of rows) {
    const harness = harnessOfAgentName(row.agentName ?? row.keyAgentName);
    if (harness) return harness;
  }
  return null;
}

/**
 * `GET /api/agent/jobs/:jobId/brief?runner=`: the prompt for a job (the task, its stage, what is
 * missing, the latest replies, the job and the rules), the model chain from the owner's mappings
 * for the task's difficulty, and the harness sessions to resume on the runner's machine.
 */
export function jobBrief(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  runnerId: string | undefined,
): JobBrief {
  const agent = requireKeyAgent(actor);
  const { orm } = deps.db;
  const job = orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || job.agentUserId !== agent.id) throw errors.notFound('Job');
  const [context] = jobContexts(deps, [job]);
  if (!context) throw errors.notFound('Job');
  const item = jobItem(orm, job);
  const task =
    item?.type === 'task'
      ? orm.select().from(s.task).where(eq(s.task.id, item.id)).get()
      : undefined;

  // Difficulty and the chain.
  const { level, resolved: mapped } = mappedChain(orm, agent.ownerId, job, task);
  const jobStage =
    typeof job.payload.stage === 'string' ? job.payload.stage : (context.target.status ?? null);
  // Agent access: the model the owner chose when approving the request wins over the mappings.
  const override = job.modelOverride?.length ? job.modelOverride : null;
  const resolved = override
    ? { chain: override, source: 'chosen by your owner when approving the request' }
    : mapped;

  // Harness sessions on this machine (most recent first).
  const resume: Record<string, string> = {};
  let sessionHarness: HarnessId | null = null;
  // A catch-up summary (or a task draft) starts fresh: it must not continue (or disturb) the
  // task's work session.
  if (runnerId && task && job.kind !== 'catch_up' && job.kind !== 'draft_task') {
    const runner = requireRunner(deps, agent.id, runnerId);
    for (const row of orm
      .select()
      .from(s.agentHarnessSession)
      .where(
        and(
          eq(s.agentHarnessSession.agentUserId, agent.id),
          eq(s.agentHarnessSession.taskId, task.id),
          eq(s.agentHarnessSession.machineId, runner.machineId ?? ''),
        ),
      )
      .orderBy(desc(s.agentHarnessSession.updatedAt))
      .all()) {
      resume[row.harness] = row.sessionId;
      const harness = harnessIdSchema.safeParse(row.harness);
      if (harness.success) sessionHarness ??= harness.data;
    }
  }

  // BAT#28: a follow-up goes to the harness that has been working on the item.
  let chain = resolved.chain;
  let chainSource = resolved.source;
  if (item && !override && FOLLOW_UP_KINDS.has(job.kind)) {
    const working = sessionHarness ?? lastWriteHarness(orm, agent.id, item);
    if (working && chain[0]?.harness !== working) {
      chain = preferHarness(chain, working, AGENT_RUNNER_LIMITS.chain);
      chainSource = `${resolved.source}; ${HARNESS_LABELS[working]} first: it has been working on this ${item.type}`;
    }
  }

  const names = getUserSummaries(orm, [agent.id, agent.ownerId]);
  const me = names.get(agent.id)?.username ?? 'your-agent';
  const owner = names.get(agent.ownerId)?.username ?? 'your owner';
  const ref = context.target.ref ?? 'the item';
  const briefBase = {
    jobId: job.id,
    kind: job.kind,
    project: context.project,
    target: {
      type: job.targetType,
      ref: context.target.ref,
      title: context.target.title,
      url: context.target.url,
    },
    difficulty: level ? { id: level.id, name: level.name } : null,
    chain,
    chainSource,
    resume,
  };
  if (job.kind === 'catch_up') {
    return {
      ...briefBase,
      prompt: catchUpPrompt({
        me,
        owner,
        ref,
        title: context.target.title,
        url: context.target.url,
        jobId: job.id,
        instructions: context.instructions,
        messages: catchUpBriefMessages(orm, job),
      }),
    };
  }
  if (job.kind === 'draft_task') {
    return { ...briefBase, prompt: taskDraftPrompt(deps, job, { me, owner }) };
  }
  const stage = task
    ? stageOf(orm, { userId: agent.id, ownerId: agent.ownerId, source: 'api', key: null }, task)
    : null;
  const sections: string[] = [
    `# Baton job: ${job.kind.replace('_', ' ')} on ${ref}${context.target.title ? ` — ${context.target.title}` : ''}`,
    ...sentBackSection(job, stage),
    `You are **@${me}**, the Baton agent of **@${owner}**, running headless on their machine for this one job. Use the Baton MCP tools (get_task, add_reply, move_task, complete_job, …) to read and write in Baton: everything you write is posted as @${me}. Work in the current folder, with your usual tools and settings.`,
    `## The job\n\n${context.instructions}\n\nJob id: \`${job.id}\`.`,
  ];
  if (item) {
    // BAT-25: which pipeline the task is in, when the project has more than the default one.
    const pipeline = task ? pipelineRow(orm, pipelineIdOfStatus(orm, task.statusId) ?? '') : null;
    const facts = [
      `- URL: ${context.target.url ?? ''}`,
      ...(pipeline && !pipeline.isDefault ? [`- Pipeline: ${pipeline.name}`] : []),
      ...(context.target.status ? [`- Status: ${context.target.status}`] : []),
      ...(task ? [`- Priority: ${PRIORITIES[task.priority]?.label ?? 'None'}`] : []),
      ...(task
        ? [
            `- Difficulty: ${level?.name ?? 'none'}${
              override
                ? ' (your owner chose your model for this job)'
                : jobStage
                  ? ` (the task’s difficulty in ${jobStage}; it picked your model)`
                  : ''
            }`,
          ]
        : []),
    ];
    sections.push(
      `## ${item.type === 'task' ? 'Task' : 'Issue'} ${ref}: ${item.title}\n\n${facts.join('\n')}\n\n### ${
        item.type === 'task' ? 'Description' : 'Body'
      }\n\n${item.body.trim() || '_(empty)_'}`,
    );
  }
  if (stage) sections.push(stageSection(stage));
  if (context.stageInstructions && !task) {
    sections.push(`## Stage instructions\n\n${context.stageInstructions}`);
  }
  if (context.trigger) {
    sections.push(
      `## The reply that triggered this job (by @${context.trigger.author?.username ?? 'someone'}, reply id \`${context.trigger.replyId}\`)\n\n${quote(context.trigger.body)}`,
    );
  }
  if (item) {
    const replies = recentReplies(orm, item);
    if (replies.length > 0) {
      sections.push(
        `## Latest replies (oldest first)\n\n${replies
          .map(
            (reply) =>
              `**${reply.author}** (${reply.createdAt.toISOString()}, id \`${reply.id}\`):\n${quote(reply.body)}`,
          )
          .join('\n\n')}`,
      );
    }
  }
  if (job.kind === 'action_result') {
    sections.push(
      `## Action result\n\n\`\`\`json\n${JSON.stringify(job.payload, null, 2)}\n\`\`\``,
    );
  }
  sections.push(
    [
      '## Rules',
      '- Follow the task’s own directions (if it says to push, push). Baton only fills in the blanks: the task, its stage and the replies.',
      '- Keep people informed with add_reply: what you did, what is left, links. Ask with add_reply when something is unclear rather than guessing.',
      ...(item?.conversationMode === 'chat'
        ? [
            '- This conversation is a chat (a flat message stream, like Discord): keep replies short, like chat messages, and answer the message that pinged you with add_reply { inReplyTo }.',
          ]
        : []),
      '- When the work of this stage is done, give evidence for the exit criteria and move the task on with move_task, if you may.',
      '- Handshake: when you think a discussion is finished, reply with add_reply { closing: true }. If this job comes from another agent’s closing reply and you agree, call complete_job { jobId, agreeDone: true } without replying.',
      `- Finish by calling complete_job { jobId: "${job.id}" }. If you can’t do it, call release_job { jobId: "${job.id}" } and say why in a reply.`,
    ].join('\n'),
  );

  return { ...briefBase, prompt: sections.join('\n\n') };
}

// ---------------------------------------------------------------------------------------------
// Harness sessions and usage
// ---------------------------------------------------------------------------------------------

/** `PUT /api/agent/jobs/:jobId/session`: the harness session a job ran in on the runner's machine. */
export function setHarnessSession(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  input: HarnessSessionInput,
): { ok: true } {
  const agent = requireKeyAgent(actor);
  const { orm } = deps.db;
  const job = orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || job.agentUserId !== agent.id) throw errors.notFound('Job');
  const runner = requireRunner(deps, agent.id, input.runnerId);
  const item = jobItem(orm, job);
  const now = new Date();
  const row = (taskId: string) => ({
    agentUserId: agent.id,
    taskId,
    machineId: runner.machineId ?? '',
    harness: input.harness,
    sessionId: input.sessionId,
    updatedAt: now,
  });
  // Sessions resume per task; other targets start fresh every time.
  if (item?.type === 'task') {
    orm
      .insert(s.agentHarnessSession)
      .values(row(item.id))
      .onConflictDoUpdate({
        target: [
          s.agentHarnessSession.agentUserId,
          s.agentHarnessSession.taskId,
          s.agentHarnessSession.machineId,
          s.agentHarnessSession.harness,
        ],
        set: { sessionId: input.sessionId, updatedAt: now },
      })
      .run();
  }
  // BAT#28: tasks the run created or replied in resume this session too, unless they have a
  // session of their own for the harness here (never replaced). Refs the agent can't see, and
  // issues, are skipped.
  const linked = new Set<string>(item?.type === 'task' ? [item.id] : []);
  for (const ref of input.items ?? []) {
    let taskId: string;
    try {
      taskId = resolveTask(deps, actor, ref).task.id;
    } catch {
      continue;
    }
    if (linked.has(taskId)) continue;
    linked.add(taskId);
    orm.insert(s.agentHarnessSession).values(row(taskId)).onConflictDoNothing().run();
  }
  return { ok: true };
}

export function recordUsage(
  deps: AppDeps,
  agent: { id: string; ownerId: string },
  job: JobRow,
  input: FinishJobInput,
) {
  const { usage } = finishJobInputSchema.parse(input);
  if (usage.length === 0) return;
  const { orm } = deps.db;
  const item = jobItem(orm, job);
  const task =
    item?.type === 'task'
      ? orm
          .select({ id: s.task.id, statusId: s.task.statusId, difficultyId: s.task.difficultyId })
          .from(s.task)
          .where(eq(s.task.id, item.id))
          .get()
      : undefined;
  const difficultyId = task ? jobDifficultyId(orm, job, task) : null;
  const level = difficultyId
    ? orm
        .select({ name: s.difficulty.name })
        .from(s.difficulty)
        .where(eq(s.difficulty.id, difficultyId))
        .get()
    : undefined;
  const now = new Date();
  deps.db.write((tx) => {
    // One row per harness run, in the order they ran (a millisecond apart).
    for (const [index, entry] of usage.entries()) {
      tx.insert(s.agentUsage)
        .values({
          id: newId(),
          ownerId: agent.ownerId,
          agentUserId: agent.id,
          jobId: job.id,
          projectId: job.projectId,
          difficulty: level?.name ?? null,
          harness: entry.harness,
          model: entry.model,
          reportedModel: entry.reportedModel,
          effort: entry.effort,
          tokensIn: entry.tokensIn,
          tokensOut: entry.tokensOut,
          tokensCacheRead: entry.tokensCacheRead,
          tokensCacheWrite: entry.tokensCacheWrite,
          tokensReasoning: entry.tokensReasoning,
          costMicros: Math.round(entry.costUsd * 1_000_000),
          durationMs: entry.durationMs,
          outcome: entry.outcome,
          error: entry.error,
          createdAt: new Date(now.getTime() + index),
        })
        .run();
    }
  });
}

/** Usage reported with MCP `complete_job` / `release_job` (the agent's own job). */
export function recordJobUsage(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  usage: FinishJobInput['usage'],
): void {
  if (!usage?.length) return;
  const agent = requireKeyAgent(actor);
  const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || job.agentUserId !== agent.id) throw errors.notFound('Job');
  recordUsage(deps, agent, job, { usage });
}

/**
 * `POST /api/agent/jobs/:jobId/complete|release` from the app: records what each harness run
 * cost, then completes or releases the job like `complete_job` / `release_job` when it is still
 * claimed. `hold` puts a released job under "Stopped runs" for the owner (killed or failed runs).
 * How the run ended, its last error and the tail of its output are kept on the job (BAT#23).
 */
export function finishJob(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  mode: 'complete' | 'release',
  input: FinishJobInput,
): AgentJobContext {
  const agent = requireKeyAgent(actor);
  const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || job.agentUserId !== agent.id) throw errors.notFound('Job');
  const parsed = finishJobInputSchema.parse(input);
  recordUsage(deps, agent, job, input);
  const lastRun = parsed.usage.at(-1);
  deps.db.orm
    .update(s.agentJob)
    .set({
      runOutcome: parsed.outcome ?? lastRun?.outcome ?? (mode === 'complete' ? 'done' : 'released'),
      runError: parsed.error ?? lastRun?.error ?? null,
      runOutput: parsed.output ?? null,
      runEndedAt: new Date(),
    })
    .where(eq(s.agentJob.id, job.id))
    .run();
  // The agent usually completes or releases the job itself (complete_job / release_job): only a
  // job still claimed is finished here.
  if (job.status !== 'claimed') return jobContexts(deps, [job])[0] as AgentJobContext;
  if (mode === 'complete' && input.deliveredTo) {
    // BAT#31: its message went to the running session of another job of the agent.
    const host = deps.db.orm
      .select({ id: s.agentJob.id, agentUserId: s.agentJob.agentUserId })
      .from(s.agentJob)
      .where(eq(s.agentJob.id, input.deliveredTo))
      .get();
    if (host?.agentUserId !== agent.id) throw errors.notFound('Job');
    deps.db.write((tx) => {
      tx.update(s.agentJob)
        .set({ payload: { ...job.payload, deliveredTo: host.id } })
        .where(eq(s.agentJob.id, job.id))
        .run();
    });
  }
  if (mode === 'complete') {
    return completeJob(deps, actor, { jobId, ...(input.agreeDone ? { agreeDone: true } : {}) });
  }
  const released = releaseJob(deps, actor, { jobId });
  if (!input.hold) return released;
  deps.db.write((tx) => {
    tx.update(s.agentJob)
      .set({ needsOk: true, heldAt: new Date() })
      .where(eq(s.agentJob.id, job.id))
      .run();
    jobChanged(tx, job, agent.ownerId);
    // BAT#29: the task may have finished while it ran (the agent moved it on, then failed).
    const item = jobItem(tx, job);
    if (item) clearSettledJobs(tx, { type: item.type, id: item.id });
  });
  return jobContexts(deps, [
    deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, job.id)).get() ?? job,
  ])[0] as AgentJobContext;
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

function emptyTotals(): AgentUsageTotals {
  return {
    jobs: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensReasoning: 0,
    costUsd: 0,
    costEstimatedUsd: 0,
    unpricedRuns: 0,
    durationMs: 0,
  };
}

type UsageRow = typeof s.agentUsage.$inferSelect;

/** The model a run used: what the harness reported, else the chain's (BAT#25). */
function runModel(row: Pick<UsageRow, 'model' | 'reportedModel'>): string {
  return canonicalModel(row.reportedModel || row.model);
}

/**
 * `GET /api/me/agent/stats?days=`: the owner's agent usage per day, harness, model, level. Costs:
 * what the harness reported, else an estimate at API prices (`shared/modelPrices.ts`, BAT#25);
 * runs of models without a known price count in `unpricedRuns`. Models are grouped by their
 * canonical id, so one model written several ways is one row.
 */
export function agentStats(deps: AppDeps, actor: Actor, days: number): AgentStats {
  const owner = requireOwner(deps, actor);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = deps.db.orm
    .select()
    .from(s.agentUsage)
    .where(and(eq(s.agentUsage.ownerId, owner.ownerId), gte(s.agentUsage.createdAt, since)))
    .all();
  const totals = emptyTotals();
  const byDay = new Map<string, AgentUsageTotals>();
  const byHarness = new Map<string, AgentUsageTotals>();
  const byModel = new Map<string, AgentUsageTotals & { harness: string; model: string }>();
  const byDifficulty = new Map<string, AgentUsageTotals>();
  const byOutcome = new Map<string, number>();
  const jobsSeen = {
    all: new Set<string>(),
    day: new Map<string, Set<string>>(),
    harness: new Map<string, Set<string>>(),
    model: new Map<string, Set<string>>(),
    difficulty: new Map<string, Set<string>>(),
  };
  const estimates = new Map<string, number | null>();
  const add = (target: AgentUsageTotals, seen: Set<string>, row: UsageRow) => {
    const jobKey = row.jobId ?? row.id;
    if (!seen.has(jobKey)) {
      seen.add(jobKey);
      target.jobs += 1;
    }
    target.tokensIn += row.tokensIn;
    target.tokensOut += row.tokensOut;
    target.tokensCacheRead += row.tokensCacheRead;
    target.tokensCacheWrite += row.tokensCacheWrite;
    target.tokensReasoning += row.tokensReasoning;
    target.durationMs += row.durationMs;
    if (row.costMicros > 0) {
      target.costUsd += row.costMicros / 1_000_000;
      return;
    }
    if (!estimates.has(row.id)) estimates.set(row.id, estimateCost(runModel(row), row));
    const estimate = estimates.get(row.id) ?? null;
    if (estimate === null) target.unpricedRuns += 1;
    else target.costEstimatedUsd += estimate;
  };
  const bucket = <T extends AgentUsageTotals>(
    map: Map<string, T>,
    seenMap: Map<string, Set<string>>,
    key: string,
    make: () => T,
  ): [T, Set<string>] => {
    let value = map.get(key);
    if (!value) {
      value = make();
      map.set(key, value);
    }
    let seen = seenMap.get(key);
    if (!seen) {
      seen = new Set();
      seenMap.set(key, seen);
    }
    return [value, seen];
  };
  for (const row of rows) {
    add(totals, jobsSeen.all, row);
    const day = row.createdAt.toISOString().slice(0, 10);
    add(...bucket(byDay, jobsSeen.day, day, emptyTotals), row);
    add(...bucket(byHarness, jobsSeen.harness, row.harness, emptyTotals), row);
    const model = runModel(row);
    add(
      ...bucket(byModel, jobsSeen.model, `${row.harness}\u0000${model}`, () => ({
        ...emptyTotals(),
        harness: row.harness,
        model,
      })),
      row,
    );
    add(...bucket(byDifficulty, jobsSeen.difficulty, row.difficulty ?? 'None', emptyTotals), row);
    byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1);
  }
  const sorted = <T>(entries: Iterable<[string, T]>) =>
    [...entries].sort(([a], [b]) => a.localeCompare(b));
  return {
    days,
    totals,
    byDay: sorted(byDay).map(([day, value]) => ({ day, ...value })),
    byHarness: sorted(byHarness).map(([harness, value]) => ({ harness, ...value })),
    byModel: sorted(byModel).map(([, value]) => value),
    byDifficulty: sorted(byDifficulty).map(([difficulty, value]) => ({ difficulty, ...value })),
    byOutcome: sorted(byOutcome).map(([outcome, jobs]) => ({ outcome, jobs })),
  };
}

/** How far back `modelFailures` looks. */
const MODEL_FAILURES_DAYS = 30;

/**
 * `GET /api/me/agent/model-failures` (BAT#23): per harness and model as written in a chain
 * (canonical), the error of its latest run when that run failed, so the chain editors can show
 * "Last run failed: …" next to the entry (a model the harness rejects, say). Model lists are never
 * hardcoded: this is what the harness itself said.
 */
export function modelFailures(deps: AppDeps, actor: Actor): { failures: ModelFailure[] } {
  const owner = requireOwner(deps, actor);
  const since = new Date(Date.now() - MODEL_FAILURES_DAYS * 24 * 60 * 60 * 1000);
  const rows = deps.db.orm
    .select({
      harness: s.agentUsage.harness,
      model: s.agentUsage.model,
      outcome: s.agentUsage.outcome,
      error: s.agentUsage.error,
      createdAt: s.agentUsage.createdAt,
    })
    .from(s.agentUsage)
    .where(and(eq(s.agentUsage.ownerId, owner.ownerId), gte(s.agentUsage.createdAt, since)))
    .orderBy(desc(s.agentUsage.createdAt), desc(s.agentUsage.id))
    .all();
  const latest = new Map<string, (typeof rows)[number] & { canonical: string }>();
  for (const row of rows) {
    // Out of usage and kills say nothing about the model; the latest other run does.
    if (row.outcome === 'out_of_usage' || row.outcome === 'killed') continue;
    const canonical = canonicalModel(row.model);
    const key = `${row.harness}\u0000${canonical}`;
    if (!latest.has(key)) latest.set(key, { ...row, canonical });
  }
  return {
    failures: [...latest.values()]
      .filter((row) => row.outcome === 'failed' && row.error)
      .map((row) => ({
        harness: row.harness,
        model: row.canonical,
        error: row.error ?? '',
        at: row.createdAt.toISOString(),
      })),
  };
}

/** `POST /api/me/agent/pause`: pauses the owner's agent (the app's "Pause everywhere"). */
export function pauseAgentEverywhere(deps: AppDeps, actor: Actor) {
  const owner = requireOwner(deps, actor);
  return updateAgentSettings(
    deps,
    { userId: owner.ownerId, source: actor.source, key: actor.key },
    { paused: true },
  );
}
