import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAccessRules } from '@shared/schemas/agentAccess';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { isAppError } from '../lib/errors';
import {
  addMember,
  agentActor,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  giveRoleWithAgent,
  json,
  openAgentAccess,
  signIn,
  web,
  type TaskRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  agentAccessLevel,
  getAgentAccess,
  getProjectAgentAccess,
  setProjectAgentAccess,
  setTeamAgentAccess,
} from './agentAccess';
import { queueJobs, startListener, sweepSettledJobs } from './agentJobs';
import {
  approveAgentRequest,
  decideAgentRequests,
  declineAgentRequest,
  itemAgentRequests,
  listAgentRequests,
  pendingRequestsOn,
} from './agentRequests';
import { jobBrief, modelOptions, nextRunnerJobs, registerRunner } from './agentRunner';
import { listNotifications } from './notifications';
import { createReply } from './replies';
import { updateTask } from './tasks';

/**
 * Agent access (who can start your agent) and requests: resolution (project override → team
 * default → built-in default), people, roles and agents-of-role scopes, the one-list invariant,
 * gating per job kind, and the request lifecycle (notification, approve with a model the brief
 * uses, decline with a reason the requester sees, clearing).
 */

let ctx: TestContext;
let ethan: UserRow;
let caden: UserRow;
let dana: UserRow;
let eve: UserRow;
let teamId: string;
let projectId: string;
let otherProjectId: string;
let reviewerId: string;
let task: TaskRow;
let ethanWeb: Actor;
let cadenWeb: Actor;
let danaWeb: Actor;
let eveWeb: Actor;
/** Ethan's agent through his desktop app's key. */
let ethanKey: Actor;
let cadenKey: Actor;
let danaKey: Actor;

const person = (user: UserRow): Actor => ({ userId: user.id, source: 'web', key: null });

function keyOf(user: UserRow, name: string): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name });
  return agentActor(ctx.db, user.id, { id: apiKey.id, name }, 'api');
}

async function failure(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a failure');
}

const level = (userId: string | null, where: string = projectId) =>
  agentAccessLevel(
    ctx.db.orm,
    { id: ethanKey.userId, ownerId: ethan.id },
    { teamId, projectId: where },
    userId,
  );

const rules = (
  auto: AgentAccessRules['auto']['allow'],
  ask: AgentAccessRules['ask']['allow'],
  deny: { auto?: AgentAccessRules['auto']['deny']; ask?: AgentAccessRules['ask']['deny'] } = {},
): AgentAccessRules => ({
  auto: { allow: auto, deny: deny.auto ?? [] },
  ask: { allow: ask, deny: deny.ask ?? [] },
});

const mention = (actor: Actor, body = 'Can you look at this @ethan-ai?', on: TaskRow = task) =>
  createReply(ctx.deps, actor, { parentType: 'task', parentId: on.id, body });

const jobs = () =>
  ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.agentUserId, ethanKey.userId)).all();

const ethanInbox = () =>
  listNotifications(ctx.deps, ethanWeb, { limit: 50 }).items.filter(
    (item) => item.type === 'agent_request',
  );

beforeEach(() => {
  ctx = createTestContext({ env: { BASE_URL: 'http://localhost:4100' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  caden = createUser(ctx.db, { username: 'caden', name: 'Caden' });
  dana = createUser(ctx.db, { username: 'dana', name: 'Dana' });
  eve = createUser(ctx.db, { username: 'eve', name: 'Eve' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'baton' }).team.id;
  reviewerId = createRole(ctx.db, { teamId, name: 'Reviewer', slug: 'reviewer' }).id;
  for (const user of [caden, dana, eve]) addMember(ctx.db, { teamId, userId: user.id });
  const { project } = createProject(ctx.db, { teamId, key: 'BAT', createdById: ethan.id });
  projectId = project.id;
  otherProjectId = createProject(ctx.db, { teamId, key: 'WEB', createdById: ethan.id }).project.id;
  task = createTask(ctx.db, { project, authorId: caden.id, title: 'Export is slow' });
  ethanWeb = person(ethan);
  cadenWeb = person(caden);
  danaWeb = person(dana);
  eveWeb = person(eve);
  ethanKey = keyOf(ethan, 'Desktop');
  cadenKey = keyOf(caden, 'Laptop');
  danaKey = keyOf(dana, 'Laptop');
  giveRoleWithAgent(ctx.db, { teamId, userId: dana.id, roleId: reviewerId });
});

afterEach(() => ctx.close());

describe('who can start the agent', () => {
  it('resolves the project override, then the team default, then the built-in default', () => {
    // Built in: only Ethan (and his agent) start it; every person and agent may ask.
    expect(level(ethan.id)).toBe('auto');
    expect(level(ethanKey.userId)).toBe('auto');
    expect(level(null)).toBe('auto');
    expect(level(caden.id)).toBe('ask');
    expect(level(cadenKey.userId)).toBe('ask');
    expect(getAgentAccess(ctx.deps, ethanWeb).teams).toMatchObject([
      { teamId, isDefault: true, rules: { auto: { allow: [] } } },
    ]);

    setTeamAgentAccess(ctx.deps, ethanWeb, teamId, {
      rules: rules(
        [{ type: 'user', userId: caden.id }],
        [{ type: 'role', roleId: reviewerId, scope: 'people' }],
      ),
    });
    expect(level(caden.id)).toBe('auto');
    expect(level(dana.id)).toBe('ask');
    expect(level(eve.id)).toBe('none');
    expect(level(cadenKey.userId)).toBe('none');

    // The project override replaces the team default there only.
    setProjectAgentAccess(ctx.deps, ethanWeb, projectId, {
      override: rules([], [{ type: 'everyone', scope: 'people' }]),
    });
    expect(level(caden.id)).toBe('ask');
    expect(level(eve.id)).toBe('ask');
    expect(level(caden.id, otherProjectId)).toBe('auto');
    expect(getProjectAgentAccess(ctx.deps, ethanKey, projectId)).toMatchObject({
      override: { ask: { allow: [{ type: 'everyone', scope: 'people' }] } },
      teamDefault: { auto: { allow: [{ type: 'user', userId: caden.id }] } },
    });

    // "Use team default".
    setProjectAgentAccess(ctx.deps, ethanWeb, projectId, { override: null });
    expect(level(caden.id)).toBe('auto');
    expect(getProjectAgentAccess(ctx.deps, ethanWeb, projectId).override).toBeNull();
  });

  it('matches roles and agents-of-role scopes; a person named directly beats their roles', () => {
    setTeamAgentAccess(ctx.deps, ethanWeb, teamId, {
      rules: rules(
        [
          { type: 'role', roleId: reviewerId, scope: 'agents' },
          { type: 'everyone', scope: 'people' },
        ],
        [{ type: 'user', userId: dana.id }],
        { auto: [{ type: 'user', userId: eve.id }] },
      ),
    });
    // Dana holds Reviewer and is a person (everyone people): named in "Can ask" directly.
    expect(level(dana.id)).toBe('ask');
    // Her agent: Reviewer's agents start it.
    expect(level(danaKey.userId)).toBe('auto');
    // Caden is a person: auto. His agent isn't a Reviewer's: nothing.
    expect(level(caden.id)).toBe('auto');
    expect(level(cadenKey.userId)).toBe('none');
    // Eve is excluded from "auto", and in no other list.
    expect(level(eve.id)).toBe('none');
  });

  it('keeps each principal in one list, never lists the owner, and serves it over REST', async () => {
    const both = rules([{ type: 'user', userId: caden.id }], [{ type: 'user', userId: caden.id }]);
    expect(
      await failure(() => setTeamAgentAccess(ctx.deps, ethanWeb, teamId, { rules: both })),
    ).toBe('validation_failed');
    // The owner and his own agent always start it: listing them changes nothing.
    const saved = setTeamAgentAccess(ctx.deps, ethanWeb, teamId, {
      rules: rules(
        [],
        [
          { type: 'user', userId: ethan.id },
          { type: 'user', userId: ethanKey.userId },
          { type: 'user', userId: caden.id },
        ],
      ),
    });
    expect(saved.rules.ask.allow).toEqual([{ type: 'user', userId: caden.id }]);
    expect(level(ethan.id)).toBe('auto');

    const cookie = await signIn(ctx, ethan);
    const put = await ctx.app.request(
      `/api/me/agent/access/teams/${teamId}`,
      json('PUT', { rules: both }, web(ctx, cookie)),
    );
    expect(put.status).toBe(400);
    const get = await ctx.app.request('/api/me/agent/access', { headers: web(ctx, cookie) });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { teams: unknown[] }).teams).toHaveLength(1);
    const project = await ctx.app.request(
      `/api/projects/${projectId}/me/agent-access`,
      json('PUT', { override: rules([{ type: 'user', userId: eve.id }], []) }, web(ctx, cookie)),
    );
    expect(project.status).toBe(200);
    expect(level(eve.id)).toBe('auto');
    // Someone who can't see the team can't set anything there.
    const outsider = createUser(ctx.db, { username: 'zed' });
    expect(
      await failure(() =>
        setTeamAgentAccess(ctx.deps, person(outsider), teamId, { rules: rules([], []) }),
      ),
    ).toBe('not_found');
  });
});

describe('gating jobs', () => {
  it('makes a request of an asker’s mention, with a notification to the owner', () => {
    mention(cadenWeb);
    expect(jobs()).toMatchObject([{ kind: 'mention', status: 'pending', needsOk: true }]);
    const [request] = listAgentRequests(ctx.deps, ethanWeb).requests;
    expect(request).toMatchObject({
      status: 'pending',
      kind: 'mention',
      requester: { username: 'caden' },
      question: 'Can I reply to Caden’s message here?',
      summary: 'Reply to Caden’s message on BAT-1',
      target: { ref: 'BAT-1', title: 'Export is slow', path: '/t/baton/p/BAT/tasks/1' },
      message: { body: 'Can you look at this @ethan-ai?' },
      suggestedChain: [{ harness: 'claude', model: 'opus' }],
    });
    expect(ethanInbox()).toMatchObject([
      {
        entityType: 'agent_job',
        entityId: request?.jobId,
        url: '/agent/requests',
        readAt: null,
        actor: { username: 'caden' },
      },
    ]);
    // Caden and everyone else see it waits for Ethan's OK.
    expect(
      itemAgentRequests(ctx.deps, eveWeb, { itemType: 'task', itemId: task.id }),
    ).toMatchObject({
      mine: [],
      waiting: [
        { status: 'pending', owner: { username: 'ethan' }, agent: { username: 'ethan-ai' } },
      ],
    });
    expect(
      itemAgentRequests(ctx.deps, ethanWeb, { itemType: 'task', itemId: task.id }).mine,
    ).toMatchObject([{ jobId: request?.jobId }]);
    expect(pendingRequestsOn(ctx.db.orm, { type: 'task', id: task.id })).toEqual([
      { agent: 'ethan-ai', owner: 'ethan', requester: 'caden', kind: 'mention' },
    ]);
    // Ethan's own mention runs.
    mention(ethanWeb, 'Mine @ethan-ai');
    expect(jobs().filter((job) => !job.needsOk)).toHaveLength(1);
  });

  it('queues nothing for someone who can’t start it, saying so on explicit asks', () => {
    setTeamAgentAccess(ctx.deps, ethanWeb, teamId, {
      rules: rules([], [{ type: 'user', userId: caden.id }]),
    });
    mention(eveWeb);
    expect(jobs()).toEqual([]);
    const notes = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.agent_request_refused'))
      .all();
    expect(notes).toMatchObject([
      { actorId: null, meta: { agent: 'ethan-ai', owner: 'ethan', requester: 'eve' } },
    ]);
    // A reply in a thread Ethan's agent takes part in is skipped silently.
    ctx.db.write((tx) =>
      queueJobs(tx, [
        {
          agentUserId: ethanKey.userId,
          teamId,
          projectId,
          kind: 'thread_reply',
          targetType: 'task',
          targetId: task.id,
          triggeredById: eve.id,
        },
      ]),
    );
    expect(jobs()).toEqual([]);
    expect(
      ctx.db.orm
        .select()
        .from(s.activity)
        .where(eq(s.activity.action, 'task.agent_request_refused'))
        .all(),
    ).toHaveLength(1);
    expect(ethanInbox()).toEqual([]);
  });

  it('gates assignments and stage hand-offs by who caused them', () => {
    setTeamAgentAccess(ctx.deps, ethanWeb, teamId, {
      rules: rules([{ type: 'user', userId: dana.id }], [{ type: 'user', userId: caden.id }]),
    });
    updateTask(ctx.deps, cadenWeb, task.id, { assigneeUsers: { add: [ethanKey.userId] } });
    const pool = (by: string) =>
      ctx.db.write((tx) =>
        queueJobs(tx, [
          {
            agentUserId: ethanKey.userId,
            teamId,
            projectId,
            kind: 'pool',
            targetType: 'task',
            targetId: task.id,
            payload: { stage: 'Build' },
            triggeredById: by,
          },
        ]),
      );
    expect(pool(eve.id)).toEqual([]);
    pool(caden.id);
    const requests = listAgentRequests(ctx.deps, ethanWeb).requests;
    expect(requests.map((request) => [request.kind, request.question])).toEqual([
      ['assigned', 'Can I start BAT-1? Caden assigned it to me.'],
      ['pool', 'Can I pick up BAT-1? Caden moved it into Build, where I may take it.'],
    ]);
    // Dana starts it: her hand-off runs, and her assignment of it too.
    const [poolJob] = pool(dana.id);
    const row = ctx.db.orm
      .select()
      .from(s.agentJob)
      .where(eq(s.agentJob.id, poolJob ?? ''))
      .get();
    // It joined Caden's pending pool request, which now runs (approved by Dana starting it).
    expect(row).toMatchObject({ needsOk: false, requestDecision: 'approved' });
    expect(ethanInbox().filter((item) => item.readAt === null)).toHaveLength(1);
  });

  it('never hands a request to a listener before it is approved', async () => {
    mention(cadenWeb);
    const listened = await startListener(ctx.deps, ethanKey, {
      projects: ['BAT'],
      timeoutSeconds: 0,
    });
    expect(listened.jobs).toEqual([]);
    openAgentAccess(ctx.db, ethan.id, teamId);
    // Someone who starts it asking about the same thing: the request runs.
    mention(cadenWeb, 'Again @ethan-ai');
    const again = await startListener(ctx.deps, ethanKey, { projects: ['BAT'], timeoutSeconds: 0 });
    expect(again.jobs).toHaveLength(1);
    expect(ethanInbox().every((item) => item.readAt !== null)).toBe(true);
  });
});

describe('requests', () => {
  function register() {
    return registerRunner(ctx.deps, ethanKey, {
      machineId: 'machine-msi-1',
      machineName: 'MSI',
      harnesses: [
        {
          id: 'codex',
          version: '0.150.0',
          models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'] }],
          efforts: ['low', 'high'],
        },
      ],
      projectIds: [projectId],
    }).runner;
  }

  it('offers what the owner’s computers report, as the union of their desktop apps', () => {
    register();
    // An older app on another machine: its harnesses don't report models.
    registerRunner(ctx.deps, ethanKey, {
      machineId: 'machine-laptop',
      machineName: 'Laptop',
      harnesses: [{ id: 'gemini', version: '0.9.0' }],
      projectIds: [],
    });
    expect(modelOptions(ctx.deps, ethanWeb).harnesses).toEqual([
      {
        id: 'codex',
        online: true,
        machines: ['MSI'],
        reported: true,
        models: [{ id: 'gpt-5', label: 'GPT-5', efforts: ['low', 'high'], online: true }],
        efforts: ['low', 'high'],
      },
      {
        id: 'gemini',
        online: true,
        machines: ['Laptop'],
        reported: false,
        models: [],
        efforts: [],
      },
    ]);
    expect(modelOptions(ctx.deps, cadenWeb).harnesses).toEqual([]);
  });

  it('approves with a model the brief runs instead of the mappings', async () => {
    const runner = register();
    mention(cadenWeb);
    const [request] = listAgentRequests(ctx.deps, ethanWeb).requests;
    const jobId = request?.jobId ?? '';
    const approved = approveAgentRequest(ctx.deps, ethanWeb, jobId, {
      model: { harness: 'codex', model: 'gpt-5', effort: 'high' },
    });
    expect(approved).toMatchObject({
      status: 'approved',
      modelOverride: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }],
    });
    expect(ethanInbox()[0]?.readAt).not.toBeNull();
    const [job] = (await nextRunnerJobs(ctx.deps, ethanKey, runner.id, 0)).jobs;
    expect(job?.jobId).toBe(jobId);
    const brief = jobBrief(ctx.deps, ethanKey, jobId, runner.id);
    expect(brief.chain).toEqual([{ harness: 'codex', model: 'gpt-5', effort: 'high' }]);
    expect(brief.chainSource).toMatch(/approving/);
    expect(await failure(() => approveAgentRequest(ctx.deps, ethanWeb, jobId))).toBe('conflict');
    // Others' requests don't exist for Caden.
    expect(await failure(() => approveAgentRequest(ctx.deps, cadenWeb, jobId))).toBe('not_found');
  });

  it('declines with a reason the requester sees, and lists it as decided', async () => {
    mention(cadenWeb);
    const [request] = listAgentRequests(ctx.deps, ethanWeb).requests;
    const jobId = request?.jobId ?? '';
    const declined = declineAgentRequest(ctx.deps, ethanWeb, jobId, { reason: 'Not this week' });
    expect(declined).toMatchObject({ status: 'declined', reason: 'Not this week' });
    const row = ctx.db.orm.select().from(s.agentJob).where(eq(s.agentJob.id, jobId)).get();
    expect(row?.status).toBe('cancelled');
    expect(ethanInbox()[0]?.readAt).not.toBeNull();
    const note = ctx.db.orm
      .select()
      .from(s.activity)
      .where(
        and(eq(s.activity.action, 'task.agent_request_declined'), eq(s.activity.actorId, ethan.id)),
      )
      .get();
    expect(note?.meta).toMatchObject({ requester: 'caden', reason: 'Not this week' });
    const query = { itemType: 'task' as const, itemId: task.id };
    expect(itemAgentRequests(ctx.deps, cadenWeb, query).waiting).toMatchObject([
      { status: 'declined', reason: 'Not this week', owner: { username: 'ethan' } },
    ]);
    expect(itemAgentRequests(ctx.deps, eveWeb, query).waiting).toMatchObject([
      { status: 'declined', reason: null },
    ]);
    expect(listAgentRequests(ctx.deps, ethanWeb).requests).toMatchObject([
      { jobId, status: 'declined' },
    ]);
    expect(await failure(() => declineAgentRequest(ctx.deps, ethanWeb, jobId))).toBe('conflict');
  });

  it('clears a request whose task finished, with its notification', () => {
    mention(cadenWeb);
    expect(ethanInbox()[0]?.readAt).toBeNull();
    ctx.db.orm.update(s.task).set({ completedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(sweepSettledJobs(ctx.deps)).toBe(1);
    expect(listAgentRequests(ctx.deps, ethanWeb).requests).toMatchObject([{ status: 'cleared' }]);
    expect(ethanInbox()[0]?.readAt).not.toBeNull();
  });

  it('decides several at once, and serves the Requests page over REST', async () => {
    mention(cadenWeb);
    mention(
      danaWeb,
      'And me @ethan-ai',
      createTask(ctx.db, {
        project: ctx.db.orm.select().from(s.project).where(eq(s.project.id, projectId)).get()!,
        authorId: dana.id,
        title: 'Second',
      }),
    );
    const cookie = await signIn(ctx, ethan);
    const list = await ctx.app.request('/api/me/agent/requests', { headers: web(ctx, cookie) });
    const body = (await list.json()) as { requests: Array<{ jobId: string }> };
    expect(body.requests).toHaveLength(2);
    const [first, second] = body.requests;
    const approve = await ctx.app.request(
      `/api/me/agent/requests/${first?.jobId ?? ''}/approve`,
      json(
        'POST',
        { model: { harness: 'claude', model: 'sonnet', effort: 'high' } },
        web(ctx, cookie),
      ),
    );
    expect(approve.status).toBe(200);
    const bulk = decideAgentRequests(ctx.deps, ethanWeb, {
      jobIds: [first?.jobId ?? '', second?.jobId ?? ''],
      decision: 'decline',
      reason: 'Busy',
    });
    expect(bulk.skipped).toEqual([first?.jobId]);
    expect(bulk.requests).toMatchObject([{ status: 'declined', reason: 'Busy' }]);
    const item = await ctx.app.request(`/api/agent-requests?itemType=task&itemId=${task.id}`, {
      headers: web(ctx, cookie),
    });
    expect(item.status).toBe(200);
  });
});
