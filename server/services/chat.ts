import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { CHAT_LIMITS, type ConversationMode } from '@shared/constants';
import type {
  CatchUpRange,
  CatchUpRangeInput,
  CatchUpState,
  CatchUpSummary,
  ChatPage,
  ChatPageQuery,
  ItemParams,
  SetConversationModeInput,
  SubmitCatchUpInput,
} from '@shared/schemas/chat';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { change } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  canViewProject,
  getProjectAccess,
  requireCanEditContent,
  requirePermission,
} from './access';
import { recordActivity } from './activity';
import { jobChanged, queueJobs, requireListeningAgent } from './agentJobs';
import { agentPauseReason, findAgentId } from './agents';
import { emitAfterCommit, emitEvent } from './events';
import { requireItem, type ItemInfo } from './items';
import { listReplyPage } from './replies';
import { getUserSummaries } from './users';

/**
 * Chat conversations on issues and tasks. A chat shows the same replies as the forum view, as a
 * flat stream of messages (answers are quoted inline, not nested). Typing pings are live events
 * only, never stored. Catch up: the viewer's **own** agent summarizes recent messages for them
 * (a `catch_up` job); the summary is stored privately for them (`catch_up_summary`).
 */

const MODE_LABELS: Record<ConversationMode, string> = { chat: 'Chat', forum: 'Forum' };

// ---------------------------------------------------------------------------------------------
// Conversation mode
// ---------------------------------------------------------------------------------------------

/** Switches an item between chat and forum (its author, or `EDIT_ANY_CONTENT`). */
export function setConversationMode(
  deps: AppDeps,
  actor: Actor,
  params: ItemParams,
  input: SetConversationModeInput,
): { mode: ConversationMode } {
  const { item, membership } = requireItem(deps.db.orm, actor, params.type, params.id);
  requireCanEditContent(membership, item.authorId);
  if (item.conversationMode === input.mode) return { mode: item.conversationMode };
  const table = item.type === 'issue' ? s.issue : s.task;
  deps.db.write((tx) => {
    tx.update(table)
      .set({ conversationMode: input.mode, updatedAt: new Date() })
      .where(eq(table.id, item.id))
      .run();
    recordActivity(tx, actor, {
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: item.type,
      entityId: item.id,
      action: `${item.type}.updated`,
      changes: {
        conversation: change(MODE_LABELS[item.conversationMode], MODE_LABELS[input.mode]),
      },
      meta: { ref: item.ref, title: item.title },
    });
    emitAfterCommit(tx, {
      type: item.type === 'issue' ? 'issue.updated' : 'task.updated',
      teamId: item.teamId,
      projectId: item.projectId,
      entityType: item.type,
      entityId: item.id,
      actorId: actor.userId,
    });
  });
  return { mode: input.mode };
}

// ---------------------------------------------------------------------------------------------
// The message stream
// ---------------------------------------------------------------------------------------------

/**
 * The viewer's unread messages in the item: live replies with an unread notification of theirs
 * (reply, mention, …), and the oldest of them.
 */
function unreadMessages(db: DbExecutor, userId: string, item: Pick<ItemInfo, 'type' | 'id'>) {
  const rows = db
    .selectDistinct({ id: s.reply.id, createdAt: s.reply.createdAt })
    .from(s.notification)
    .innerJoin(
      s.reply,
      and(eq(s.notification.entityType, 'reply'), eq(s.reply.id, s.notification.entityId)),
    )
    .where(
      and(
        eq(s.notification.userId, userId),
        isNull(s.notification.readAt),
        eq(s.reply.parentType, item.type),
        eq(s.reply.parentId, item.id),
        isNull(s.reply.deletedAt),
      ),
    )
    .orderBy(asc(s.reply.createdAt), asc(s.reply.id))
    .all();
  return { count: rows.length, firstReplyId: rows[0]?.id ?? null };
}

/** Agent members working on a job about the item right now (catch-up jobs are private). */
function workingAgentIds(db: DbExecutor, item: Pick<ItemInfo, 'type' | 'id'>): string[] {
  return db
    .selectDistinct({ agentUserId: s.agentJob.agentUserId })
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.targetType, item.type),
        eq(s.agentJob.targetId, item.id),
        eq(s.agentJob.status, 'claimed'),
        inArray(s.agentJob.kind, ['mention', 'thread_reply', 'assigned', 'pool', 'approval']),
      ),
    )
    .all()
    .map((row) => row.agentUserId);
}

/**
 * `GET /api/items/:type/:id/chat`: a page of messages (the newest first; `before` continues with
 * older ones), oldest first within the page, with the viewer's unread count as it was before the
 * chat marks them read, and the agents working on the item now.
 */
export function getChatPage(
  deps: AppDeps,
  actor: Actor,
  params: ItemParams,
  query: ChatPageQuery,
): ChatPage {
  const { orm } = deps.db;
  const { item } = requireItem(orm, actor, params.type, params.id);
  const page = listReplyPage(deps, actor, {
    parentType: item.type,
    parentId: item.id,
    limit: query.limit ?? CHAT_LIMITS.pageSize,
    cursor: query.before,
    order: 'desc',
  });
  const agents = getUserSummaries(orm, workingAgentIds(orm, item));
  return {
    items: page.items.reverse(),
    olderCursor: page.nextCursor,
    total: page.total,
    unread: unreadMessages(orm, actor.userId, item),
    workingAgents: [...agents.values()],
  };
}

// ---------------------------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------------------------

/** Last typing ping per person and item (ms), to drop pings that come too fast. */
const lastPing = new Map<string, number>();

/**
 * `POST /api/items/:type/:id/typing`: "X is typing…". Sends an ephemeral `typing` live event
 * (entity: the item, actor: the typist) to the members who can see the item; nothing is stored.
 * Needs `REPLY`. Pings closer together than a second are dropped.
 */
export function sendTyping(
  deps: AppDeps,
  actor: Actor,
  params: ItemParams,
  now: number = Date.now(),
): { ok: true } {
  const { item, membership } = requireItem(deps.db.orm, actor, params.type, params.id);
  requirePermission(membership, 'REPLY', "You don't have permission to reply here");
  const key = `${actor.userId}:${item.type}:${item.id}`;
  const last = lastPing.get(key);
  if (last !== undefined && now - last < CHAT_LIMITS.typingServerThrottleMs) return { ok: true };
  lastPing.set(key, now);
  if (lastPing.size > 5_000) {
    for (const [entry, at] of lastPing) {
      if (now - at > CHAT_LIMITS.typingShowMs) lastPing.delete(entry);
    }
  }
  emitEvent(deps, {
    type: 'typing',
    teamId: item.teamId,
    projectId: item.projectId,
    entityType: item.type,
    entityId: item.id,
    actorId: actor.userId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Catch up
// ---------------------------------------------------------------------------------------------

type SummaryRow = typeof s.catchUpSummary.$inferSelect;
type JobRow = typeof s.agentJob.$inferSelect;

function toRange(value: unknown): CatchUpRange {
  const range = (value ?? {}) as Record<string, unknown>;
  return {
    kind: range.kind === 'unread' ? 'unread' : 'last',
    count: typeof range.count === 'number' ? range.count : 0,
    fromReplyId: typeof range.fromReplyId === 'string' ? range.fromReplyId : null,
    toReplyId: typeof range.toReplyId === 'string' ? range.toReplyId : null,
  };
}

function toSummary(row: SummaryRow): CatchUpSummary {
  return {
    id: row.id,
    itemType: row.itemType,
    itemId: row.itemId,
    range: toRange(row.range),
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Catch up is a person's own request: never through an API key (that acts as an agent). */
function requirePerson(actor: Actor): void {
  if (actor.ownerId || actor.key) {
    throw errors.forbidden('Catch up is for people in the app: ask for it in Baton');
  }
}

/** The item a catch-up job is about (`payload.itemType` / `itemId`). */
function catchUpItemOf(
  job: Pick<JobRow, 'payload'>,
): { type: 'issue' | 'task'; id: string } | null {
  const { itemType, itemId } = job.payload;
  if ((itemType !== 'issue' && itemType !== 'task') || typeof itemId !== 'string') return null;
  return { type: itemType, id: itemId };
}

/** The viewer's open catch-up job about the item (waiting or running), if any. */
function openCatchUpJob(db: DbExecutor, agentId: string, item: ItemInfo): JobRow | undefined {
  return db
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, agentId),
        eq(s.agentJob.kind, 'catch_up'),
        inArray(s.agentJob.status, ['pending', 'claimed']),
      ),
    )
    .orderBy(desc(s.agentJob.createdAt))
    .all()
    .find((job) => {
      const target = catchUpItemOf(job);
      return target?.type === item.type && target.id === item.id;
    });
}

/** `GET /api/items/:type/:id/catch-up`: the viewer's own summaries of the item and open job. */
export function getCatchUp(deps: AppDeps, actor: Actor, params: ItemParams): CatchUpState {
  requirePerson(actor);
  const { orm } = deps.db;
  const { item } = requireItem(orm, actor, params.type, params.id);
  const summaries = orm
    .select()
    .from(s.catchUpSummary)
    .where(
      and(
        eq(s.catchUpSummary.userId, actor.userId),
        eq(s.catchUpSummary.itemType, item.type),
        eq(s.catchUpSummary.itemId, item.id),
      ),
    )
    .orderBy(desc(s.catchUpSummary.createdAt), desc(s.catchUpSummary.id))
    .limit(CHAT_LIMITS.catchUpShown)
    .all();
  const agentId = findAgentId(orm, actor.userId);
  const job = agentId ? openCatchUpJob(orm, agentId, item) : undefined;
  return {
    summaries: summaries.map(toSummary),
    job: job
      ? {
          id: job.id,
          status: job.status,
          range: toRange(job.payload.range),
          createdAt: job.createdAt.toISOString(),
        }
      : null,
    hasAgent: agentId !== null,
  };
}

/** The live messages a range covers, oldest first (at most `catchUpMaxMessages`). */
function rangeMessages(
  db: DbExecutor,
  item: Pick<ItemInfo, 'type' | 'id'>,
  range: CatchUpRangeInput,
): Array<typeof s.reply.$inferSelect> {
  const thread = and(
    eq(s.reply.parentType, item.type),
    eq(s.reply.parentId, item.id),
    isNull(s.reply.deletedAt),
  );
  let since = undefined;
  if (range.kind === 'unread') {
    const first = db
      .select({ createdAt: s.reply.createdAt, id: s.reply.id })
      .from(s.reply)
      .where(and(thread, eq(s.reply.id, range.sinceReplyId)))
      .get();
    if (!first) {
      throw errors.validation('That message is not in this chat any more', {
        field: 'sinceReplyId',
      });
    }
    since = or(
      gte(s.reply.createdAt, new Date(first.createdAt.getTime() + 1)),
      and(eq(s.reply.createdAt, first.createdAt), gte(s.reply.id, first.id)),
    );
  }
  const limit = range.kind === 'last' ? range.count : CHAT_LIMITS.catchUpMaxMessages;
  return db
    .select()
    .from(s.reply)
    .where(and(thread, since))
    .orderBy(desc(s.reply.createdAt), desc(s.reply.id))
    .limit(limit)
    .all()
    .reverse();
}

/**
 * `POST /api/items/:type/:id/catch-up`: asks the viewer's **own** agent to summarize a range of
 * the chat for them (a `catch_up` job, which never waits for an OK: it is the owner's request).
 * There is no way to name another agent. Fails clearly when the viewer has no agent, it is
 * paused, or it can't see the project.
 */
export function requestCatchUp(
  deps: AppDeps,
  actor: Actor,
  params: ItemParams,
  range: CatchUpRangeInput,
): CatchUpState {
  requirePerson(actor);
  const { orm } = deps.db;
  const { item } = requireItem(orm, actor, params.type, params.id);
  const agentId = findAgentId(orm, actor.userId);
  if (!agentId) throw errors.conflict('You don’t have an agent yet');
  const paused = agentPauseReason(
    orm,
    { agentId, ownerId: actor.userId },
    item.teamId,
    item.projectId,
  );
  if (paused) throw errors.agentsPaused(paused);
  const access = getProjectAccess(orm, agentId, item.projectId);
  if (!access || !canViewProject(access)) {
    throw errors.conflict('Your agent can’t see this project: give it access first');
  }
  const messages = rangeMessages(orm, item, range);
  if (messages.length === 0) throw errors.conflict('There are no messages to summarize');
  const resolved: CatchUpRange = {
    kind: range.kind,
    count: messages.length,
    fromReplyId: messages[0]?.id ?? null,
    toReplyId: messages.at(-1)?.id ?? null,
  };
  const open = openCatchUpJob(orm, agentId, item);
  if (open?.status === 'claimed') {
    throw errors.conflict('Your agent is already catching you up here: the summary is on its way');
  }
  deps.db.write((tx) => {
    // A waiting request is replaced by the new range.
    if (open) {
      tx.update(s.agentJob)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(and(eq(s.agentJob.id, open.id), eq(s.agentJob.status, 'pending')))
        .run();
    }
    // The job targets the range's latest message (a reply of the item), not the item itself: a
    // desktop runner hands jobs about an item it is already working on to that running session,
    // and a catch-up must run on its own.
    const [jobId] = queueJobs(tx, [
      {
        agentUserId: agentId,
        teamId: item.teamId,
        projectId: item.projectId,
        kind: 'catch_up',
        targetType: 'reply',
        targetId: resolved.toReplyId ?? item.id,
        payload: { itemType: item.type, itemId: item.id, range: resolved },
        triggeredById: actor.userId,
      },
    ]);
    if (!jobId) throw errors.conflict('Your agent can’t take jobs here right now');
    // The owner's own request never waits for their OK, whatever their job sources say.
    tx.update(s.agentJob)
      .set({ needsOk: false })
      .where(and(eq(s.agentJob.id, jobId), eq(s.agentJob.agentUserId, agentId)))
      .run();
  });
  return getCatchUp(deps, actor, params);
}

/**
 * MCP `submit_catch_up`: the agent hands in the summary of its own `catch_up` job. Stored for the
 * job's owner only, and the job is done. Only the agent the job belongs to can submit it.
 */
export function submitCatchUp(
  deps: AppDeps,
  actor: Actor,
  input: SubmitCatchUpInput,
): { ok: true; summaryId: string } {
  const agent = requireListeningAgent(deps, actor);
  const { orm } = deps.db;
  const job = orm.select().from(s.agentJob).where(eq(s.agentJob.id, input.jobId)).get();
  if (job?.agentUserId !== agent.id) throw errors.notFound('Job');
  if (job.kind !== 'catch_up') {
    throw errors.validation('submit_catch_up is only for catch_up jobs', { field: 'jobId' });
  }
  if (job.status === 'cancelled') throw errors.conflict('This job was cancelled');
  if (job.status === 'done') throw errors.conflict('This catch-up was already submitted');
  const target = catchUpItemOf(job);
  if (!target) throw errors.notFound('Job');
  const summaryId = newId();
  deps.db.write((tx) => {
    const now = new Date();
    tx.insert(s.catchUpSummary)
      .values({
        id: summaryId,
        userId: agent.ownerId,
        projectId: job.projectId,
        itemType: target.type,
        itemId: target.id,
        jobId: job.id,
        range: toRange(job.payload.range),
        summary: input.summary,
        createdAt: now,
      })
      .run();
    tx.update(s.agentJob)
      .set({ status: 'done', completedAt: now })
      .where(eq(s.agentJob.id, job.id))
      .run();
    // Personal to the owner: their panel refreshes and shows the summary.
    jobChanged(tx, job, agent.ownerId);
  });
  return { ok: true, summaryId };
}

// ---------------------------------------------------------------------------------------------
// The catch-up job's brief (desktop runner)
// ---------------------------------------------------------------------------------------------

/** The messages of a catch-up job, for its brief (oldest first, at most 100). */
export function catchUpBriefMessages(
  db: DbExecutor,
  job: Pick<JobRow, 'payload'>,
): Array<{ id: string; author: string; body: string; createdAt: Date; files: string[] }> {
  const item = catchUpItemOf(job);
  if (!item) return [];
  const range = toRange(job.payload.range);
  if (!range.fromReplyId || !range.toReplyId) return [];
  const bounds = db
    .select({ id: s.reply.id, createdAt: s.reply.createdAt })
    .from(s.reply)
    .where(inArray(s.reply.id, [range.fromReplyId, range.toReplyId]))
    .all();
  const from = bounds.find((row) => row.id === range.fromReplyId);
  const to = bounds.find((row) => row.id === range.toReplyId);
  if (!from || !to) return [];
  const rows = db
    .select()
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, item.type),
        eq(s.reply.parentId, item.id),
        isNull(s.reply.deletedAt),
        gte(s.reply.createdAt, from.createdAt),
        lte(s.reply.createdAt, to.createdAt),
      ),
    )
    .orderBy(asc(s.reply.createdAt), asc(s.reply.id))
    .limit(CHAT_LIMITS.catchUpMaxMessages)
    .all();
  const authors = getUserSummaries(
    db,
    rows.map((row) => row.authorId),
  );
  const files = new Map<string, string[]>();
  if (rows.length > 0) {
    for (const file of db
      .select({ parentId: s.attachment.parentId, filename: s.attachment.filename })
      .from(s.attachment)
      .where(
        and(
          eq(s.attachment.parentType, 'reply'),
          inArray(
            s.attachment.parentId,
            rows.map((row) => row.id),
          ),
          isNull(s.attachment.deletedAt),
        ),
      )
      .all()) {
      if (!file.parentId) continue;
      files.set(file.parentId, [...(files.get(file.parentId) ?? []), file.filename]);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    author: row.authorId
      ? `@${authors.get(row.authorId)?.username ?? 'someone'}`
      : 'a former member',
    body: row.body,
    createdAt: row.createdAt,
    files: files.get(row.id) ?? [],
  }));
}

function quoteLines(text: string): string {
  return (text.trim() || '_(no text)_')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** The prompt of a `catch_up` job for a desktop runner: the messages and how to hand it in. */
export function catchUpPrompt(input: {
  me: string;
  owner: string;
  ref: string;
  title: string | null;
  url: string | null;
  jobId: string;
  instructions: string;
  messages: ReturnType<typeof catchUpBriefMessages>;
}): string {
  const { me, owner, ref, messages } = input;
  const transcript =
    messages.length > 0
      ? messages
          .map(
            (message) =>
              `**${message.author}** (${message.createdAt.toISOString()}, id \`${message.id}\`)${
                message.files.length > 0 ? ` — files: ${message.files.join(', ')}` : ''
              }:\n${quoteLines(message.body)}`,
          )
          .join('\n\n')
      : '_The messages are gone (deleted). Say so in the summary._';
  return [
    `# Baton job: catch up on ${ref}${input.title ? ` — ${input.title}` : ''}`,
    `You are **@${me}**, the Baton agent of **@${owner}**, running headless on their machine for this one job. @${owner} has unread messages in the chat of ${ref}${input.url ? ` (${input.url})` : ''} and asked you to catch them up.`,
    `## The job\n\n${input.instructions}\n\nJob id: \`${input.jobId}\`.`,
    `## The messages (oldest first, ${messages.length})\n\n${transcript}`,
    [
      '## Rules',
      `- Write for @${owner}: a few short paragraphs or bullets, most important first. Name people (@username) and quote exact asks briefly. Mention what needs @${owner}.`,
      '- Only summarize: do not post in the chat (no add_reply), do not change the task or issue, do not run commands.',
      `- Hand it in with submit_catch_up { jobId: "${input.jobId}", summary } (it completes the job). If you can't, call release_job { jobId: "${input.jobId}" }.`,
    ].join('\n'),
  ].join('\n\n');
}
