import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  AGENT_LISTENER,
  type AgentJobKind,
  type AgentJobStatus,
  type AgentJobTargetType,
  type ReplyParentType,
} from '@shared/constants';
import type {
  AgentActivity,
  AgentJobProject,
  AgentJobSummary,
  AgentSession,
} from '@shared/schemas/agentJobs';
import { DEFAULT_JOB_SOURCES, type JobSources } from '@shared/schemas/agentRunner';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { absoluteUrl, appPaths } from '../lib/urls';
import { canViewProject, getProjectAccess, visibleProjectIds } from './access';
import { recordActivity } from './activity';
import { agentIdsAmong, agentPauseReason, findAgentId } from './agents';
import { emitAfterCommit, emitEvent } from './events';
import { findItem, type ItemInfo } from './items';
import { beginListening, isSessionListening, refreshPresence } from './presence';
import { resolveProject } from './refs';
import { getReply, type ReplyWithContext } from './replies';
import { currentUserRow } from './taskAssignees';
import { matchesRule } from './principals';
import { getUserSummaries } from './users';

/**
 * Agent jobs and listeners (docs/design/agents-and-pipelines.md §4). Agent members have no inbox:
 * whatever would notify one — a mention, an assignment, a reply in a thread it takes part in, a
 * pool hand-off or approval (pipelines), an action result (sign-off) — becomes an `agent_job`.
 * The agent's harness runs a listener loop (`start_listener`), which claims the pending jobs of
 * the projects it listens to atomically, or waits for the first one; a claimed job stays with its
 * session until `complete_job` or `release_job`. There are no leases: only when a session
 * disappears (not seen for 90 s) are its claimed jobs put back for another session.
 *
 * Two guards keep agents from talking to each other forever: the loop guard (no jobs from a reply
 * when the thread's last 5 replies are all by agents) and the done handshake (an agent's
 * `closing` reply; when the other agent agrees, no jobs come from agent replies there until a
 * person replies).
 */

type JobRow = typeof s.agentJob.$inferSelect;
type ReplyRow = typeof s.reply.$inferSelect;
type SessionRow = typeof s.agentSession.$inferSelect;

/** A job to queue (see `queueJobs`). */
export interface QueueJobInput {
  agentUserId: string;
  teamId: string;
  projectId: string;
  kind: AgentJobKind;
  targetType: AgentJobTargetType;
  targetId: string;
  /** The reply that caused it, if any (shown to the agent with its author and text). */
  triggerReplyId?: string | null;
  /** Extra context, e.g. `{ instructions }` of a pipeline stage (shown as `stageInstructions`). */
  payload?: Record<string, unknown>;
  /** Triggered by another agent's closing reply (the done handshake). */
  closing?: boolean;
  /**
   * Who caused it (a mention's, reply's or move's author); null for system sources. Jobs from
   * people outside the owner's job sources wait for the owner's OK (BAT-24).
   */
  triggeredById?: string | null;
}

/** Kinds caused by a reply in a thread: one pending job per agent and item covers them all. */
const REPLY_KINDS: readonly AgentJobKind[] = ['mention', 'thread_reply'];

function agentRow(db: DbExecutor, userId: string): { id: string; ownerId: string } | null {
  const row = db
    .select({ kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .get();
  return row?.kind === 'agent' && row.ownerId ? { id: userId, ownerId: row.ownerId } : null;
}

/** Can the agent see the project (a member of its team with VIEW_PROJECT)? */
function agentCanView(db: DbExecutor, agentId: string, projectId: string): boolean {
  const access = getProjectAccess(db, agentId, projectId);
  return access !== null && canViewProject(access);
}

export function jobChanged(
  tx: Tx,
  job: Pick<JobRow, 'id' | 'teamId' | 'projectId'>,
  ownerId: string,
) {
  emitAfterCommit(tx, {
    type: 'agent_job.changed',
    teamId: job.teamId,
    projectId: job.projectId,
    entityType: 'agent_job',
    entityId: job.id,
    actorId: null,
    userId: ownerId,
  });
}

/**
 * Queues agent jobs inside the caller's transaction, the generic entry point for every source
 * (mentions, assignments and thread replies here; pipelines' `pool`/`approval` hand-offs and
 * sign-off's `action_result` call it too). Skips users that aren't agent members, agents that
 * can't see the project (not in the team, or no `VIEW_PROJECT`) and paused agents (by their owner,
 * the team or the project). A pending job of the same agent, kind and target absorbs a new one
 * instead of queueing a duplicate (mentions and thread replies count as one kind): it takes the
 * newer trigger reply and remembers the earlier ones. Returns the ids of the queued or updated
 * jobs. Listeners wake after the commit (`agent_job.changed`, personal to the agent's owner).
 */
export function queueJobs(tx: Tx, jobs: readonly QueueJobInput[]): string[] {
  const ids: string[] = [];
  for (const job of jobs) {
    const agent = agentRow(tx, job.agentUserId);
    if (!agent) continue;
    if (!agentCanView(tx, agent.id, job.projectId)) continue;
    if (
      agentPauseReason(tx, { agentId: agent.id, ownerId: agent.ownerId }, job.teamId, job.projectId)
    ) {
      continue;
    }
    const replyKind = REPLY_KINDS.includes(job.kind);
    const accepted = acceptsJob(tx, agent, job);
    const existing = tx
      .select()
      .from(s.agentJob)
      .where(
        and(
          eq(s.agentJob.agentUserId, agent.id),
          eq(s.agentJob.status, 'pending'),
          eq(s.agentJob.targetType, job.targetType),
          eq(s.agentJob.targetId, job.targetId),
          inArray(s.agentJob.kind, replyKind ? [...REPLY_KINDS] : [job.kind]),
        ),
      )
      .orderBy(asc(s.agentJob.createdAt))
      .get();
    if (existing) {
      const payload = { ...existing.payload, ...job.payload };
      const newTrigger = job.triggerReplyId ?? null;
      if (newTrigger && existing.triggerReplyId && newTrigger !== existing.triggerReplyId) {
        const earlier = Array.isArray(existing.payload.earlierReplyIds)
          ? (existing.payload.earlierReplyIds as unknown[]).filter(
              (id): id is string => typeof id === 'string',
            )
          : [];
        payload.earlierReplyIds = [...earlier, existing.triggerReplyId].slice(-20);
      }
      tx.update(s.agentJob)
        .set({
          kind:
            replyKind && (job.kind === 'mention' || existing.kind === 'mention')
              ? 'mention'
              : existing.kind,
          triggerReplyId: newTrigger ?? existing.triggerReplyId,
          closing: newTrigger ? (job.closing ?? false) : existing.closing,
          payload,
          // A job the owner accepts makes a waiting one run.
          ...(accepted && existing.needsOk
            ? { needsOk: false, triggeredById: job.triggeredById ?? null }
            : {}),
        })
        .where(eq(s.agentJob.id, existing.id))
        .run();
      ids.push(existing.id);
      jobChanged(tx, existing, agent.ownerId);
      continue;
    }
    const row = tx
      .insert(s.agentJob)
      .values({
        id: newId(),
        agentUserId: agent.id,
        teamId: job.teamId,
        projectId: job.projectId,
        kind: job.kind,
        targetType: job.targetType,
        targetId: job.targetId,
        triggerReplyId: job.triggerReplyId ?? null,
        payload: job.payload ?? {},
        closing: job.closing ?? false,
        triggeredById: job.triggeredById ?? null,
        status: 'pending',
        needsOk: !accepted,
        createdAt: new Date(),
      })
      .returning()
      .get();
    ids.push(row.id);
    jobChanged(tx, row, agent.ownerId);
  }
  return ids;
}

/**
 * Does the owner run jobs from whoever caused this one without asking (BAT-24)? Jobs of system
 * sources and of the owner or the agent itself always run; otherwise the owner's job sources
 * decide (`me` by default, `anyone`, or a custom who-rule).
 */
function acceptsJob(tx: Tx, agent: { id: string; ownerId: string }, job: QueueJobInput): boolean {
  const by = job.triggeredById ?? null;
  if (by === null || by === agent.ownerId || by === agent.id) return true;
  const sources = jobSourcesOf(tx, agent.ownerId);
  if (sources.mode === 'anyone') return true;
  if (sources.mode === 'custom' && sources.rule) {
    return matchesRule(tx, { teamId: job.teamId, projectId: job.projectId }, by, sources.rule);
  }
  return false;
}

/** The owner's job sources (the default: only jobs they triggered). */
export function jobSourcesOf(db: DbExecutor, ownerId: string): JobSources {
  const row = db
    .select({ jobSources: s.agentSettings.jobSources })
    .from(s.agentSettings)
    .where(eq(s.agentSettings.userId, ownerId))
    .get();
  return row?.jobSources ?? DEFAULT_JOB_SOURCES;
}

/**
 * Cancels the open (pending or claimed) jobs about a target, e.g. the other agents' `pool` jobs
 * once one of them claimed the task. Returns how many were cancelled.
 */
export function cancelJobs(
  tx: Tx,
  filter: {
    targetType: AgentJobTargetType;
    targetId: string;
    kinds?: readonly AgentJobKind[];
    exceptAgentUserId?: string;
  },
): number {
  const rows = tx
    .select({
      id: s.agentJob.id,
      teamId: s.agentJob.teamId,
      projectId: s.agentJob.projectId,
      agentUserId: s.agentJob.agentUserId,
    })
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.targetType, filter.targetType),
        eq(s.agentJob.targetId, filter.targetId),
        inArray(s.agentJob.status, ['pending', 'claimed']),
        filter.kinds ? inArray(s.agentJob.kind, [...filter.kinds]) : undefined,
      ),
    )
    .all()
    .filter((row) => row.agentUserId !== filter.exceptAgentUserId);
  if (rows.length === 0) return 0;
  tx.update(s.agentJob)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(
      inArray(
        s.agentJob.id,
        rows.map((row) => row.id),
      ),
    )
    .run();
  for (const row of rows) {
    const agent = agentRow(tx, row.agentUserId);
    if (agent) jobChanged(tx, row, agent.ownerId);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Sources: mentions, assignments, thread replies
// ---------------------------------------------------------------------------------------------

function isAgentUser(db: DbExecutor, userId: string | null): boolean {
  return userId !== null && agentRow(db, userId) !== null;
}

/** A reply's closing flag counts for the handshake only when an agent wrote it. */
function closingOf(db: DbExecutor, reply: Pick<ReplyRow, 'closing' | 'authorId'>): boolean {
  return reply.closing && isAgentUser(db, reply.authorId);
}

/**
 * May this reply wake agents (mention and thread-reply jobs)? A person's reply always may. An
 * agent's may not when agents agreed nothing more is needed in the thread (the done handshake),
 * nor when the thread's last 5 replies (this one included) are all by agents (the loop guard,
 * which records a note in the item's history the first time it trips). A person's reply resets
 * both (`queueThreadReplyJobs`).
 */
function replyMayWakeAgents(tx: Tx, reply: ReplyRow): boolean {
  if (!isAgentUser(tx, reply.authorId)) return true;
  const where = and(
    eq(s.agentThread.parentType, reply.parentType),
    eq(s.agentThread.parentId, reply.parentId),
  );
  const state = tx.select().from(s.agentThread).where(where).get();
  if (state?.closedAt) return false;
  const latest = tx
    .select({ kind: s.user.kind })
    .from(s.reply)
    .leftJoin(s.user, eq(s.user.id, s.reply.authorId))
    .where(
      and(
        eq(s.reply.parentType, reply.parentType),
        eq(s.reply.parentId, reply.parentId),
        isNull(s.reply.deletedAt),
      ),
    )
    .orderBy(desc(s.reply.createdAt), desc(s.reply.id))
    .limit(AGENT_LISTENER.loopGuardReplies)
    .all();
  const looping =
    latest.length >= AGENT_LISTENER.loopGuardReplies && latest.every((row) => row.kind === 'agent');
  if (!looping) return true;
  if (!state?.loopGuardAt) {
    const now = new Date();
    tx.insert(s.agentThread)
      .values({ parentType: reply.parentType, parentId: reply.parentId, loopGuardAt: now })
      .onConflictDoUpdate({
        target: [s.agentThread.parentType, s.agentThread.parentId],
        set: { loopGuardAt: now },
      })
      .run();
    const item = findItem(tx, reply.parentType, reply.parentId);
    // A system note: the agents didn't do this, Baton did.
    recordActivity(tx, null, {
      teamId: reply.teamId,
      projectId: reply.projectId,
      entityType: reply.parentType,
      entityId: reply.parentId,
      action: `${reply.parentType}.agent_loop_guard`,
      meta: {
        ...(item ? { ref: item.ref, title: item.title } : {}),
        replies: AGENT_LISTENER.loopGuardReplies,
      },
    });
  }
  return false;
}

interface JobTarget {
  teamId: string;
  projectId: string;
  targetType: 'task' | 'issue';
  targetId: string;
  reply: ReplyRow | null;
}

/** The task or issue a notification target is about (a reply's item), with the reply. */
function jobTargetOf(tx: Tx, target: { entityType: string; entityId: string }): JobTarget | null {
  if (target.entityType === 'reply') {
    const reply = tx.select().from(s.reply).where(eq(s.reply.id, target.entityId)).get();
    if (!reply) return null;
    return {
      teamId: reply.teamId,
      projectId: reply.projectId,
      targetType: reply.parentType,
      targetId: reply.parentId,
      reply,
    };
  }
  if (target.entityType === 'task' || target.entityType === 'issue') {
    const table = target.entityType === 'task' ? s.task : s.issue;
    const row = tx
      .select({ teamId: table.teamId, projectId: table.projectId })
      .from(table)
      .where(eq(table.id, target.entityId))
      .get();
    if (!row) return null;
    return { ...row, targetType: target.entityType, targetId: target.entityId, reply: null };
  }
  return null;
}

/**
 * `mention` jobs for the agent members among `userIds` (mentioned by username in a reply, task
 * description or issue body), called by `notifyMentions` inside the write. An agent never gets a
 * job from its own text.
 */
export function queueMentionJobs(
  tx: Tx,
  actor: Actor | null,
  target: { entityType: string; entityId: string },
  userIds: readonly string[],
): void {
  if (userIds.length === 0) return;
  const agents = [...agentIdsAmong(tx, userIds)].filter((id) => id !== actor?.userId);
  if (agents.length === 0) return;
  const job = jobTargetOf(tx, target);
  if (!job) return;
  if (job.reply && !replyMayWakeAgents(tx, job.reply)) return;
  queueJobs(
    tx,
    agents.map((agentUserId) => ({
      agentUserId,
      teamId: job.teamId,
      projectId: job.projectId,
      kind: 'mention',
      targetType: job.targetType,
      targetId: job.targetId,
      triggerReplyId: job.reply?.id ?? null,
      closing: job.reply ? closingOf(tx, job.reply) : false,
      triggeredById: actor?.userId ?? null,
    })),
  );
}

/** `assigned` jobs for agent members assigned to a task directly (not through a role). */
export function queueAssignedJobs(
  tx: Tx,
  actor: Actor | null,
  taskId: string,
  userIds: readonly string[],
): void {
  if (userIds.length === 0) return;
  const agents = [...agentIdsAmong(tx, userIds)].filter((id) => id !== actor?.userId);
  if (agents.length === 0) return;
  const task = tx
    .select({ teamId: s.task.teamId, projectId: s.task.projectId })
    .from(s.task)
    .where(eq(s.task.id, taskId))
    .get();
  if (!task) return;
  queueJobs(
    tx,
    agents.map((agentUserId) => ({
      agentUserId,
      teamId: task.teamId,
      projectId: task.projectId,
      kind: 'assigned',
      targetType: 'task',
      targetId: taskId,
      triggeredById: actor?.userId ?? null,
    })),
  );
}

/** Agent members taking part in an item's thread: its author, repliers and (tasks) assignees. */
function threadAgentIds(tx: Tx, item: Pick<ItemInfo, 'type' | 'id' | 'authorId'>): string[] {
  const ids = new Set<string>();
  if (item.authorId) ids.add(item.authorId);
  for (const row of tx
    .selectDistinct({ authorId: s.reply.authorId })
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, item.type),
        eq(s.reply.parentId, item.id),
        isNull(s.reply.deletedAt),
        isNotNull(s.reply.authorId),
      ),
    )
    .all()) {
    if (row.authorId) ids.add(row.authorId);
  }
  if (item.type === 'task') {
    for (const row of tx
      .select({ userId: s.taskAssigneeUser.userId })
      .from(s.taskAssigneeUser)
      .innerJoin(s.task, eq(s.task.id, s.taskAssigneeUser.taskId))
      .where(and(eq(s.taskAssigneeUser.taskId, item.id), currentUserRow))
      .all()) {
      ids.add(row.userId);
    }
  }
  return [...agentIdsAmong(tx, [...ids])];
}

/**
 * `thread_reply` jobs for a new reply (inside its write, after `notifyMentions`): every agent
 * member that authored the item, replied in it or is assigned to it, except the reply's author.
 * A person's reply resets the thread's loop guard and done handshake.
 */
export function queueThreadReplyJobs(
  tx: Tx,
  actor: Actor,
  reply: ReplyRow,
  item: Pick<ItemInfo, 'type' | 'id' | 'authorId'>,
): void {
  if (!isAgentUser(tx, reply.authorId)) {
    tx.delete(s.agentThread)
      .where(and(eq(s.agentThread.parentType, item.type), eq(s.agentThread.parentId, item.id)))
      .run();
  } else if (!replyMayWakeAgents(tx, reply)) {
    return;
  }
  const agents = threadAgentIds(tx, item).filter((id) => id !== actor.userId);
  if (agents.length === 0) return;
  const closing = closingOf(tx, reply);
  queueJobs(
    tx,
    agents.map((agentUserId) => ({
      agentUserId,
      teamId: reply.teamId,
      projectId: reply.projectId,
      kind: 'thread_reply',
      targetType: item.type,
      targetId: item.id,
      triggerReplyId: reply.id,
      closing,
      triggeredById: reply.authorId,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------------------------

/** Is the job's target still there for the agent (a live item of a project it can see)? */
function jobStillValid(tx: Tx, job: JobRow): boolean {
  if (!agentCanView(tx, job.agentUserId, job.projectId)) return false;
  switch (job.targetType) {
    case 'task':
    case 'issue':
      return findItem(tx, job.targetType, job.targetId) !== null;
    case 'reply': {
      const reply = tx
        .select({ parentType: s.reply.parentType, parentId: s.reply.parentId })
        .from(s.reply)
        .where(and(eq(s.reply.id, job.targetId), isNull(s.reply.deletedAt)))
        .get();
      return reply ? findItem(tx, reply.parentType, reply.parentId) !== null : false;
    }
    default:
      return true;
  }
}

interface ClaimOptions {
  limit: number;
  kinds?: readonly AgentJobKind[];
  /** Only jobs with a trigger reply (the `wait_for_mentions` alias). */
  needsTrigger?: boolean;
  /** Mark them done at once (the alias delivers instead of claiming). */
  deliver?: boolean;
  /** Skip jobs waiting for the owner's OK (the desktop app's runners, BAT-24). */
  acceptedOnly?: boolean;
}

/**
 * Claims the agent's oldest pending jobs of `projectIds` for the session, atomically: one write
 * transaction (`BEGIN IMMEDIATE`) selects and updates them, so two sessions never get the same
 * job. Jobs whose target was deleted or hidden meanwhile are cancelled; jobs of a project where
 * agents are paused stay pending.
 */
function claimJobs(
  deps: AppDeps,
  agent: { id: string; ownerId: string },
  sessionId: string,
  projectIds: readonly string[],
  options: ClaimOptions,
): JobRow[] {
  if (projectIds.length === 0) return [];
  return deps.db.write((tx) => {
    const rows = tx
      .select()
      .from(s.agentJob)
      .where(
        and(
          eq(s.agentJob.agentUserId, agent.id),
          eq(s.agentJob.status, 'pending'),
          inArray(s.agentJob.projectId, [...projectIds]),
          options.kinds ? inArray(s.agentJob.kind, [...options.kinds]) : undefined,
          options.needsTrigger ? isNotNull(s.agentJob.triggerReplyId) : undefined,
          options.acceptedOnly ? eq(s.agentJob.needsOk, false) : undefined,
        ),
      )
      .orderBy(asc(s.agentJob.createdAt), asc(s.agentJob.id))
      .limit(options.limit * 3)
      .all();
    const claimed: JobRow[] = [];
    const cancelled: JobRow[] = [];
    for (const row of rows) {
      if (claimed.length >= options.limit) break;
      if (!jobStillValid(tx, row)) {
        cancelled.push(row);
        continue;
      }
      if (
        agentPauseReason(
          tx,
          { agentId: agent.id, ownerId: agent.ownerId },
          row.teamId,
          row.projectId,
        )
      ) {
        continue;
      }
      claimed.push(row);
    }
    const now = new Date();
    if (cancelled.length > 0) {
      tx.update(s.agentJob)
        .set({ status: 'cancelled', completedAt: now })
        .where(
          inArray(
            s.agentJob.id,
            cancelled.map((row) => row.id),
          ),
        )
        .run();
    }
    if (claimed.length === 0) return [];
    const status: AgentJobStatus = options.deliver ? 'done' : 'claimed';
    const updated = tx
      .update(s.agentJob)
      .set({ status, sessionId, claimedAt: now, completedAt: options.deliver ? now : null })
      .where(
        and(
          inArray(
            s.agentJob.id,
            claimed.map((row) => row.id),
          ),
          eq(s.agentJob.status, 'pending'),
        ),
      )
      .returning()
      .all();
    const [first] = updated;
    if (first) jobChanged(tx, first, agent.ownerId);
    const order = new Map(claimed.map((row, index) => [row.id, index]));
    return updated.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  });
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/** Keeps swept (offline) sessions this long for the owner's activity panel. */
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Puts the claimed jobs of sessions that disappeared (not seen for 90 s and not waiting now) back
 * to pending, and forgets sessions not seen for a day. Runs every 15 s (jobs/agents.ts) and at
 * the start of every listener call. Returns how many jobs went back to the queue.
 */
export function sweepListenerSessions(deps: AppDeps, now: Date = new Date()): number {
  const { orm } = deps.db;
  const cutoff = new Date(now.getTime() - AGENT_LISTENER.sessionTimeoutMs);
  const stale = orm
    .select({ id: s.agentSession.id, lastSeenAt: s.agentSession.lastSeenAt })
    .from(s.agentSession)
    .where(lt(s.agentSession.lastSeenAt, cutoff))
    .all()
    .filter((session) => !isSessionListening(deps, session.id));
  if (stale.length === 0) return 0;
  const staleIds = stale.map((session) => session.id);
  const forget = stale
    .filter((session) => session.lastSeenAt.getTime() < now.getTime() - SESSION_RETENTION_MS)
    .map((session) => session.id);
  const requeued = deps.db.write((tx) => {
    const rows = tx
      .update(s.agentJob)
      .set({ status: 'pending', sessionId: null, claimedAt: null })
      .where(and(eq(s.agentJob.status, 'claimed'), inArray(s.agentJob.sessionId, staleIds)))
      .returning()
      .all();
    if (forget.length > 0) {
      tx.delete(s.agentSession).where(inArray(s.agentSession.id, forget)).run();
    }
    const owners = new Map<string, JobRow>();
    for (const row of rows) {
      const agent = agentRow(tx, row.agentUserId);
      if (agent && !owners.has(agent.ownerId)) owners.set(agent.ownerId, row);
    }
    for (const [ownerId, row] of owners) jobChanged(tx, row, ownerId);
    return rows.length;
  });
  if (requeued > 0) deps.logger.info({ requeued }, 'agent jobs of vanished listeners requeued');
  return requeued;
}

function touchSession(deps: AppDeps, sessionId: string): void {
  try {
    deps.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date() })
      .where(eq(s.agentSession.id, sessionId))
      .run();
  } catch (error) {
    deps.logger.debug({ err: error }, 'listener session touch failed');
  }
}

/** Creates or refreshes the listener session (`sessionId` of this agent) for `projectIds`. */
function upsertSession(
  deps: AppDeps,
  actor: Actor,
  projectIds: readonly string[],
  sessionId: string | undefined,
): SessionRow {
  const now = new Date();
  const existing = sessionId
    ? deps.db.orm.select().from(s.agentSession).where(eq(s.agentSession.id, sessionId)).get()
    : undefined;
  if (existing?.agentUserId === actor.userId) {
    return deps.db.orm
      .update(s.agentSession)
      .set({ projectIds: [...projectIds], keyId: actor.key?.id ?? null, lastSeenAt: now })
      .where(eq(s.agentSession.id, existing.id))
      .returning()
      .get();
  }
  return deps.db.orm
    .insert(s.agentSession)
    .values({
      id: newId(),
      agentUserId: actor.userId,
      keyId: actor.key?.id ?? null,
      projectIds: [...projectIds],
      startedAt: now,
      lastSeenAt: now,
    })
    .returning()
    .get();
}

/** The agent behind a key actor, or a clear error for people and scripts without one. */
export function requireListeningAgent(
  deps: AppDeps,
  actor: Actor,
): { id: string; ownerId: string } {
  if (!actor.key || !actor.ownerId) {
    throw errors.validation(
      'Agent jobs are collected through an API key: they belong to the key owner’s agent member',
    );
  }
  const reason = agentPauseReason(
    deps.db.orm,
    { agentId: actor.userId, ownerId: actor.ownerId },
    null,
  );
  if (reason) throw errors.agentsPaused(reason);
  return { id: actor.userId, ownerId: actor.ownerId };
}

// ---------------------------------------------------------------------------------------------
// Job context (what start_listener hands the agent)
// ---------------------------------------------------------------------------------------------

export interface AgentJobContext {
  jobId: string;
  kind: AgentJobKind;
  status: AgentJobStatus;
  /** Triggered by another agent's closing reply: see `instructions`. */
  closing: boolean;
  createdAt: string;
  project: { id: string; ref: string; name: string } | null;
  target: {
    type: AgentJobTargetType;
    id: string;
    /** Team-qualified ref (`team/KEY-12`) of the task or issue. */
    ref: string | null;
    title: string | null;
    url: string | null;
    /** A task's current status (stage). */
    status: string | null;
  };
  trigger: {
    replyId: string;
    author: { username: string | null; name: string; kind: 'human' | 'agent' } | null;
    body: string;
    closing: boolean;
    url: string | null;
    createdAt: string;
  } | null;
  /** Replies that triggered this job earlier (merged into it while it was pending). */
  earlierReplyIds: string[];
  /** The stage's instructions, when a pipeline stage handed the task over. */
  stageInstructions: string | null;
  /** Who caused the job (username), when a person or agent did. */
  triggeredBy: string | null;
  /** Waiting for the owner's OK before the desktop app runs it (BAT-24). */
  needsOk: boolean;
  payload: Record<string, unknown>;
  /** What to do, and how the handshake works. */
  instructions: string;
}

const CLOSE_HINT =
  'When you think the discussion is finished, answer with add_reply { closing: true } ("no further discussion needed at this time").';

function jobInstructions(
  job: JobRow,
  ref: string,
  author: string | null,
  hasEarlier: boolean,
): string {
  const who = author ? `@${author}` : 'Someone';
  const more = hasEarlier ? ' Earlier replies triggered it too: read the thread since them.' : '';
  let text: string;
  switch (job.kind) {
    case 'mention':
      text = job.triggerReplyId
        ? `${who} mentioned you in a reply on ${ref}. Read the thread (get_task/get_issue, list_replies), do what is asked and answer with add_reply { item: "${ref}", inReplyTo: "${job.triggerReplyId}" }.${more}`
        : `You were mentioned in ${ref}. Read it (get_task/get_issue) and do what is asked; reply with add_reply.`;
      break;
    case 'thread_reply':
      text = `${who} replied on ${ref}, a thread you take part in. Answer only if it needs you (add_reply with inReplyTo: "${job.triggerReplyId ?? ''}"); otherwise just complete the job.${more}`;
      break;
    case 'assigned':
      text = `${ref} was assigned to you. Read it (get_task), claim it (claim_task), do the work, report with add_reply and move it on (move_task) when done.`;
      break;
    case 'pool':
      text = `${ref} entered a stage you may pick up. To take it, claim_task (the first claim wins and assigns it to you); if you don't want it, release_job.`;
      break;
    case 'approval':
      text = `You may approve ${ref}'s current stage. Review it (get_task) and give your decision, or complete the job if it doesn't need you.`;
      break;
    case 'action_result':
      text = `A person decided on an action you asked for (see payload). Carry on accordingly.`;
      break;
  }
  const handshake = job.closing
    ? ' The trigger reply is marked closing: the other agent thinks nothing more is needed. If you agree, call complete_job { jobId, agreeDone: true } WITHOUT replying (that closes the thread for agents until a person replies); if you disagree, reply and complete the job.'
    : ` ${CLOSE_HINT}`;
  return `${text}${handshake} Call complete_job { jobId: "${job.id}" } when you are done, or release_job to hand it back.`;
}

function projectsById(db: DbExecutor, projectIds: readonly string[]): Map<string, AgentJobProject> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: s.project.id, key: s.project.key, name: s.project.name, teamSlug: s.team.slug })
      .from(s.project)
      .innerJoin(s.team, eq(s.team.id, s.project.teamId))
      .where(inArray(s.project.id, ids))
      .all()
      .map((row) => [row.id, row]),
  );
}

/** The task or issue a job is about (a reply target's item). */
export function jobItem(
  db: DbExecutor,
  job: Pick<JobRow, 'targetType' | 'targetId'>,
): ItemInfo | null {
  if (job.targetType === 'task' || job.targetType === 'issue') {
    return findItem(db, job.targetType, job.targetId);
  }
  if (job.targetType === 'reply') {
    const reply = db
      .select({ parentType: s.reply.parentType, parentId: s.reply.parentId })
      .from(s.reply)
      .where(eq(s.reply.id, job.targetId))
      .get();
    return reply ? findItem(db, reply.parentType, reply.parentId) : null;
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Full context of jobs for the agent: target, trigger reply, instructions (absolute URLs). */
export function jobContexts(deps: AppDeps, rows: readonly JobRow[]): AgentJobContext[] {
  const { orm } = deps.db;
  const projects = projectsById(
    orm,
    rows.map((row) => row.projectId),
  );
  const triggerIds = rows.flatMap((row) => (row.triggerReplyId ? [row.triggerReplyId] : []));
  const triggers = new Map(
    (triggerIds.length === 0
      ? []
      : orm
          .select()
          .from(s.reply)
          .where(and(inArray(s.reply.id, triggerIds), isNull(s.reply.deletedAt)))
          .all()
    ).map((reply) => [reply.id, reply]),
  );
  const authors = getUserSummaries(orm, [
    ...[...triggers.values()].map((reply) => reply.authorId),
    ...rows.map((row) => row.triggeredById),
  ]);
  return rows.map((job) => {
    const project = projects.get(job.projectId) ?? null;
    const item = jobItem(orm, job);
    const ref = item ? `${item.teamSlug}/${item.ref}` : null;
    const status =
      item?.type === 'task'
        ? (orm
            .select({ name: s.status.name })
            .from(s.task)
            .innerJoin(s.status, eq(s.status.id, s.task.statusId))
            .where(eq(s.task.id, item.id))
            .get()?.name ?? null)
        : null;
    const reply = job.triggerReplyId ? triggers.get(job.triggerReplyId) : undefined;
    const author = reply?.authorId ? authors.get(reply.authorId) : undefined;
    const earlierReplyIds = stringList(job.payload.earlierReplyIds);
    const instructions =
      typeof job.payload.instructions === 'string' ? job.payload.instructions : null;
    return {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      closing: job.closing,
      createdAt: job.createdAt.toISOString(),
      project: project
        ? { id: project.id, ref: `${project.teamSlug}/${project.key}`, name: project.name }
        : null,
      target: {
        type: job.targetType,
        id: job.targetId,
        ref,
        title: item?.title ?? null,
        url: item ? absoluteUrl(deps.env.baseUrl, item.path) : null,
        status,
      },
      trigger: reply
        ? {
            replyId: reply.id,
            author: author
              ? { username: author.username, name: author.name, kind: author.kind ?? 'human' }
              : null,
            body: reply.body,
            closing: reply.closing,
            url: item ? absoluteUrl(deps.env.baseUrl, appPaths.reply(item.path, reply.id)) : null,
            createdAt: reply.createdAt.toISOString(),
          }
        : null,
      earlierReplyIds,
      stageInstructions: instructions,
      triggeredBy: job.triggeredById ? (authors.get(job.triggeredById)?.username ?? null) : null,
      needsOk: job.needsOk,
      payload: job.payload,
      instructions: jobInstructions(
        job,
        ref ?? 'the item',
        author?.username ?? null,
        earlierReplyIds.length > 0,
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// start_listener, complete_job, release_job, list_jobs
// ---------------------------------------------------------------------------------------------

export interface StartListenerInput {
  /** Project refs (KEY, team-slug/KEY) or ids. */
  projects: readonly string[];
  timeoutSeconds?: number;
  sessionId?: string;
}

export interface ListenerResult {
  sessionId: string;
  projects: Array<{ id: string; ref: string; name: string }>;
  /** Requested projects not listened to, and why (agents paused there). */
  skipped: Array<{ ref: string; reason: string }>;
  jobs: AgentJobContext[];
}

export interface ListenOptions extends ClaimOptions {
  timeoutSeconds: number;
}

/**
 * Claims now, or waits until a job arrives (woken by `agent_job.changed` of the owner), the
 * timeout passes or the request goes away. While it waits, the session counts as seen.
 */
export async function listen(
  deps: AppDeps,
  agent: { id: string; ownerId: string },
  sessionId: string,
  projectIds: readonly string[],
  options: ListenOptions,
  signal?: AbortSignal,
): Promise<JobRow[]> {
  sweepListenerSessions(deps);
  const claim = () => claimJobs(deps, agent, sessionId, projectIds, options);
  const first = claim();
  if (first.length > 0 || options.timeoutSeconds <= 0 || signal?.aborted) {
    refreshPresence(deps, [agent.id]);
    return first;
  }
  const stop = beginListening(deps, sessionId, agent.id);
  refreshPresence(deps, [agent.id]);
  const timeoutMs = Math.min(options.timeoutSeconds, AGENT_LISTENER.maxWaitSeconds) * 1000;
  try {
    return await new Promise<JobRow[]>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (rows: JobRow[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(rows);
      };
      const tryClaim = () => {
        try {
          return claim();
        } catch (error) {
          deps.logger.warn({ err: error }, 'agent job claim failed');
          return [];
        }
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish(tryClaim()), timeoutMs);
      unsubscribe = deps.events.subscribe((event) => {
        if (settled || event.type !== 'agent_job.changed' || event.userId !== agent.ownerId) return;
        const rows = tryClaim();
        if (rows.length > 0) finish(rows);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  } finally {
    stop();
    touchSession(deps, sessionId);
    refreshPresence(deps, [agent.id]);
  }
}

/**
 * MCP `start_listener`: registers or refreshes the agent's listener session for the given
 * projects only (`sessionId` from the previous call keeps the same session), then returns the
 * pending jobs of those projects, claimed atomically by this session (at most 10), or waits up
 * to `timeoutSeconds` (≤ 110) for the first one. A paused agent gets a clear error; projects where
 * agents are paused are skipped (an error when all of them are).
 */
export async function startListener(
  deps: AppDeps,
  actor: Actor,
  input: StartListenerInput,
  signal?: AbortSignal,
): Promise<ListenerResult> {
  const agent = requireListeningAgent(deps, actor);
  if (input.projects.length === 0) {
    throw errors.validation('Name the projects to listen to (KEY or team-slug/KEY)', {
      field: 'projects',
    });
  }
  if (input.projects.length > AGENT_LISTENER.maxProjects) {
    throw errors.validation(`Listen to at most ${AGENT_LISTENER.maxProjects} projects at once`, {
      field: 'projects',
    });
  }
  const listened = new Map<string, { id: string; ref: string; name: string }>();
  const skipped: ListenerResult['skipped'] = [];
  for (const ref of input.projects) {
    const { project, team } = resolveProject(deps, actor, ref);
    const qualified = `${team.slug}/${project.key}`;
    const reason = agentPauseReason(
      deps.db.orm,
      { agentId: agent.id, ownerId: agent.ownerId },
      team.id,
      project.id,
    );
    if (reason) skipped.push({ ref: qualified, reason });
    else listened.set(project.id, { id: project.id, ref: qualified, name: project.name });
  }
  if (listened.size === 0) {
    throw errors.agentsPaused(skipped[0]?.reason ?? 'Agents are paused in these projects');
  }
  const projectIds = [...listened.keys()];
  const session = upsertSession(deps, actor, projectIds, input.sessionId);
  emitEvent(deps, {
    type: 'agent_job.changed',
    teamId: null,
    entityType: 'agent_job',
    entityId: session.id,
    actorId: actor.userId,
    userId: agent.ownerId,
  });
  const rows = await listen(
    deps,
    agent,
    session.id,
    projectIds,
    {
      limit: AGENT_LISTENER.maxJobsPerCall,
      timeoutSeconds: input.timeoutSeconds ?? AGENT_LISTENER.defaultWaitSeconds,
    },
    signal,
  );
  return {
    sessionId: session.id,
    projects: [...listened.values()],
    skipped,
    jobs: jobContexts(deps, rows),
  };
}

/** One of the agent's jobs, or not found (jobs of other agents don't exist for it). */
function requireOwnJob(deps: AppDeps, actor: Actor, jobId: string): JobRow {
  const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (job?.agentUserId !== actor.userId) throw errors.notFound('Job');
  return job;
}

/**
 * MCP `complete_job`: the agent handled the job. `agreeDone` on a job from another agent's
 * closing reply is the done handshake: without replying, the agent agrees nothing more is needed;
 * an activity row records "<a> and <b> agreed nothing more is needed" and agent replies in that
 * thread wake no agent until a person replies. Completing a done job again changes nothing.
 */
export function completeJob(
  deps: AppDeps,
  actor: Actor,
  input: { jobId: string; agreeDone?: boolean },
): AgentJobContext {
  requireListeningAgent(deps, actor);
  const job = requireOwnJob(deps, actor, input.jobId);
  if (input.agreeDone && !job.closing) {
    throw errors.validation(
      'agreeDone is only for jobs from another agent’s closing reply (the job’s closing flag)',
      { field: 'agreeDone' },
    );
  }
  if (job.status === 'cancelled') throw errors.conflict('This job was cancelled');
  if (job.status !== 'done') {
    deps.db.write((tx) => {
      const now = new Date();
      if (input.agreeDone) agreeDone(tx, actor, job, now);
      tx.update(s.agentJob)
        .set({ status: 'done', completedAt: now })
        .where(eq(s.agentJob.id, job.id))
        .run();
      if (actor.ownerId) jobChanged(tx, job, actor.ownerId);
    });
    if (job.sessionId) touchSession(deps, job.sessionId);
  }
  const updated = requireOwnJob(deps, actor, job.id);
  return jobContexts(deps, [updated])[0] as AgentJobContext;
}

/** The done handshake: record the agreement and close the thread for agents. */
function agreeDone(tx: Tx, actor: Actor, job: JobRow, now: Date): void {
  const item = jobItem(tx, job);
  if (!item) throw errors.conflict('The task or issue of this job is gone');
  const trigger = job.triggerReplyId
    ? tx
        .select({ authorId: s.reply.authorId })
        .from(s.reply)
        .where(eq(s.reply.id, job.triggerReplyId))
        .get()
    : undefined;
  const names = getUserSummaries(tx, [trigger?.authorId ?? null, actor.userId]);
  const other = trigger?.authorId ? names.get(trigger.authorId) : undefined;
  const me = names.get(actor.userId);
  recordActivity(tx, actor, {
    teamId: item.teamId,
    projectId: item.projectId,
    entityType: item.type,
    entityId: item.id,
    action: `${item.type}.agents_agreed_done`,
    meta: {
      ref: item.ref,
      title: item.title,
      agents: [other?.username, me?.username].filter(Boolean),
      with: other?.username ?? null,
      replyId: job.triggerReplyId,
    },
  });
  tx.insert(s.agentThread)
    .values({ parentType: item.type, parentId: item.id, closedAt: now })
    .onConflictDoUpdate({
      target: [s.agentThread.parentType, s.agentThread.parentId],
      set: { closedAt: now },
    })
    .run();
}

/** MCP `release_job`: hands a claimed job back to the queue for any listener of the agent. */
export function releaseJob(deps: AppDeps, actor: Actor, input: { jobId: string }): AgentJobContext {
  requireListeningAgent(deps, actor);
  const job = requireOwnJob(deps, actor, input.jobId);
  if (job.status === 'done' || job.status === 'cancelled') {
    throw errors.conflict(`This job is already ${job.status}`);
  }
  if (job.status === 'claimed') {
    deps.db.write((tx) => {
      tx.update(s.agentJob)
        .set({ status: 'pending', sessionId: null, claimedAt: null })
        .where(and(eq(s.agentJob.id, job.id), eq(s.agentJob.status, 'claimed')))
        .run();
      if (actor.ownerId) jobChanged(tx, job, actor.ownerId);
    });
    if (job.sessionId) touchSession(deps, job.sessionId);
  }
  return jobContexts(deps, [requireOwnJob(deps, actor, job.id)])[0] as AgentJobContext;
}

/** MCP `list_jobs`: the agent's jobs, newest first (50), optionally of one status. */
export function listJobs(
  deps: AppDeps,
  actor: Actor,
  input: { status?: AgentJobStatus; limit?: number },
): { jobs: AgentJobContext[]; pendingCount: number } {
  if (!actor.key || !actor.ownerId) {
    throw errors.validation('Agent jobs belong to the agent member an API key acts as');
  }
  const rows = deps.db.orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, actor.userId),
        input.status ? eq(s.agentJob.status, input.status) : undefined,
      ),
    )
    .orderBy(desc(s.agentJob.createdAt), desc(s.agentJob.id))
    .limit(Math.min(input.limit ?? 50, 50))
    .all();
  return {
    jobs: jobContexts(deps, rows),
    pendingCount: pendingJobCount(deps.db.orm, actor.userId),
  };
}

/** How many jobs wait for the agent. */
export function pendingJobCount(db: DbExecutor, agentId: string): number {
  return (
    db
      .select({ value: sql<number>`count(*)` })
      .from(s.agentJob)
      .where(and(eq(s.agentJob.agentUserId, agentId), eq(s.agentJob.status, 'pending')))
      .get()?.value ?? 0
  );
}

// ---------------------------------------------------------------------------------------------
// wait_for_mentions (deprecated alias)
// ---------------------------------------------------------------------------------------------

export interface AgentMention {
  /** The reply that mentioned the agent, with the ref and URL of its task or issue. */
  reply: ReplyWithContext;
  parentType: ReplyParentType;
}

/**
 * MCP `wait_for_mentions` (BAT-6), now a deprecated alias of `start_listener`: listens to every
 * project the agent can see with the key's latest session, and hands out only `mention` jobs from
 * replies, which count as delivered (done) at once, as the old mention queue did.
 */
export async function waitForMentions(
  deps: AppDeps,
  actor: Actor,
  input: { timeoutSeconds: number },
  signal?: AbortSignal,
): Promise<{ mentions: AgentMention[]; sessionId: string | null }> {
  const agent = requireListeningAgent(deps, actor);
  const projectIds = visibleProjectIds(deps.db.orm, agent.id);
  if (projectIds.length === 0) return { mentions: [], sessionId: null };
  const latest = deps.db.orm
    .select({ id: s.agentSession.id })
    .from(s.agentSession)
    .where(
      and(
        eq(s.agentSession.agentUserId, agent.id),
        actor.key ? eq(s.agentSession.keyId, actor.key.id) : undefined,
      ),
    )
    .orderBy(desc(s.agentSession.lastSeenAt))
    .get();
  const session = upsertSession(deps, actor, projectIds, latest?.id);
  const rows = await listen(
    deps,
    agent,
    session.id,
    projectIds,
    {
      limit: 50,
      kinds: ['mention'],
      needsTrigger: true,
      deliver: true,
      timeoutSeconds: input.timeoutSeconds,
    },
    signal,
  );
  const mentions: AgentMention[] = [];
  for (const row of rows) {
    if (!row.triggerReplyId || (row.targetType !== 'task' && row.targetType !== 'issue')) continue;
    try {
      mentions.push({
        reply: getReply(deps, actor, row.triggerReplyId),
        parentType: row.targetType,
      });
    } catch {
      // Deleted or hidden since: skip (the job is done either way).
    }
  }
  return { mentions, sessionId: session.id };
}

// ---------------------------------------------------------------------------------------------
// The owner's view: GET /api/me/agent/activity
// ---------------------------------------------------------------------------------------------

const ACTIVITY_JOBS = 20;
const ACTIVITY_SESSIONS = 10;

/** The signed-in person's agent: its listener sessions and latest jobs (Settings → Agent). */
export function getAgentActivity(deps: AppDeps, actor: Actor): AgentActivity {
  if (actor.ownerId) {
    throw errors.forbidden('Only its owner can see an agent’s activity, in the web app');
  }
  const { orm } = deps.db;
  const agentId = findAgentId(orm, actor.userId);
  if (!agentId) return { online: false, sessions: [], jobs: [], pendingCount: 0 };
  const now = Date.now();
  const sessionRows = orm
    .select({
      session: s.agentSession,
      keyName: s.apiKey.name,
      agentName: s.apiKey.agentName,
    })
    .from(s.agentSession)
    .leftJoin(s.apiKey, eq(s.apiKey.id, s.agentSession.keyId))
    .where(eq(s.agentSession.agentUserId, agentId))
    .orderBy(desc(s.agentSession.lastSeenAt))
    .limit(ACTIVITY_SESSIONS)
    .all();
  const jobRows = orm
    .select()
    .from(s.agentJob)
    .where(eq(s.agentJob.agentUserId, agentId))
    .orderBy(desc(s.agentJob.createdAt), desc(s.agentJob.id))
    .limit(ACTIVITY_JOBS)
    .all();
  const projects = projectsById(orm, [
    ...sessionRows.flatMap((row) => row.session.projectIds),
    ...jobRows.map((row) => row.projectId),
  ]);
  const sessions: AgentSession[] = sessionRows.map(({ session, keyName, agentName }) => ({
    id: session.id,
    keyName: keyName ?? null,
    agentName: agentName ?? null,
    projects: session.projectIds.flatMap((id) => {
      const project = projects.get(id);
      return project ? [project] : [];
    }),
    startedAt: session.startedAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    online:
      isSessionListening(deps, session.id) ||
      now - session.lastSeenAt.getTime() < AGENT_LISTENER.sessionTimeoutMs,
  }));
  const jobs: AgentJobSummary[] = jobRows.map((job) => {
    const item = jobItem(orm, job);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      closing: job.closing,
      project: projects.get(job.projectId) ?? null,
      target: {
        type: job.targetType,
        id: job.targetId,
        ref: item?.ref ?? null,
        title: item?.title ?? null,
        url: item?.path ?? null,
      },
      createdAt: job.createdAt.toISOString(),
      claimedAt: job.claimedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  });
  return {
    online: sessions.some((session) => session.online),
    sessions,
    jobs,
    pendingCount: pendingJobCount(orm, agentId),
  };
}
