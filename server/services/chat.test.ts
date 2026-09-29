import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { catchUpStateSchema, chatPageSchema } from '@shared/schemas/chat';
import { issueSchema } from '@shared/schemas/issues';
import { taskSchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web as sessionHeaders,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { jobContexts, startListener } from './agentJobs';
import { jobBrief } from './agentRunner';
import {
  getCatchUp,
  getChatPage,
  requestCatchUp,
  sendTyping,
  setConversationMode,
  submitCatchUp,
} from './chat';
import { createIssue as createIssueService, getIssue } from './issues';
import { userEventFilter } from './events';
import { createReply } from './replies';
import { createTask as createTaskService, getTask } from './tasks';

/**
 * Chat conversations: the mode (chat for new items, forum for existing ones), the message stream
 * with the unread divider, typing pings, and catch-up summaries by the viewer's own agent only.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let outsider: UserRow;
let teamId: string;
let project: CreatedProject;
let events: LiveEvent[];

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  outsider = createUser(ctx.db, { username: 'olga', name: 'Olga' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  createTeam(ctx.db, { ownerId: outsider.id, slug: 'other' });
  project = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => ctx.close());

describe('conversation mode', () => {
  it('is chat for new issues and tasks, forum when asked, and forum for existing rows', () => {
    const issue = createIssueService(ctx.deps, person(caden), project.project.id, {
      title: 'Crash on start',
    });
    expect(issueSchema.parse(issue).conversationMode).toBe('chat');
    const forum = createIssueService(ctx.deps, person(caden), project.project.id, {
      title: 'Discussion',
      conversationMode: 'forum',
    });
    expect(forum.conversationMode).toBe('forum');
    const task = createTaskService(ctx.deps, person(caden), project.project.id, { title: 'Ship' });
    expect(taskSchema.parse(task).conversationMode).toBe('chat');
    // Rows written without the column (like those from before the migration) are forums.
    const old = createIssue(ctx.db, { project: project.project, authorId: caden.id });
    expect(getIssue(ctx.deps, person(caden), old.id).conversationMode).toBe('forum');
    const oldTask = createTask(ctx.db, { project: project.project, authorId: caden.id });
    expect(getTask(ctx.deps, person(caden), oldTask.id).conversationMode).toBe('forum');
  });

  it('can be switched by the author or EDIT_ANY_CONTENT, with a history entry', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: caden.id });
    const params = { type: 'issue' as const, id: issue.id };
    const other = createUser(ctx.db, { username: 'dana' });
    addMember(ctx.db, { teamId, userId: other.id });
    expect(
      await failure(() => setConversationMode(ctx.deps, person(other), params, { mode: 'chat' })),
    ).toBe('forbidden');
    expect(setConversationMode(ctx.deps, person(caden), params, { mode: 'chat' })).toEqual({
      mode: 'chat',
    });
    expect(getIssue(ctx.deps, person(caden), issue.id).conversationMode).toBe('chat');
    // The team owner (EDIT_ANY_CONTENT) may switch it back.
    setConversationMode(ctx.deps, person(ethan), params, { mode: 'forum' });
    const history = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, issue.id))
      .all();
    expect(history.map((row) => row.changes)).toContainEqual({
      conversation: { from: 'Chat', to: 'Forum' },
    });
    expect(events.some((event) => event.type === 'issue.updated')).toBe(true);
    expect(
      await failure(() =>
        setConversationMode(ctx.deps, person(outsider), params, { mode: 'chat' }),
      ),
    ).toBe('not_found');
  });
});

describe('the chat stream', () => {
  it('pages newest first, oldest first within a page, with the unread count and divider', () => {
    const issue = createIssueService(ctx.deps, person(ethan), project.project.id, {
      title: 'Chat',
    });
    const posted = [];
    for (let index = 0; index < 5; index += 1) {
      posted.push(
        createReply(ctx.deps, person(caden), {
          parentType: 'issue',
          parentId: issue.id,
          body: `message ${index}`,
        }),
      );
    }
    const params = { type: 'issue' as const, id: issue.id };
    const first = chatPageSchema.parse(getChatPage(ctx.deps, person(ethan), params, { limit: 3 }));
    expect(first.items.map((reply) => reply.body)).toEqual(['message 2', 'message 3', 'message 4']);
    expect(first.total).toBe(5);
    // Ethan authored the issue, so he is subscribed: every message is unread for him.
    expect(first.unread).toEqual({ count: 5, firstReplyId: posted[0]?.id });
    const older = getChatPage(ctx.deps, person(ethan), params, {
      limit: 3,
      before: first.olderCursor ?? '',
    });
    expect(older.items.map((reply) => reply.body)).toEqual(['message 0', 'message 1']);
    expect(older.olderCursor).toBeNull();
  });

  it('hides the chat from people outside the project', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: caden.id });
    expect(
      await failure(() =>
        getChatPage(ctx.deps, person(outsider), { type: 'issue', id: issue.id }, {}),
      ),
    ).toBe('not_found');
  });

  it('refuses a message with neither text nor files', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: caden.id });
    const cookie = await signIn(ctx, caden);
    const noText = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        { parentType: 'issue', parentId: issue.id, body: '' },
        sessionHeaders(ctx, cookie),
      ),
    );
    expect(noText.status).toBe(400);
  });
});

describe('typing', () => {
  it('emits an ephemeral typing event to members who can see the item, never stored', async () => {
    const task = createTask(ctx.db, { project: project.project, authorId: caden.id });
    const params = { type: 'task' as const, id: task.id };
    sendTyping(ctx.deps, person(caden), params, 1_000);
    // Too soon after the last ping: dropped.
    sendTyping(ctx.deps, person(caden), params, 1_500);
    const typing = events.filter((event) => event.type === 'typing');
    expect(typing).toHaveLength(1);
    expect(typing[0]).toMatchObject({
      teamId,
      projectId: project.project.id,
      entityType: 'task',
      entityId: task.id,
      actorId: caden.id,
    });
    // Delivered to team members, not to other teams.
    const event = typing[0] as LiveEvent;
    expect(userEventFilter(ctx.deps, ethan.id)(event)).toBe(true);
    expect(userEventFilter(ctx.deps, outsider.id)(event)).toBe(false);
    expect(await failure(() => sendTyping(ctx.deps, person(outsider), params, 5_000))).toBe(
      'not_found',
    );
    // Nothing is written (no activity rows about typing).
    expect(
      ctx.db.orm
        .select()
        .from(s.activity)
        .all()
        .filter((row) => row.action.includes('typing')),
    ).toEqual([]);
  });

  it('is a REST endpoint (POST /api/items/:type/:id/typing)', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: caden.id });
    const cookie = await signIn(ctx, caden);
    const res = await ctx.app.request(`/api/items/issue/${issue.id}/typing`, {
      method: 'POST',
      headers: sessionHeaders(ctx, cookie),
    });
    expect(res.status).toBe(200);
    expect(events.some((event) => event.type === 'typing' && event.entityId === issue.id)).toBe(
      true,
    );
    const outsiderCookie = await signIn(ctx, outsider);
    const hidden = await ctx.app.request(`/api/items/issue/${issue.id}/typing`, {
      method: 'POST',
      headers: sessionHeaders(ctx, outsiderCookie),
    });
    expect(hidden.status).toBe(404);
  });
});

describe('catch up', () => {
  function chatWithMessages(count: number) {
    const issue = createIssueService(ctx.deps, person(ethan), project.project.id, {
      title: 'Busy chat',
    });
    const replies = [];
    for (let index = 0; index < count; index += 1) {
      replies.push(
        createReply(ctx.deps, person(caden), {
          parentType: 'issue',
          parentId: issue.id,
          body: `update ${index}`,
        }),
      );
    }
    return { issue, replies, params: { type: 'issue' as const, id: issue.id } };
  }

  it('queues a catch_up job for the viewer’s own agent only, without waiting for an OK', () => {
    const { params, replies } = chatWithMessages(12);
    createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    createApiKey(ctx.db, { userId: caden.id, name: 'Laptop' });
    const state = catchUpStateSchema.parse(
      requestCatchUp(ctx.deps, person(ethan), params, { kind: 'last', count: 20 }),
    );
    expect(state.job).toMatchObject({
      status: 'pending',
      range: { kind: 'last', count: 12, toReplyId: replies.at(-1)?.id },
    });
    const jobs = ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.kind, 'catch_up')).all();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    const ethanAgent = ctx.db.orm
      .select()
      .from(s.user)
      .where(eq(s.user.agentOwnerId, ethan.id))
      .get();
    expect(job).toMatchObject({ agentUserId: ethanAgent?.id, needsOk: false });
    // Caden's view: no job, and he sees nothing of Ethan's.
    expect(getCatchUp(ctx.deps, person(caden), params)).toMatchObject({
      job: null,
      summaries: [],
    });
  });

  it('refuses API keys (agents) and people without an agent', async () => {
    const { params } = chatWithMessages(2);
    expect(
      await failure(() =>
        requestCatchUp(ctx.deps, person(caden), params, { kind: 'last', count: 20 }),
      ),
    ).toBe('conflict');
    const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    const key = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' });
    expect(
      await failure(() => requestCatchUp(ctx.deps, key, params, { kind: 'last', count: 20 })),
    ).toBe('forbidden');
  });

  it('summarizes the unread range, and submit_catch_up stores it privately for the owner', async () => {
    const { params, replies } = chatWithMessages(15);
    const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    const ethanKey = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' });
    const since = replies[5]?.id ?? '';
    const state = requestCatchUp(ctx.deps, person(ethan), params, {
      kind: 'unread',
      sinceReplyId: since,
    });
    expect(state.job?.range).toMatchObject({ kind: 'unread', count: 10, fromReplyId: since });
    const jobId = state.job?.id ?? '';

    // The job tells the agent what to do; its brief carries the messages.
    const [context] = jobContexts(ctx.deps, [
      ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get()!,
    ]);
    expect(context?.instructions).toContain('submit_catch_up');
    const brief = jobBrief(ctx.deps, ethanKey, jobId, undefined);
    expect(brief.prompt).toContain('update 5');
    expect(brief.prompt).toContain('update 14');
    expect(brief.prompt).not.toContain('update 4\n');

    // Another person's agent can't submit it.
    const { apiKey: cadenKey } = createApiKey(ctx.db, { userId: caden.id, name: 'Laptop' });
    const caden$ = agentActor(ctx.db, caden.id, { id: cadenKey.id, name: 'Laptop' });
    expect(await failure(() => submitCatchUp(ctx.deps, caden$, { jobId, summary: 'Nope' }))).toBe(
      'not_found',
    );

    events = [];
    const result = submitCatchUp(ctx.deps, ethanKey, {
      jobId,
      summary: 'Caden posted **10 updates**.',
    });
    expect(result.ok).toBe(true);
    // The owner's panel refreshes (personal event).
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'agent_job.changed', userId: ethan.id }),
    );
    const mine = getCatchUp(ctx.deps, person(ethan), params);
    expect(mine.job).toBeNull();
    expect(mine.summaries).toHaveLength(1);
    expect(mine.summaries[0]).toMatchObject({
      summary: 'Caden posted **10 updates**.',
      range: { kind: 'unread', count: 10 },
    });
    // Only the owner can read it.
    expect(getCatchUp(ctx.deps, person(caden), params).summaries).toEqual([]);
    const cookie = await signIn(ctx, caden);
    const res = await ctx.app.request(`/api/items/issue/${params.id}/catch-up`, {
      headers: sessionHeaders(ctx, cookie),
    });
    expect(catchUpStateSchema.parse(await res.json()).summaries).toEqual([]);
    // Submitting twice is refused.
    expect(
      await failure(() => submitCatchUp(ctx.deps, ethanKey, { jobId, summary: 'Again' })),
    ).toBe('conflict');
  });

  it('is handed to the owner’s listener like any job, separate from the item’s other jobs', async () => {
    const { params } = chatWithMessages(3);
    const { apiKey, key } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    const ethanKey = agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' });
    requestCatchUp(ctx.deps, person(ethan), params, { kind: 'last', count: 20 });
    const listened = await startListener(ctx.deps, ethanKey, {
      projects: ['BAT'],
      timeoutSeconds: 0,
    });
    expect(listened.jobs).toHaveLength(1);
    expect(listened.jobs[0]).toMatchObject({ kind: 'catch_up', target: { type: 'reply' } });
    expect(listened.jobs[0]?.target.ref).toBe('baton/BAT#1');
    // While it runs, asking again is refused; the REST route says so too.
    const cookie = await signIn(ctx, ethan);
    const again = await ctx.app.request(
      `/api/items/issue/${params.id}/catch-up`,
      json('POST', { kind: 'last', count: 50 }, sessionHeaders(ctx, cookie)),
    );
    expect(again.status).toBe(409);
    // An API key can't read anyone's summaries through REST.
    const viaKey = await ctx.app.request(`/api/items/issue/${params.id}/catch-up`, {
      headers: bearer(key),
    });
    expect(viaKey.status).toBe(403);
  });
});

describe('agent jobs in a chat', () => {
  it('tell the agent the conversation is a chat', () => {
    const issue = createIssueService(ctx.deps, person(ethan), project.project.id, {
      title: 'Chat',
    });
    const { apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    agentActor(ctx.db, ethan.id, { id: apiKey.id, name: 'Desktop' });
    createReply(ctx.deps, person(caden), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Can you check this @ethan-ai?',
    });
    const job = ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.kind, 'mention')).get();
    expect(job).toBeDefined();
    const [context] = jobContexts(ctx.deps, [job!]);
    expect(context?.instructions).toContain('This conversation is a chat');
  });
});
