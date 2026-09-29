import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentHandle, agentNameFromClient } from '@shared/agents';
import type { LiveEvent } from '@shared/events';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  openAgentAccess,
  signIn,
  web,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  cancelJobs,
  completeJob,
  getAgentActivity,
  listJobs,
  queueJobs,
  releaseJob,
  startListener,
  sweepListenerSessions,
  waitForMentions,
} from './agentJobs';
import { recordKeyAgent } from './apiKeys';
import { createIssue as createIssueService } from './issues';
import { listNotifications } from './notifications';
import { getTeamPresence, openLiveConnection } from './presence';
import { createReply, editReply } from './replies';
import { createTask as createTaskService, updateTask } from './tasks';
import { getViaKeys } from './users';

/**
 * Agent identity on writes (BAT-6) and agent jobs (docs/design/agents-and-pipelines.md §4): the
 * sources that queue jobs, the listener that claims them, the loop guard, the done handshake and
 * presence.
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let task: TaskRow;
let teamId: string;
let projectId: string;
let otherProjectId: string;
/** Ethan's agent through his "MSI" key (Claude) and his "Laptop" key (Codex). */
let claude: Actor;
let codex: Actor;
/** Caden's agent through his key. */
let cadenAgent: Actor;
let cadenWeb: Actor;
let ethanWeb: Actor;

function keyActor(user: UserRow, keyName: string, agentName: string): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  recordKeyAgent(ctx.deps, apiKey.id, agentName);
  return agentActor(ctx.db, user.id, { id: apiKey.id, name: keyName, agentName });
}

const reply = (actor: Actor, body: string, options: { closing?: boolean; on?: TaskRow } = {}) =>
  createReply(ctx.deps, actor, {
    parentType: 'task',
    parentId: (options.on ?? task).id,
    body,
    closing: options.closing,
  });

/** Checks for jobs without waiting (a fresh session each time unless given). */
const check = (actor: Actor, projects: string[] = ['BAT'], sessionId?: string) =>
  startListener(ctx.deps, actor, { projects, timeoutSeconds: 0, sessionId });

const jobsOf = (agentId: string) =>
  ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.agentUserId, agentId)).all();

async function rejects(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(isAppError(error) ? error.code : error).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  addMember(ctx.db, { teamId, userId: caden.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  projectId = project.id;
  otherProjectId = createProject(ctx.db, { teamId, key: 'WEB', createdById: ethan.id }).project.id;
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Agent replies' });
  claude = keyActor(ethan, 'MSI', 'Claude');
  codex = keyActor(ethan, 'Laptop', 'Codex');
  cadenAgent = keyActor(caden, 'Caden PC', 'Claude');
  cadenWeb = { userId: caden.id, source: 'web', key: null };
  ethanWeb = { userId: ethan.id, source: 'web', key: null };
  // These tests are about jobs, not who may start an agent (agentAccess.test.ts).
  openAgentAccess(ctx.db, ethan.id, teamId);
  openAgentAccess(ctx.db, caden.id, teamId);
});

afterEach(() => {
  ctx.close();
});

describe('agent names', () => {
  it('names well-known MCP clients and keeps other names', () => {
    expect(agentNameFromClient({ name: 'claude-code' })).toBe('Claude');
    expect(agentNameFromClient({ name: 'codex-mcp-client' })).toBe('Codex');
    expect(agentNameFromClient({ name: 'my-bot', title: 'Release Bot' })).toBe('Release Bot');
    expect(agentNameFromClient({})).toBeNull();
    expect(agentHandle('Release Bot')).toBe('releasebot');
  });

  it('learns the agent from the MCP initialize handshake and shows it on writes', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: ethan.id, name: 'Desktop' });
    const res = await ctx.app.request('/mcp', {
      method: 'POST',
      headers: {
        ...bearer(key),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'claude-code', version: '2.1.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const row = ctx.db.orm.select().from(s.apiKey).where(eq(s.apiKey.id, apiKey.id)).get();
    expect(row?.agentName).toBe('Claude');
    expect(getViaKeys(ctx.db.orm, [apiKey.id]).get(apiKey.id)).toEqual({
      keyId: apiKey.id,
      keyName: 'Desktop',
      agentName: 'Claude',
    });
  });
});

describe('agent writes', () => {
  it('are authored by the agent member, named after the key and its harness', () => {
    const written = reply(claude, 'I found the cause.');
    expect(written.author).toMatchObject({
      username: 'ethan-ai',
      name: 'Ethan AI',
      kind: 'agent',
      agentOwner: { id: ethan.id, username: 'ethan' },
    });
    expect(written.via).toMatchObject({ keyName: 'MSI', agentName: 'Claude' });
  });

  it('reach the owner only as far as their agent notifications say (needs_me by default)', () => {
    reply(ethanWeb, 'Subscribing myself');
    reply(claude, 'I found the cause.');
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([]);
    reply(claude, '@ethan the fix needs your review');
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([
      expect.objectContaining({
        type: 'mention',
        actor: expect.objectContaining({ username: 'ethan-ai' }) as unknown,
        viaKeyName: 'MSI',
        viaAgentName: 'Claude',
      }),
    ]);
  });
});

describe('job sources', () => {
  it('queue a mention of @ethan-ai in a reply as one job for Ethan’s agent, with its context', async () => {
    const posted = reply(cadenWeb, '@ethan-ai can you check the tests?');
    const { jobs, sessionId } = await check(claude);
    expect(sessionId).toBeTruthy();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'mention',
      status: 'claimed',
      closing: false,
      project: { ref: 'baton/BAT' },
      target: {
        type: 'task',
        ref: 'baton/BAT-1',
        title: 'Agent replies',
        url: 'http://localhost:4100/t/baton/p/BAT/tasks/1',
        status: 'Open',
      },
      trigger: {
        replyId: posted.id,
        body: '@ethan-ai can you check the tests?',
        author: { username: 'caden', kind: 'human' },
        closing: false,
      },
      stageInstructions: null,
    });
    expect(jobs[0]?.instructions).toMatch(/mentioned you/);
    expect(jobs[0]?.instructions).toMatch(/complete_job/);
    // Claimed once: another key of the same agent doesn't get it again.
    expect((await check(codex)).jobs).toEqual([]);
    // Nobody's inbox heard about it.
    expect(listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items).toEqual([]);
  });

  it('come from task descriptions and issue bodies too, and from edits only for added mentions', async () => {
    createTaskService(ctx.deps, cadenWeb, projectId, {
      title: 'Spec it',
      description: 'Over to @ethan-ai',
    });
    createIssueService(ctx.deps, cadenWeb, projectId, {
      title: 'Crash',
      body: '@ethan-ai look',
    });
    const posted = reply(cadenWeb, 'Thanks');
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @ethan-ai' });
    editReply(ctx.deps, cadenWeb, posted.id, { body: 'Thanks @ethan-ai!' });
    const { jobs } = await check(claude);
    expect(jobs.map((job) => [job.kind, job.target.ref, job.trigger?.body ?? null])).toEqual([
      ['mention', 'baton/BAT-2', null],
      ['mention', 'baton/BAT#1', null],
      ['mention', 'baton/BAT-1', 'Thanks @ethan-ai!'],
    ]);
  });

  it('skip self-mentions and agents outside the team; each mentioned agent gets its own', async () => {
    reply(claude, '@ethan-ai note to self');
    expect(jobsOf(claude.userId)).toEqual([]);

    reply(cadenWeb, '@ethan-ai @caden-ai both of you');
    expect((await check(claude)).jobs).toHaveLength(1);
    expect((await check(cadenAgent)).jobs).toHaveLength(1);

    ctx.db.orm.delete(s.teamMember).where(eq(s.teamMember.userId, claude.userId)).run();
    reply(cadenWeb, '@ethan-ai are you there?');
    expect(jobsOf(claude.userId)).toHaveLength(1);
  });

  it('queue an assigned job when a task is assigned to an agent directly', async () => {
    updateTask(ctx.deps, ethanWeb, task.id, { assigneeUsers: { add: [claude.userId] } });
    const { jobs } = await check(claude);
    expect(jobs).toMatchObject([{ kind: 'assigned', target: { ref: 'baton/BAT-1' } }]);
    expect(jobs[0]?.instructions).toMatch(/assigned to you/);
    // Assigning again (no change) queues nothing more.
    updateTask(ctx.deps, ethanWeb, task.id, { assigneeUsers: { add: [claude.userId] } });
    expect(jobsOf(claude.userId)).toHaveLength(1);
  });

  it('queue thread_reply jobs for agents that authored, replied in or are assigned to the item', async () => {
    const agentTask = createTask(ctx.db, {
      project: { id: projectId, teamId } as never,
      authorId: cadenAgent.userId,
      title: 'By an agent',
    });
    reply(claude, 'I will look into it');
    reply(cadenWeb, 'Here are the logs');
    expect((await check(claude)).jobs).toMatchObject([
      { kind: 'thread_reply', trigger: { body: 'Here are the logs' } },
    ]);
    // Its own replies never wake the agent.
    reply(claude, 'Thanks');
    expect((await check(claude)).jobs).toEqual([]);

    reply(ethanWeb, 'Ping', { on: agentTask });
    expect((await check(cadenAgent)).jobs).toMatchObject([
      { kind: 'thread_reply', target: { ref: 'baton/BAT-2' } },
    ]);
  });

  it('dedupe pending jobs: one per agent and item, taking the latest reply', async () => {
    const first = reply(cadenWeb, '@ethan-ai first');
    reply(cadenWeb, '@ethan-ai second');
    const [job] = (await check(claude)).jobs;
    expect(job).toMatchObject({ kind: 'mention', trigger: { body: '@ethan-ai second' } });
    expect(job?.earlierReplyIds).toEqual([first.id]);
    // A mention in a thread the agent takes part in is one job, not a mention and a thread reply.
    reply(cadenWeb, '@ethan-ai third');
    expect((await check(claude)).jobs.map((j) => j.kind)).toEqual(['mention']);
  });

  it('queueJobs skips non-agents, agents that can’t see the project and paused agents', () => {
    const queue = (agentUserId: string) =>
      ctx.db.write((tx) =>
        queueJobs(tx, [
          {
            agentUserId,
            teamId,
            projectId,
            kind: 'pool',
            targetType: 'task',
            targetId: task.id,
            payload: { instructions: 'Review the diff' },
          },
        ]),
      );
    expect(queue(caden.id)).toEqual([]);
    const [id] = queue(claude.userId);
    expect(id).toBeTruthy();
    // Same kind and target while pending: the same job.
    expect(queue(claude.userId)).toEqual([id]);
    ctx.db.orm
      .update(s.project)
      .set({ agentsPausedAt: new Date() })
      .where(eq(s.project.id, projectId))
      .run();
    expect(queue(cadenAgent.userId)).toEqual([]);
    ctx.db.orm
      .update(s.project)
      .set({ agentsPausedAt: null })
      .where(eq(s.project.id, projectId))
      .run();
    // Cancelled for everyone else once one agent took it.
    ctx.db.write((tx) =>
      queueJobs(tx, [
        {
          agentUserId: cadenAgent.userId,
          teamId,
          projectId,
          kind: 'pool',
          targetType: 'task',
          targetId: task.id,
        },
      ]),
    );
    expect(
      ctx.db.write((tx) =>
        cancelJobs(tx, {
          targetType: 'task',
          targetId: task.id,
          kinds: ['pool'],
          exceptAgentUserId: claude.userId,
        }),
      ),
    ).toBe(1);
    expect(jobsOf(cadenAgent.userId)[0]?.status).toBe('cancelled');
  });

  it('hands pipeline jobs over with the stage instructions', async () => {
    ctx.db.write((tx) =>
      queueJobs(tx, [
        {
          agentUserId: claude.userId,
          teamId,
          projectId,
          kind: 'approval',
          targetType: 'task',
          targetId: task.id,
          payload: { instructions: 'Check the tests pass' },
        },
      ]),
    );
    expect((await check(claude)).jobs).toMatchObject([
      { kind: 'approval', stageInstructions: 'Check the tests pass' },
    ]);
  });
});

describe('the listener', () => {
  it('listens only to the projects it names; other projects keep their jobs', async () => {
    const webTask = createTask(ctx.db, {
      project: { id: otherProjectId, teamId } as never,
      authorId: caden.id,
    });
    reply(cadenWeb, '@ethan-ai in WEB', { on: webTask });
    expect((await check(claude, ['BAT'])).jobs).toEqual([]);
    expect(jobsOf(claude.userId)[0]?.status).toBe('pending');
    expect((await check(claude, ['baton/WEB'])).jobs).toHaveLength(1);
    // Refs of projects it can't see are refused.
    await rejects(check(claude, ['NOPE']), 'not_found');
  });

  it('claims atomically: two sessions never get the same job', async () => {
    for (let n = 0; n < 12; n += 1) {
      const item = createTask(ctx.db, { project: { id: projectId, teamId } as never });
      reply(cadenWeb, `@ethan-ai job ${n}`, { on: item });
    }
    const [a, b] = await Promise.all([check(claude), check(codex)]);
    const ids = [...(a?.jobs ?? []), ...(b?.jobs ?? [])].map((job) => job.jobId);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(Math.max(a?.jobs.length ?? 0, b?.jobs.length ?? 0)).toBe(10);
  });

  it('waits for the first job; with two sessions waiting only one gets it', async () => {
    const first = startListener(ctx.deps, claude, { projects: ['BAT'], timeoutSeconds: 2 });
    const second = startListener(ctx.deps, codex, { projects: ['BAT'], timeoutSeconds: 2 });
    reply(cadenWeb, 'No mention here');
    reply(cadenWeb, '@ethan-ai your turn');
    const results = await Promise.all([first, second]);
    const got = results.flatMap((result) => result.jobs);
    expect(got).toHaveLength(1);
    expect(got[0]?.trigger?.body).toBe('@ethan-ai your turn');
  });

  it('stops waiting when the request goes away', async () => {
    const controller = new AbortController();
    const waiting = startListener(
      ctx.deps,
      claude,
      { projects: ['BAT'], timeoutSeconds: 60 },
      controller.signal,
    );
    controller.abort();
    expect((await waiting).jobs).toEqual([]);
  });

  it('keeps a session across calls and puts its jobs back once it disappears', async () => {
    reply(cadenWeb, '@ethan-ai help');
    const { sessionId, jobs } = await check(claude);
    expect((await check(claude, ['BAT'], sessionId)).sessionId).toBe(sessionId);
    expect(ctx.db.orm.select().from(s.agentSession).all()).toHaveLength(1);
    // Seen recently: its claimed job stays with it (no leases).
    expect(sweepListenerSessions(ctx.deps)).toBe(0);
    ctx.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date(Date.now() - 91_000) })
      .where(eq(s.agentSession.id, sessionId))
      .run();
    expect(sweepListenerSessions(ctx.deps)).toBe(1);
    const again = await check(codex);
    expect(again.jobs.map((job) => job.jobId)).toEqual([jobs[0]?.jobId]);
  });

  it('never sweeps a session while it waits', async () => {
    reply(cadenWeb, '@ethan-ai one');
    const { sessionId } = await check(claude);
    const controller = new AbortController();
    const waiting = startListener(
      ctx.deps,
      claude,
      { projects: ['BAT'], timeoutSeconds: 30, sessionId },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date(Date.now() - 200_000) })
      .where(eq(s.agentSession.id, sessionId))
      .run();
    expect(sweepListenerSessions(ctx.deps)).toBe(0);
    controller.abort();
    await waiting;
  });

  it('completes, releases and lists jobs of its own agent only', async () => {
    reply(cadenWeb, '@ethan-ai first');
    const [job] = (await check(claude)).jobs;
    const jobId = job?.jobId ?? '';
    await rejects(() => completeJob(ctx.deps, cadenAgent, { jobId }), 'not_found');
    expect(releaseJob(ctx.deps, claude, { jobId }).status).toBe('pending');
    expect((await check(codex)).jobs.map((j) => j.jobId)).toEqual([jobId]);
    expect(completeJob(ctx.deps, codex, { jobId }).status).toBe('done');
    expect(completeJob(ctx.deps, codex, { jobId }).status).toBe('done');
    await rejects(() => releaseJob(ctx.deps, codex, { jobId }), 'conflict');
    await rejects(
      () => completeJob(ctx.deps, codex, { jobId, agreeDone: true }),
      'validation_failed',
    );
    expect(listJobs(ctx.deps, claude, { status: 'done' })).toMatchObject({
      jobs: [{ jobId, status: 'done' }],
      pendingCount: 0,
    });
  });

  it('cancels jobs whose item was deleted', async () => {
    reply(cadenWeb, '@ethan-ai look');
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect((await check(claude)).jobs).toEqual([]);
    expect(jobsOf(claude.userId)[0]?.status).toBe('cancelled');
  });

  it('is refused to people and to paused agents, and skips paused projects', async () => {
    await rejects(check(ethanWeb), 'validation_failed');
    ctx.db.orm
      .update(s.user)
      .set({ agentPausedAt: new Date() })
      .where(eq(s.user.id, ethan.id))
      .run();
    reply(cadenWeb, '@ethan-ai while you were paused');
    await rejects(check(claude), 'agents_paused');
    ctx.db.orm.update(s.user).set({ agentPausedAt: null }).where(eq(s.user.id, ethan.id)).run();
    expect(jobsOf(claude.userId)).toEqual([]);

    ctx.db.orm
      .update(s.project)
      .set({ agentsPausedAt: new Date() })
      .where(eq(s.project.id, projectId))
      .run();
    await rejects(check(claude, ['BAT']), 'agents_paused');
    const result = await check(claude, ['BAT', 'WEB']);
    expect(result.projects.map((p) => p.ref)).toEqual(['baton/WEB']);
    expect(result.skipped).toMatchObject([
      { ref: 'baton/BAT', reason: expect.stringMatching(/paused/) as unknown },
    ]);

    ctx.db.orm
      .update(s.project)
      .set({ agentsPausedAt: null })
      .where(eq(s.project.id, projectId))
      .run();
    ctx.db.orm
      .update(s.team)
      .set({ agentsPausedAt: new Date() })
      .where(eq(s.team.id, teamId))
      .run();
    reply(cadenWeb, '@ethan-ai while the team paused agents');
    await rejects(check(claude), 'agents_paused');
    expect(jobsOf(claude.userId)).toEqual([]);
  });

  it('wait_for_mentions (deprecated) hands out mention replies once, marked done', async () => {
    reply(cadenWeb, '@ethan-ai ping');
    const { mentions } = await waitForMentions(ctx.deps, codex, { timeoutSeconds: 0 });
    expect(mentions).toMatchObject([
      {
        parentType: 'task',
        reply: { ref: 'BAT-1', body: '@ethan-ai ping', author: { username: 'caden' } },
      },
    ]);
    expect((await waitForMentions(ctx.deps, claude, { timeoutSeconds: 0 })).mentions).toEqual([]);
    expect(jobsOf(claude.userId)[0]?.status).toBe('done');
    await rejects(waitForMentions(ctx.deps, ethanWeb, { timeoutSeconds: 0 }), 'validation_failed');
  });
});

describe('agent-to-agent threads', () => {
  const guardRows = () =>
    ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.agent_loop_guard')))
      .all();

  it('the loop guard stops jobs once the last 5 replies are all by agents, until a person replies', async () => {
    reply(cadenWeb, '@ethan-ai @caden-ai talk it through');
    await check(claude);
    await check(cadenAgent);
    // Four agent replies: each wakes the other agent.
    for (let n = 0; n < 4; n += 1) {
      reply(n % 2 === 0 ? claude : cadenAgent, `agent reply ${n}`);
    }
    expect(jobsOf(cadenAgent.userId).filter((job) => job.status === 'pending')).toHaveLength(1);
    ctx.db.orm.delete(s.agentJob).run();
    // The fifth in a row trips the guard: no jobs, one system note.
    reply(claude, 'agent reply 4 @caden-ai');
    reply(cadenAgent, 'agent reply 5');
    expect(ctx.db.orm.select().from(s.agentJob).all()).toEqual([]);
    expect(guardRows()).toHaveLength(1);
    expect(guardRows()[0]).toMatchObject({ actorId: null, source: 'system' });
    // A person's reply resets it.
    reply(cadenWeb, 'Keep going');
    reply(claude, 'On it');
    expect(jobsOf(cadenAgent.userId).map((job) => job.kind)).toEqual(['thread_reply']);
  });

  it('the done handshake: agreeing to a closing reply closes the thread for agents', async () => {
    reply(claude, 'Started');
    reply(cadenAgent, 'I think we are done here', { closing: true });
    const [job] = (await check(claude)).jobs;
    expect(job).toMatchObject({ kind: 'thread_reply', closing: true, trigger: { closing: true } });
    expect(job?.instructions).toMatch(/agreeDone: true/);

    completeJob(ctx.deps, claude, { jobId: job?.jobId ?? '', agreeDone: true });
    const agreed = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.agents_agreed_done'))
      .all();
    expect(agreed).toHaveLength(1);
    expect(agreed[0]?.meta).toMatchObject({ agents: ['caden-ai', 'ethan-ai'], with: 'caden-ai' });

    // Agent replies there wake no agent any more…
    reply(cadenAgent, 'One more thing @ethan-ai');
    expect(jobsOf(claude.userId).filter((j) => j.status === 'pending')).toEqual([]);
    // …until a person replies.
    reply(cadenWeb, 'Actually, one more question');
    expect(jobsOf(claude.userId).filter((j) => j.status === 'pending')).toHaveLength(1);
  });

  it('a person’s closing reply carries no handshake', async () => {
    reply(claude, 'Started');
    reply(cadenWeb, 'Done, thanks', { closing: true });
    const [job] = (await check(claude)).jobs;
    expect(job?.closing).toBe(false);
  });
});

describe('presence', () => {
  it('lists people with a live connection and agents with a listener', async () => {
    const events: LiveEvent[] = [];
    const unsubscribe = ctx.deps.events.subscribe((event) => events.push(event));
    expect(getTeamPresence(ctx.deps, ethanWeb, teamId).online).toEqual([]);

    const close = openLiveConnection(ctx.deps, caden.id);
    expect(getTeamPresence(ctx.deps, ethanWeb, teamId).online).toEqual([caden.id]);
    expect(events.filter((event) => event.type === 'presence.changed')).toMatchObject([
      { teamId, entityType: 'team', entityId: teamId },
    ]);
    // Still online for a minute after the connection closed.
    close();
    expect(getTeamPresence(ctx.deps, ethanWeb, teamId).online).toEqual([caden.id]);

    await check(claude);
    expect(getTeamPresence(ctx.deps, ethanWeb, teamId).online.sort()).toEqual(
      [caden.id, claude.userId].sort(),
    );
    ctx.db.orm
      .update(s.agentSession)
      .set({ lastSeenAt: new Date(Date.now() - 91_000) })
      .run();
    expect(getTeamPresence(ctx.deps, ethanWeb, teamId).online).toEqual([caden.id]);
    unsubscribe();
  });

  it('serves GET /api/teams/:teamId/presence to members only; long-polls count', async () => {
    const cookie = await signIn(ctx, caden);
    const poll = await ctx.app.request('/api/events/poll', { headers: web(ctx, cookie) });
    expect(poll.status).toBe(200);
    const res = await ctx.app.request(`/api/teams/${teamId}/presence`, {
      headers: web(ctx, cookie),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ online: [caden.id], runners: [] });

    const outsider = createUser(ctx.db, { username: 'mallory' });
    const other = await signIn(ctx, outsider);
    const hidden = await ctx.app.request(`/api/teams/${teamId}/presence`, {
      headers: web(ctx, other),
    });
    expect(hidden.status).toBe(404);
  });
});

describe('the owner’s agent activity', () => {
  it('shows sessions and latest jobs on GET /api/me/agent/activity (web only)', async () => {
    reply(cadenWeb, '@ethan-ai look');
    await check(claude);
    const activity = getAgentActivity(ctx.deps, ethanWeb);
    expect(activity).toMatchObject({
      online: true,
      pendingCount: 0,
      sessions: [
        {
          keyName: 'MSI',
          agentName: 'Claude',
          online: true,
          projects: [{ key: 'BAT', teamSlug: 'baton' }],
        },
      ],
      jobs: [
        { kind: 'mention', status: 'claimed', target: { ref: 'BAT-1', title: 'Agent replies' } },
      ],
    });
    const cookie = await signIn(ctx, ethan);
    const res = await ctx.app.request('/api/me/agent/activity', { headers: web(ctx, cookie) });
    expect(res.status).toBe(200);
    const { key } = createApiKey(ctx.db, { userId: ethan.id, name: 'Script' });
    const byKey = await ctx.app.request('/api/me/agent/activity', { headers: bearer(key) });
    expect(byKey.status).toBe(403);
  });
});
