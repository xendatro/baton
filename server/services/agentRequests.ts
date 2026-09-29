import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  approveAgentRequestInputSchema,
  declineAgentRequestInputSchema,
  DECLINED_REQUESTS_SHOWN_MS,
  type AgentRequest,
  type AgentRequestStatus,
  type ApproveAgentRequestInput,
  type BulkAgentRequestsInput,
  type DeclineAgentRequestInput,
  type ItemAgentRequests,
  type ItemAgentRequestStatus,
} from '@shared/schemas/agentAccess';
import type { UserSummary } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { appPaths } from '../lib/urls';
import { requireProjectAccess } from './access';
import { recordActivity } from './activity';
import { jobChanged, jobItem } from './agentJobs';
import { mappedChain } from './agentRunner';
import { findAgentId, personActor } from './agents';
import { emitAfterCommit } from './events';
import { findItem, type ItemInfo } from './items';
import { notifyUsers } from './notifications';
import { getUserSummaries } from './users';

/**
 * Requests (agent access): a job caused by someone who may only *ask* waits for the agent's
 * owner as a request (`needs_ok`, not held). The owner gets an `agent_request` notification and
 * sees it on the Requests page as a card: who asked, what the agent would do, the message, and
 * Approve (with "Run with": a model that overrides their mappings for that job) or Decline (with
 * an optional reason the requester sees on the item). Anything that settles a request (approved,
 * declined, cleared because its item finished, cancelled) marks its notification read.
 */

type JobRow = typeof s.agentJob.$inferSelect;

/** A request (not a stopped run) that still waits for its owner. */
export function isOpenRequest(job: Pick<JobRow, 'status' | 'needsOk' | 'heldAt'>): boolean {
  return job.status === 'pending' && job.needsOk && job.heldAt === null;
}

// ---------------------------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------------------------

interface Wording {
  question: string;
  summary: string;
}

function stageOfJob(job: Pick<JobRow, 'payload'>): string | null {
  return typeof job.payload.stage === 'string' ? job.payload.stage : null;
}

/** "Can I reply to Caden’s message here?" and "Reply to Caden’s message on BAT-40". */
export function requestWording(
  job: Pick<JobRow, 'kind' | 'payload'>,
  requesterName: string | null,
  ref: string | null,
): Wording {
  const who = requesterName ?? 'Someone';
  const whose = requesterName ? `${requesterName}’s` : 'a';
  const on = ref ?? 'the item';
  const stage = stageOfJob(job);
  const into = stage ? ` into ${stage}` : '';
  switch (job.kind) {
    case 'mention':
      return {
        question: `Can I reply to ${whose} message here?`,
        summary: `Reply to ${whose} message on ${on}`,
      };
    case 'thread_reply':
      return {
        question: `Can I answer ${whose} reply here?`,
        summary: `Answer ${whose} reply on ${on}`,
      };
    case 'assigned':
      return typeof job.payload.returnReason === 'string'
        ? {
            question: `Can I pick ${on} up again? ${who} sent it back${into}.`,
            summary: `Pick up ${on} again (sent back${into})`,
          }
        : {
            question: `Can I start ${on}? ${who} assigned it to me.`,
            summary: `Start ${on} as ${who} asked`,
          };
    case 'pool':
      return {
        question: `Can I pick up ${on}? ${who} moved it${into}, where I may take it.`,
        summary: `Pick up ${on} from the pool${stage ? ` (${stage})` : ''}`,
      };
    case 'approval':
      return {
        question: `Can I review ${on}? ${who} moved it${into}, which needs approval.`,
        summary: `Review ${on} for approval`,
      };
    case 'action_result':
      return { question: `Can I carry on with ${on}?`, summary: `Carry on with ${on}` };
    case 'catch_up':
      // Only ever the owner's own request, so it never waits for an OK; worded for completeness.
      return {
        question: `Can I summarize the recent messages on ${on}?`,
        summary: `Summarize recent messages on ${on}`,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Notifications (inside the caller's transaction)
// ---------------------------------------------------------------------------------------------

/** Notifies the owner of a new request (called by `queueJobs`). */
export function notifyAgentRequest(tx: Tx, job: JobRow, ownerId: string): void {
  const item = jobItem(tx, job);
  const names = getUserSummaries(tx, [job.triggeredById, job.agentUserId]);
  const requester = job.triggeredById ? names.get(job.triggeredById) : undefined;
  const wording = requestWording(job, requester?.name ?? null, item?.ref ?? null);
  const trigger = job.triggerReplyId
    ? tx
        .select({ body: s.reply.body })
        .from(s.reply)
        .where(eq(s.reply.id, job.triggerReplyId))
        .get()
    : undefined;
  const actor: Actor | null = job.triggeredById
    ? { userId: job.triggeredById, source: 'web', key: null }
    : null;
  notifyUsers(tx, actor, 'agent_request', [ownerId], {
    teamId: job.teamId,
    entityType: 'agent_job',
    entityId: job.id,
    title: `${names.get(job.agentUserId)?.name ?? 'Your agent'}: ${wording.question}`,
    snippet: trigger?.body ?? item?.title ?? '',
    url: '/agent/requests',
  });
}

/** Marks the `agent_request` notifications of these jobs read (they were settled). */
export function clearRequestNotifications(tx: Tx, jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  const about = and(
    eq(s.notification.type, 'agent_request'),
    eq(s.notification.entityType, 'agent_job'),
    inArray(s.notification.entityId, [...jobIds]),
    isNull(s.notification.readAt),
  );
  const rows = tx
    .select({ userId: s.notification.userId, teamId: s.notification.teamId })
    .from(s.notification)
    .where(about)
    .all();
  if (rows.length === 0) return;
  tx.update(s.notification).set({ readAt: new Date() }).where(about).run();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.userId}:${row.teamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitAfterCommit(tx, {
      type: 'notification.read',
      teamId: row.teamId,
      projectId: null,
      entityType: 'notification',
      entityId: row.teamId,
      parentType: null,
      parentId: null,
      actorId: null,
      userId: row.userId,
    });
  }
}

/**
 * Someone who can't start the owner's agent mentioned or assigned it: nothing is queued, and a
 * system note on the item says so ("@ethan-ai doesn't take requests from @caden"). Other kinds
 * (thread replies, stage hand-offs) are skipped silently.
 */
export function refuseJob(
  tx: Tx,
  agent: { id: string; ownerId: string },
  job: { kind: string; targetType: string; targetId: string; triggeredById?: string | null },
): void {
  if (job.kind !== 'mention' && job.kind !== 'assigned') return;
  if (job.targetType !== 'task' && job.targetType !== 'issue') return;
  const item = findItem(tx, job.targetType, job.targetId);
  if (!item || !job.triggeredById) return;
  const names = getUserSummaries(tx, [agent.id, agent.ownerId, job.triggeredById]);
  recordActivity(tx, null, {
    teamId: item.teamId,
    projectId: item.projectId,
    entityType: item.type,
    entityId: item.id,
    action: `${item.type}.agent_request_refused`,
    meta: {
      ref: item.ref,
      title: item.title,
      agent: names.get(agent.id)?.username ?? null,
      owner: names.get(agent.ownerId)?.username ?? null,
      requester: names.get(job.triggeredById)?.username ?? null,
      kind: job.kind,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The owner's view: GET /api/me/agent/requests
// ---------------------------------------------------------------------------------------------

interface Owner {
  ownerId: string;
  agentId: string | null;
}

function requireRequestOwner(deps: AppDeps, actor: Actor): Owner {
  const person = personActor(actor);
  const user = deps.db.orm
    .select({ kind: s.user.kind })
    .from(s.user)
    .where(eq(s.user.id, person.userId))
    .get();
  if (user?.kind !== 'human') throw errors.forbidden('Only people have agent requests');
  return { ownerId: person.userId, agentId: findAgentId(deps.db.orm, person.userId) };
}

/** Requests are jobs that waited for the owner: open ones, and settled ones (not stopped runs). */
const isRequestRow = and(
  isNull(s.agentJob.heldAt),
  or(
    and(eq(s.agentJob.status, 'pending'), eq(s.agentJob.needsOk, true)),
    isNotNull(s.agentJob.requestDecision),
    and(isNotNull(s.agentJob.clearedAt), isNotNull(s.agentJob.triggeredById)),
  ),
);

function statusOf(job: JobRow): AgentRequestStatus {
  if (job.requestDecision) return job.requestDecision;
  if (job.clearedAt || job.status === 'cancelled') return 'cleared';
  return 'pending';
}

function person(summary: UserSummary | undefined, fallback: string) {
  return summary
    ? { id: summary.id, username: summary.username, name: summary.name }
    : { id: '', username: null, name: fallback };
}

function toRequests(db: DbExecutor, rows: readonly JobRow[], ownerId: string): AgentRequest[] {
  if (rows.length === 0) return [];
  const users = getUserSummaries(db, [
    ownerId,
    ...rows.flatMap((row) => [row.agentUserId, row.triggeredById]),
  ]);
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const projects = new Map(
    db
      .select({ id: s.project.id, key: s.project.key, name: s.project.name, slug: s.team.slug })
      .from(s.project)
      .innerJoin(s.team, eq(s.team.id, s.project.teamId))
      .where(inArray(s.project.id, projectIds))
      .all()
      .map((row) => [row.id, { id: row.id, ref: `${row.slug}/${row.key}`, name: row.name }]),
  );
  const replyIds = rows.flatMap((row) => (row.triggerReplyId ? [row.triggerReplyId] : []));
  const replies = new Map(
    (replyIds.length === 0
      ? []
      : db
          .select({ id: s.reply.id, body: s.reply.body })
          .from(s.reply)
          .where(and(inArray(s.reply.id, replyIds), isNull(s.reply.deletedAt)))
          .all()
    ).map((row) => [row.id, row]),
  );
  return rows.map((job) => {
    const item: ItemInfo | null = jobItem(db, job);
    const requester = job.triggeredById ? (users.get(job.triggeredById) ?? null) : null;
    const wording = requestWording(job, requester?.name ?? null, item?.ref ?? null);
    const reply = job.triggerReplyId ? replies.get(job.triggerReplyId) : undefined;
    const { resolved } = mappedChain(db, ownerId, job);
    return {
      jobId: job.id,
      kind: job.kind,
      status: statusOf(job),
      agent: person(users.get(job.agentUserId), 'Your agent'),
      owner: person(users.get(ownerId), 'You'),
      requester,
      question: wording.question,
      summary: wording.summary,
      project: projects.get(job.projectId) ?? null,
      target: {
        type: item?.type ?? null,
        id: item?.id ?? null,
        ref: item?.ref ?? null,
        title: item?.title ?? null,
        path: item?.path ?? null,
      },
      message: reply
        ? {
            replyId: reply.id,
            body: reply.body,
            path: item ? appPaths.reply(item.path, reply.id) : null,
          }
        : null,
      stage: stageOfJob(job),
      suggestedChain: resolved.chain,
      suggestedSource: resolved.source,
      createdAt: job.createdAt.toISOString(),
      decidedAt: (job.requestDecidedAt ?? job.clearedAt)?.toISOString() ?? null,
      reason: job.requestReason ?? null,
      modelOverride: job.modelOverride ?? null,
    };
  });
}

/**
 * The owner's requests: every open one (oldest first), then those settled in the last day
 * (newest first) under "Recently decided".
 */
export function listAgentRequests(deps: AppDeps, actor: Actor): { requests: AgentRequest[] } {
  const owner = requireRequestOwner(deps, actor);
  if (!owner.agentId) return { requests: [] };
  const { orm } = deps.db;
  const open = orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, owner.agentId),
        eq(s.agentJob.status, 'pending'),
        eq(s.agentJob.needsOk, true),
        isNull(s.agentJob.heldAt),
      ),
    )
    .orderBy(asc(s.agentJob.createdAt), asc(s.agentJob.id))
    .all();
  const since = new Date(Date.now() - DECLINED_REQUESTS_SHOWN_MS);
  const settled = orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, owner.agentId),
        isRequestRow,
        or(gte(s.agentJob.requestDecidedAt, since), gte(s.agentJob.clearedAt, since)),
      ),
    )
    .orderBy(desc(s.agentJob.createdAt), desc(s.agentJob.id))
    .limit(50)
    .all()
    .filter((row) => !isOpenRequest(row));
  return { requests: toRequests(orm, [...open, ...settled], owner.ownerId) };
}

function requireOwnersRequest(deps: AppDeps, owner: Owner, jobId: string): JobRow {
  const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  if (!job || !owner.agentId || job.agentUserId !== owner.agentId || job.heldAt) {
    throw errors.notFound('Request');
  }
  return job;
}

function oneRequest(deps: AppDeps, owner: Owner, jobId: string): AgentRequest {
  const [request] = toRequests(
    deps.db.orm,
    [requireOwnersRequest(deps, owner, jobId)],
    owner.ownerId,
  );
  if (!request) throw errors.notFound('Request');
  return request;
}

function settledError(job: JobRow): never {
  if (job.requestDecision === 'approved' || (job.status !== 'pending' && !job.needsOk)) {
    throw errors.conflict('This request was already approved');
  }
  if (job.requestDecision === 'declined') throw errors.conflict('This request was declined');
  throw errors.conflict('This request is no longer open: its task or issue moved on');
}

/**
 * Approve: the job runs like any other. `model` ("Run with") becomes the job's model override,
 * which its brief uses instead of the owner's mappings; without it the mappings decide.
 */
export function approveAgentRequest(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  rawInput: ApproveAgentRequestInput = {},
): AgentRequest {
  const input = approveAgentRequestInputSchema.parse(rawInput);
  const owner = requireRequestOwner(deps, actor);
  const job = requireOwnersRequest(deps, owner, jobId);
  if (!isOpenRequest(job)) settledError(job);
  deps.db.write((tx) => {
    tx.update(s.agentJob)
      .set({
        needsOk: false,
        requestDecision: 'approved',
        requestDecidedAt: new Date(),
        modelOverride: input.model ? [input.model] : null,
      })
      .where(and(eq(s.agentJob.id, job.id), eq(s.agentJob.status, 'pending')))
      .run();
    clearRequestNotifications(tx, [job.id]);
    jobChanged(tx, job, owner.ownerId);
  });
  return oneRequest(deps, owner, job.id);
}

/**
 * Decline: the job is cancelled. The item's history gets "Ethan declined @caden's request" with
 * the reason, which the requester sees there (and on the item's request status).
 */
export function declineAgentRequest(
  deps: AppDeps,
  actor: Actor,
  jobId: string,
  rawInput: DeclineAgentRequestInput = {},
): AgentRequest {
  const input = declineAgentRequestInputSchema.parse(rawInput);
  const owner = requireRequestOwner(deps, actor);
  const job = requireOwnersRequest(deps, owner, jobId);
  if (!isOpenRequest(job)) settledError(job);
  const reason = input.reason?.trim() || null;
  deps.db.write((tx) => {
    const now = new Date();
    tx.update(s.agentJob)
      .set({
        status: 'cancelled',
        completedAt: now,
        requestDecision: 'declined',
        requestDecidedAt: now,
        requestReason: reason,
      })
      .where(and(eq(s.agentJob.id, job.id), eq(s.agentJob.status, 'pending')))
      .run();
    clearRequestNotifications(tx, [job.id]);
    const item = jobItem(tx, job);
    if (item) {
      const names = getUserSummaries(tx, [job.agentUserId, job.triggeredById]);
      recordActivity(tx, personActor(actor), {
        teamId: item.teamId,
        projectId: item.projectId,
        entityType: item.type,
        entityId: item.id,
        action: `${item.type}.agent_request_declined`,
        meta: {
          ref: item.ref,
          title: item.title,
          agent: names.get(job.agentUserId)?.username ?? null,
          requester: job.triggeredById ? (names.get(job.triggeredById)?.username ?? null) : null,
          kind: job.kind,
          reason,
        },
      });
    }
    jobChanged(tx, job, owner.ownerId);
  });
  return oneRequest(deps, owner, job.id);
}

/** Approve or decline several open requests at once (settled ones are skipped). */
export function decideAgentRequests(
  deps: AppDeps,
  actor: Actor,
  input: BulkAgentRequestsInput,
): { requests: AgentRequest[]; skipped: string[] } {
  const owner = requireRequestOwner(deps, actor);
  const requests: AgentRequest[] = [];
  const skipped: string[] = [];
  for (const jobId of new Set(input.jobIds)) {
    const job = deps.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
    if (!job || job.agentUserId !== owner.agentId || !isOpenRequest(job)) {
      skipped.push(jobId);
      continue;
    }
    requests.push(
      input.decision === 'approve'
        ? approveAgentRequest(deps, actor, jobId)
        : declineAgentRequest(deps, actor, jobId, { reason: input.reason }),
    );
  }
  return { requests, skipped };
}

// ---------------------------------------------------------------------------------------------
// On an item: GET /api/agent-requests?itemType=&itemId=
// ---------------------------------------------------------------------------------------------

/** Target conditions for the jobs about an item: the item itself (reply jobs target it too). */
function aboutItem(item: { type: 'task' | 'issue'; id: string }) {
  return and(eq(s.agentJob.targetType, item.type), eq(s.agentJob.targetId, item.id));
}

/**
 * Requests about one task or issue. `mine`: the viewer's own agent's (full cards, for inline
 * Approve / Decline in a conversation). `waiting`: everyone's open requests ("waiting for Ethan's
 * OK") plus those declined in the last day, whose reason only the requester and the owner see.
 */
export function itemAgentRequests(
  deps: AppDeps,
  actor: Actor,
  query: { itemType: 'task' | 'issue'; itemId: string },
): ItemAgentRequests {
  const { orm } = deps.db;
  const item = findItem(orm, query.itemType, query.itemId);
  if (!item) throw errors.notFound(query.itemType === 'task' ? 'Task' : 'Issue');
  const viewer = personActor(actor);
  requireProjectAccess(orm, viewer, item.projectId, query.itemType === 'task' ? 'Task' : 'Issue');
  const since = new Date(Date.now() - DECLINED_REQUESTS_SHOWN_MS);
  const rows = orm
    .select()
    .from(s.agentJob)
    .where(
      and(
        aboutItem(item),
        isNull(s.agentJob.heldAt),
        or(
          and(eq(s.agentJob.status, 'pending'), eq(s.agentJob.needsOk, true)),
          and(eq(s.agentJob.requestDecision, 'declined'), gte(s.agentJob.requestDecidedAt, since)),
        ),
      ),
    )
    .orderBy(asc(s.agentJob.createdAt), asc(s.agentJob.id))
    .all();
  const agents = new Map(
    (rows.length === 0
      ? []
      : orm
          .select({ id: s.user.id, ownerId: s.user.agentOwnerId })
          .from(s.user)
          .where(
            inArray(
              s.user.id,
              rows.map((row) => row.agentUserId),
            ),
          )
          .all()
    ).map((row) => [row.id, row.ownerId]),
  );
  const users = getUserSummaries(orm, [
    ...rows.flatMap((row) => [row.agentUserId, row.triggeredById]),
    ...agents.values(),
  ]);
  const ownAgentId = findAgentId(orm, viewer.userId);
  const waiting: ItemAgentRequestStatus[] = rows.map((job) => {
    const ownerId = agents.get(job.agentUserId) ?? null;
    const requester = job.triggeredById ? users.get(job.triggeredById) : undefined;
    const sees = viewer.userId === ownerId || viewer.userId === job.triggeredById;
    return {
      jobId: job.id,
      status: job.requestDecision === 'declined' ? 'declined' : 'pending',
      agent: person(users.get(job.agentUserId), 'An agent'),
      owner: person(ownerId ? users.get(ownerId) : undefined, 'its owner'),
      requester: requester ? person(requester, '') : null,
      summary: requestWording(job, requester?.name ?? null, item.ref).summary,
      createdAt: job.createdAt.toISOString(),
      decidedAt: job.requestDecidedAt?.toISOString() ?? null,
      reason: sees ? (job.requestReason ?? null) : null,
    };
  });
  const mine = ownAgentId
    ? toRequests(
        orm,
        rows.filter((row) => row.agentUserId === ownAgentId && isOpenRequest(row)),
        viewer.userId,
      )
    : [];
  return { mine, waiting };
}

/** For MCP `get_task` / `get_issue`: whose agents wait for their owner's OK on this item. */
export function pendingRequestsOn(
  db: DbExecutor,
  item: { type: 'task' | 'issue'; id: string },
): Array<{ agent: string | null; owner: string | null; requester: string | null; kind: string }> {
  const rows = db
    .select({
      agentUserId: s.agentJob.agentUserId,
      triggeredById: s.agentJob.triggeredById,
      kind: s.agentJob.kind,
    })
    .from(s.agentJob)
    .where(
      and(
        aboutItem(item),
        eq(s.agentJob.status, 'pending'),
        eq(s.agentJob.needsOk, true),
        isNull(s.agentJob.heldAt),
      ),
    )
    .all();
  if (rows.length === 0) return [];
  const owners = new Map(
    db
      .select({ id: s.user.id, ownerId: s.user.agentOwnerId })
      .from(s.user)
      .where(
        inArray(
          s.user.id,
          rows.map((row) => row.agentUserId),
        ),
      )
      .all()
      .map((row) => [row.id, row.ownerId]),
  );
  const users = getUserSummaries(db, [
    ...rows.flatMap((row) => [row.agentUserId, row.triggeredById]),
    ...owners.values(),
  ]);
  return rows.map((row) => {
    const ownerId = owners.get(row.agentUserId);
    return {
      agent: users.get(row.agentUserId)?.username ?? null,
      owner: ownerId ? (users.get(ownerId)?.username ?? null) : null,
      requester: row.triggeredById ? (users.get(row.triggeredById)?.username ?? null) : null,
      kind: row.kind,
    };
  });
}
