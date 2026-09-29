import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { CHAT_LIMITS } from '@shared/constants';
import type {
  ItemParams,
  RequestTaskDraftInput,
  SubmitTaskDraftInput,
  TaskDraftState,
} from '@shared/schemas/chat';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { appPaths } from '../lib/urls';
import { canViewProject, getProjectAccess } from './access';
import { jobChanged, queueJobs, requireListeningAgent } from './agentJobs';
import { agentPauseReason, findAgentId } from './agents';
import { findItem, requireItem, type ItemInfo } from './items';
import { getUserSummaries } from './users';

/**
 * "Have my agent draft it" (Make task from this): the viewer's **own** agent turns an issue or
 * chosen chat messages into a task title and description (a `draft_task` job). The agent hands
 * the draft in with MCP `submit_task_draft`; it is kept on the job (`payload.draft`), shown only
 * to the person who asked, in their New task form, and never creates the task by itself.
 */

type JobRow = typeof s.agentJob.$inferSelect;

/** Messages of the item a draft without chosen messages reads (its latest ones). */
const ITEM_MESSAGES = 30;

/** Drafts are a person's own request: never through an API key (that acts as an agent). */
function requirePerson(actor: Actor): void {
  if (actor.ownerId || actor.key) {
    throw errors.forbidden('Task drafts are for people in the app: ask for one in Baton');
  }
}

interface DraftSource {
  item: { type: 'issue' | 'task'; id: string };
  replyIds: string[];
}

/** The item and messages a `draft_task` job is about (`payload.itemType` / `itemId` / `replyIds`). */
export function draftSourceOf(job: Pick<JobRow, 'payload'>): DraftSource | null {
  const { itemType, itemId, replyIds } = job.payload;
  if ((itemType !== 'issue' && itemType !== 'task') || typeof itemId !== 'string') return null;
  return {
    item: { type: itemType, id: itemId },
    replyIds: Array.isArray(replyIds)
      ? replyIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function draftOf(job: Pick<JobRow, 'payload'>): { title: string; description: string } | null {
  const draft = job.payload.draft as { title?: unknown; description?: unknown } | undefined;
  if (typeof draft?.title !== 'string' || typeof draft.description !== 'string') return null;
  return { title: draft.title, description: draft.description };
}

function toState(job: JobRow): TaskDraftState {
  const source = draftSourceOf(job);
  return {
    jobId: job.id,
    status: job.status,
    itemType: source?.item.type ?? 'task',
    itemId: source?.item.id ?? '',
    replyIds: source?.replyIds ?? [],
    draft: draftOf(job),
    createdAt: job.createdAt.toISOString(),
  };
}

/** Live replies of the item, in order (the chosen ones, or its latest `ITEM_MESSAGES`). */
function sourceReplies(
  db: DbExecutor,
  item: Pick<ItemInfo, 'type' | 'id'>,
  replyIds: readonly string[],
): Array<typeof s.reply.$inferSelect> {
  const thread = and(
    eq(s.reply.parentType, item.type),
    eq(s.reply.parentId, item.id),
    isNull(s.reply.deletedAt),
  );
  if (replyIds.length > 0) {
    return db
      .select()
      .from(s.reply)
      .where(and(thread, inArray(s.reply.id, [...replyIds])))
      .orderBy(asc(s.reply.createdAt), asc(s.reply.id))
      .all();
  }
  return db
    .select()
    .from(s.reply)
    .where(thread)
    .orderBy(desc(s.reply.createdAt), desc(s.reply.id))
    .limit(ITEM_MESSAGES)
    .all()
    .reverse();
}

/** The viewer's open draft job about the same item and messages (waiting or running), if any. */
function openDraftJob(db: DbExecutor, agentId: string, source: DraftSource): JobRow | undefined {
  const key = [...source.replyIds].sort().join(',');
  return db
    .select()
    .from(s.agentJob)
    .where(
      and(
        eq(s.agentJob.agentUserId, agentId),
        eq(s.agentJob.kind, 'draft_task'),
        inArray(s.agentJob.status, ['pending', 'claimed']),
      ),
    )
    .all()
    .find((job) => {
      const other = draftSourceOf(job);
      return (
        other?.item.type === source.item.type &&
        other.item.id === source.item.id &&
        [...other.replyIds].sort().join(',') === key
      );
    });
}

/**
 * `POST /api/items/:type/:id/task-draft`: asks the viewer's **own** agent to draft a task from the
 * item or the chosen messages. Never waits for an OK (it is the owner's request); there is no way
 * to name another agent. Fails clearly when the viewer has no agent, it is paused, or it can't
 * see the project. The same request while one runs answers the running one.
 */
export function requestTaskDraft(
  deps: AppDeps,
  actor: Actor,
  params: ItemParams,
  input: RequestTaskDraftInput,
): TaskDraftState {
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
  const chosen = [...new Set(input.replyIds ?? [])].slice(0, CHAT_LIMITS.taskFromMessagesMax);
  const replies = sourceReplies(orm, item, chosen);
  if (chosen.length > 0 && replies.length !== chosen.length) {
    throw errors.validation('Some of those messages are not in this conversation any more', {
      field: 'replyIds',
    });
  }
  const source: DraftSource = {
    item: { type: item.type, id: item.id },
    replyIds: replies.length > 0 && chosen.length > 0 ? replies.map((reply) => reply.id) : [],
  };
  const open = openDraftJob(orm, agentId, source);
  if (open) return toState(open);

  const jobId = deps.db.write((tx) => {
    // Like a catch-up, the job targets a message (the last one it reads) rather than the item: a
    // desktop runner hands jobs about an item it is already working on to that running session.
    const last = replies.at(-1);
    const [id] = queueJobs(tx, [
      {
        agentUserId: agentId,
        teamId: item.teamId,
        projectId: item.projectId,
        kind: 'draft_task',
        targetType: last ? 'reply' : item.type,
        targetId: last ? last.id : item.id,
        payload: { itemType: item.type, itemId: item.id, replyIds: source.replyIds },
        triggeredById: actor.userId,
      },
    ]);
    if (!id) throw errors.conflict('Your agent can’t take jobs here right now');
    // The owner's own request never waits for their OK, whatever their job sources say.
    tx.update(s.agentJob)
      .set({ needsOk: false })
      .where(and(eq(s.agentJob.id, id), eq(s.agentJob.agentUserId, agentId)))
      .run();
    return id;
  });
  return getTaskDraft(deps, actor, jobId);
}

/** `GET /api/task-drafts/:jobId`: only the person who asked (the agent's owner) sees it. */
export function getTaskDraft(deps: AppDeps, actor: Actor, jobId: string): TaskDraftState {
  requirePerson(actor);
  const { orm } = deps.db;
  const job = orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
  const agentId = findAgentId(orm, actor.userId);
  if (
    !job ||
    job.kind !== 'draft_task' ||
    !agentId ||
    job.agentUserId !== agentId ||
    job.triggeredById !== actor.userId
  ) {
    throw errors.notFound('Draft');
  }
  const source = draftSourceOf(job);
  // Still allowed to see the item it came from.
  if (!source) throw errors.notFound('Draft');
  requireItem(orm, actor, source.item.type, source.item.id);
  return toState(job);
}

/**
 * MCP `submit_task_draft`: the agent hands in the draft of its own `draft_task` job. Kept on the
 * job for its owner only (nothing is posted or created), and the job is done.
 */
export function submitTaskDraft(
  deps: AppDeps,
  actor: Actor,
  input: SubmitTaskDraftInput,
): { ok: true; jobId: string } {
  const agent = requireListeningAgent(deps, actor);
  const { orm } = deps.db;
  const job = orm.select().from(s.agentJob).where(eq(s.agentJob.id, input.jobId)).get();
  if (job?.agentUserId !== agent.id) throw errors.notFound('Job');
  if (job.kind !== 'draft_task') {
    throw errors.validation('submit_task_draft is only for draft_task jobs', { field: 'jobId' });
  }
  if (job.status === 'cancelled') throw errors.conflict('This job was cancelled');
  if (job.status === 'done') throw errors.conflict('This draft was already submitted');
  deps.db.write((tx) => {
    tx.update(s.agentJob)
      .set({
        status: 'done',
        completedAt: new Date(),
        payload: {
          ...job.payload,
          draft: { title: input.title, description: input.description },
        },
      })
      .where(eq(s.agentJob.id, job.id))
      .run();
    // Personal to the owner: their New task form shows the draft.
    jobChanged(tx, job, agent.ownerId);
  });
  return { ok: true, jobId: job.id };
}

// ---------------------------------------------------------------------------------------------
// The draft job's brief (desktop runner)
// ---------------------------------------------------------------------------------------------

function quoteLines(text: string): string {
  return (text.trim() || '_(no text)_')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** The prompt of a `draft_task` job for a desktop runner: the source and how to hand it in. */
export function taskDraftPrompt(
  deps: AppDeps,
  job: JobRow,
  input: { me: string; owner: string },
): string {
  const { orm } = deps.db;
  const source = draftSourceOf(job);
  const item = source ? findItem(orm, source.item.type, source.item.id) : null;
  const { me, owner } = input;
  const base = deps.env.baseUrl.replace(/\/$/, '');
  const replies = item && source ? sourceReplies(orm, item, source.replyIds) : [];
  const authors = getUserSummaries(
    orm,
    replies.map((reply) => reply.authorId),
  );
  const ref = item?.ref ?? 'the item';
  const url = item ? `${base}${item.path}` : null;
  const transcript =
    replies.length > 0
      ? replies
          .map((reply) => {
            const author = reply.authorId
              ? `@${authors.get(reply.authorId)?.username ?? 'someone'}`
              : 'a former member';
            const link = item ? `${base}${appPaths.reply(item.path, reply.id)}` : '';
            return `**${author}** (${reply.createdAt.toISOString()}, ${link}):\n${quoteLines(reply.body)}`;
          })
          .join('\n\n')
      : '_No messages._';
  const chosen = (source?.replyIds.length ?? 0) > 0;
  return [
    `# Baton job: draft a task from ${ref}${item ? ` — ${item.title}` : ''}`,
    `You are **@${me}**, the Baton agent of **@${owner}**, running headless on their machine for this one job. @${owner} wants to turn ${
      chosen ? `${replies.length} message(s) of the conversation on ${ref}` : ref
    }${url ? ` (${url})` : ''} into a task and asked you to draft it. They review your draft before creating the task.`,
    `## The job\n\nJob id: \`${job.id}\`.`,
    ...(item
      ? [
          `## ${item.type === 'issue' ? 'The issue' : 'The task'}: ${item.title}\n\n${
            item.body.trim() ? quoteLines(item.body) : '_No description._'
          }`,
        ]
      : []),
    `## ${chosen ? 'The chosen messages' : 'Its latest messages'} (oldest first, ${replies.length})\n\n${transcript}`,
    [
      '## Rules',
      '- Title: short and actionable (imperative, under 100 characters), no ref or prefix.',
      '- Description (markdown): the goal in a sentence or two, the context that matters, what is decided and what is open, and a short checklist of acceptance criteria. Link back to the source messages (the links above) and name people with @username.',
      '- Only draft: do not create the task, do not post in the conversation (no add_reply), do not change anything, do not run commands.',
      `- Hand it in with submit_task_draft { jobId: "${job.id}", title, description } (it completes the job; only @${owner} sees it). If you can't, call release_job { jobId: "${job.id}" }.`,
    ].join('\n'),
  ].join('\n\n');
}
