import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { EVERYONE_DEFAULTS } from '@shared/permissions';
import { taskDraftStateSchema } from '@shared/schemas/chat';
import type { Status } from '@shared/schemas/projects';
import { taskSchema } from '@shared/schemas/tasks';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  agentActor,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web as sessionHeaders,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { jobContexts, startListener } from './agentJobs';
import { approveAgentRequest, declineAgentRequest, itemAgentRequests } from './agentRequests';
import { jobBrief } from './agentRunner';
import { createIssue } from './issues';
import { createReply } from './replies';
import { createStatus, listStatuses } from './statuses';
import { getTaskDraft, requestTaskDraft, submitTaskDraft } from './taskDrafts';
import { createTaskFromIssue } from './tasks';

/**
 * Tasks from issues and chat messages: Create task on an issue with the New task form's choices
 * (stage, title) still links the issue as `fixes`; "Have my agent draft it" is a `draft_task` job
 * for the viewer's own agent only, and its draft (MCP `submit_task_draft`) is private. Agent
 * requests in a conversation name the message that asked and show approvals with the model.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let teamId: string;
let projectId: string;
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

function keyOf(user: UserRow, name: string): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name });
  return agentActor(ctx.db, user.id, { id: apiKey.id, name }, 'api');
}

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  projectId = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id }).project.id;
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => ctx.close());

describe('create task from an issue, from the New task form', () => {
  it('lands in the chosen stage with the form’s title and links the issue as fixes', async () => {
    const issue = createIssue(ctx.deps, person(caden), projectId, {
      title: 'Crash on start',
      body: 'Steps: open it.',
    });
    const triage: Status = createStatus(ctx.deps, person(ethan), projectId, {
      name: 'Triage',
      rules: { allowCreate: true },
    });
    const task = createTaskFromIssue(ctx.deps, person(ethan), projectId, {
      issueId: issue.id,
      title: 'Fix the crash on start',
      description: 'Edited in the form',
      statusId: triage.id,
    });
    expect(task).toMatchObject({
      title: 'Fix the crash on start',
      description: 'Edited in the form',
      status: { name: 'Triage' },
      issues: [{ id: issue.id, kind: 'fixes' }],
    });
    // Without overrides: the issue's title, a link back plus its body, the default stage.
    const plain = createTaskFromIssue(ctx.deps, person(ethan), projectId, { issueId: issue.id });
    expect(plain.title).toBe('Crash on start');
    expect(plain.description).toContain('From issue [BAT#1]');
    expect(plain.description).toContain('Steps: open it.');
    expect(plain.status.name).toBe(
      listStatuses(ctx.deps, person(ethan), projectId).items.find((status) => status.isDefault)
        ?.name,
    );

    // Over REST, as the dialog sends it.
    const cookie = await signIn(ctx, ethan);
    const res = await ctx.app.request(
      `/api/projects/${projectId}/tasks/from-issue`,
      json(
        'POST',
        { issueId: issue.id, title: 'Via REST', statusId: triage.id, priority: 2 },
        sessionHeaders(ctx, cookie),
      ),
    );
    expect(res.status).toBe(201);
    const created = taskSchema.parse(await res.json());
    expect(created).toMatchObject({
      title: 'Via REST',
      priority: 2,
      status: { id: triage.id },
      issues: [{ id: issue.id, kind: 'fixes' }],
    });
  });

  it('links relates for someone who may not resolve the issue, even when asked for fixes', () => {
    const dana = createUser(ctx.db, { username: 'dana' });
    addMember(ctx.db, { teamId, userId: dana.id });
    ctx.db.orm
      .update(s.role)
      .set({ permissions: EVERYONE_DEFAULTS.filter((name) => name !== 'RESOLVE_ISSUES') })
      .where(and(eq(s.role.teamId, teamId), eq(s.role.isEveryone, true)))
      .run();
    const issue = createIssue(ctx.deps, person(caden), projectId, { title: 'Crash' });
    const task = createTaskFromIssue(ctx.deps, person(dana), projectId, {
      issueId: issue.id,
      issueLinks: [{ issueId: issue.id, kind: 'fixes' }],
    });
    expect(task.issues).toMatchObject([{ id: issue.id, kind: 'relates' }]);
  });
});

describe('task drafts by your own agent', () => {
  function chat(count: number) {
    const issue = createIssue(ctx.deps, person(ethan), projectId, { title: 'Busy chat' });
    const replies = Array.from({ length: count }, (_, index) =>
      createReply(ctx.deps, person(caden), {
        parentType: 'issue',
        parentId: issue.id,
        body: `idea ${index}`,
      }),
    );
    return { issue, replies, params: { type: 'issue' as const, id: issue.id } };
  }

  it('queues a draft_task job for the viewer’s own agent only, without waiting for an OK', async () => {
    const { params, replies } = chat(4);
    const ethanKey = keyOf(ethan, 'Desktop');
    keyOf(caden, 'Laptop');
    const chosen = [replies[2]?.id ?? '', replies[0]?.id ?? ''];
    const state = taskDraftStateSchema.parse(
      requestTaskDraft(ctx.deps, person(ethan), params, { replyIds: chosen }),
    );
    // Kept in conversation order.
    expect(state).toMatchObject({
      status: 'pending',
      itemType: 'issue',
      replyIds: [replies[0]?.id, replies[2]?.id],
      draft: null,
    });
    const jobs = ctx.db.orm
      .select()
      .from(s.agentJob)
      .where(eq(s.agentJob.kind, 'draft_task'))
      .all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      agentUserId: ethanKey.userId,
      needsOk: false,
      triggeredById: ethan.id,
      targetType: 'reply',
      targetId: replies[2]?.id,
    });
    // Asking again while it waits answers the same job.
    expect(requestTaskDraft(ctx.deps, person(ethan), params, { replyIds: chosen }).jobId).toBe(
      state.jobId,
    );
    // Nobody else can read it.
    expect(await failure(() => getTaskDraft(ctx.deps, person(caden), state.jobId))).toBe(
      'not_found',
    );
    // The job tells a listener what to do; a desktop runner's brief carries the messages.
    const [context] = jobContexts(ctx.deps, jobs);
    expect(context?.instructions).toContain('submit_task_draft');
    expect(context?.instructions).not.toContain('add_reply {');
    const brief = jobBrief(ctx.deps, ethanKey, state.jobId, undefined);
    expect(brief.prompt).toContain('idea 0');
    expect(brief.prompt).toContain('idea 2');
    expect(brief.prompt).not.toContain('idea 1');
    expect(brief.prompt).toContain('http://localhost:4100/t/baton/p/BAT/issues/1#reply-');
    // The listener hands it out like any job.
    const listened = await startListener(ctx.deps, ethanKey, {
      projects: ['BAT'],
      timeoutSeconds: 0,
    });
    expect(listened.jobs).toMatchObject([{ kind: 'draft_task' }]);
  });

  it('refuses API keys, people without an agent, and messages of another conversation', async () => {
    const { params, replies } = chat(2);
    expect(await failure(() => requestTaskDraft(ctx.deps, person(caden), params, {}))).toBe(
      'conflict',
    );
    const ethanKey = keyOf(ethan, 'Desktop');
    expect(await failure(() => requestTaskDraft(ctx.deps, ethanKey, params, {}))).toBe('forbidden');
    const other = chat(1);
    expect(
      await failure(() =>
        requestTaskDraft(ctx.deps, person(ethan), params, {
          replyIds: [replies[0]?.id ?? '', other.replies[0]?.id ?? ''],
        }),
      ),
    ).toBe('validation_failed');
  });

  it('keeps the submitted draft private to the owner and never creates a task', async () => {
    const { params } = chat(3);
    const ethanKey = keyOf(ethan, 'Desktop');
    const cadenKey = keyOf(caden, 'Laptop');
    // Without chosen messages: the issue itself.
    const { jobId } = requestTaskDraft(ctx.deps, person(ethan), params, {});
    expect(
      await failure(() =>
        submitTaskDraft(ctx.deps, cadenKey, { jobId, title: 'Nope', description: '' }),
      ),
    ).toBe('not_found');
    events = [];
    submitTaskDraft(ctx.deps, ethanKey, {
      jobId,
      title: 'Collect the ideas',
      description: '- [ ] idea 0',
    });
    const personal = events.filter((event) => event.type === 'agent_job.changed');
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.every((event) => event.userId === ethan.id)).toBe(true);
    expect(getTaskDraft(ctx.deps, person(ethan), jobId)).toMatchObject({
      status: 'done',
      replyIds: [],
      draft: { title: 'Collect the ideas', description: '- [ ] idea 0' },
    });
    expect(ctx.db.orm.select().from(s.task).all()).toHaveLength(0);
    expect(
      ctx.db.orm.select().from(s.reply).where(eq(s.reply.body, '- [ ] idea 0')).all(),
    ).toHaveLength(0);
    // Over REST: Ethan reads it, Caden gets a 404.
    const ethanCookie = await signIn(ctx, ethan);
    const mine = await ctx.app.request(`/api/task-drafts/${jobId}`, {
      headers: sessionHeaders(ctx, ethanCookie),
    });
    expect(taskDraftStateSchema.parse(await mine.json()).draft?.title).toBe('Collect the ideas');
    const cadenCookie = await signIn(ctx, caden);
    const theirs = await ctx.app.request(`/api/task-drafts/${jobId}`, {
      headers: sessionHeaders(ctx, cadenCookie),
    });
    expect(theirs.status).toBe(404);
    expect(
      await failure(() =>
        submitTaskDraft(ctx.deps, ethanKey, { jobId, title: 'Again', description: '' }),
      ),
    ).toBe('conflict');
  });

  it('is requested over REST', async () => {
    const { params, replies } = chat(1);
    keyOf(ethan, 'Desktop');
    const cookie = await signIn(ctx, ethan);
    const res = await ctx.app.request(
      `/api/items/issue/${params.id}/task-draft`,
      json('POST', { replyIds: [replies[0]?.id] }, sessionHeaders(ctx, cookie)),
    );
    expect(res.status).toBe(201);
    expect(taskDraftStateSchema.parse(await res.json())).toMatchObject({
      status: 'pending',
      replyIds: [replies[0]?.id],
    });
  });
});

describe('agent requests in a conversation', () => {
  it('name the message that asked, and show the approval with its model to everyone', () => {
    keyOf(ethan, 'Desktop');
    const issue = createIssue(ctx.deps, person(ethan), projectId, { title: 'Chat' });
    const ask = createReply(ctx.deps, person(caden), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Can you check this @ethan-ai?',
    });
    const query = { itemType: 'issue' as const, itemId: issue.id };
    const [waiting] = itemAgentRequests(ctx.deps, person(caden), query).waiting;
    expect(waiting).toMatchObject({ status: 'pending', replyId: ask.id, model: null });
    const [card] = itemAgentRequests(ctx.deps, person(ethan), query).mine;
    expect(card?.message?.replyId).toBe(ask.id);

    events = [];
    approveAgentRequest(ctx.deps, person(ethan), waiting?.jobId ?? '', {
      model: { harness: 'claude', model: 'opus', effort: 'high' },
    });
    // Everyone's line refreshes: an activity on the issue.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'activity.created', parentId: issue.id }),
    );
    expect(
      ctx.db.orm
        .select()
        .from(s.activity)
        .where(
          and(
            eq(s.activity.action, 'issue.agent_request_approved'),
            eq(s.activity.actorId, ethan.id),
          ),
        )
        .get()?.meta,
    ).toMatchObject({ requester: 'caden', agent: 'ethan-ai' });
    expect(itemAgentRequests(ctx.deps, person(caden), query)).toMatchObject({
      mine: [],
      waiting: [
        {
          status: 'approved',
          replyId: ask.id,
          owner: { username: 'ethan' },
          model: { harness: 'claude', model: 'opus', effort: 'high' },
        },
      ],
    });
  });

  it('show a decline with its reason to the requester', () => {
    keyOf(ethan, 'Desktop');
    const issue = createIssue(ctx.deps, person(ethan), projectId, { title: 'Chat' });
    const ask = createReply(ctx.deps, person(caden), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Please @ethan-ai',
    });
    const query = { itemType: 'issue' as const, itemId: issue.id };
    const jobId = itemAgentRequests(ctx.deps, person(caden), query).waiting[0]?.jobId ?? '';
    declineAgentRequest(ctx.deps, person(ethan), jobId, { reason: 'Busy' });
    expect(itemAgentRequests(ctx.deps, person(caden), query).waiting).toMatchObject([
      { status: 'declined', replyId: ask.id, reason: 'Busy', model: null },
    ]);
  });
});
