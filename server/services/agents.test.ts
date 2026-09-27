import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentSettingsSchema } from '@shared/schemas/account';
import { apiErrorSchema } from '@shared/schemas/common';
import type { Actor } from '../context';
import { runMigrations } from '../db/migrate';
import * as s from '../db/schema';
import { registerTools } from '../mcp/tools';
import {
  addMember,
  addPassword,
  agentActor,
  bearer,
  createAgent,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { getMembership } from './access';
import { deleteAccount, updateProfile } from './account';
import { backfillAgents, ensureAgent, findAgentId } from './agents';
import { acceptInvite, createInvite } from './invites';
import { assignRole, leaveTeam, removeMember } from './members';
import { createReply, deleteReply, editReply } from './replies';
import { createTeam as createTeamService } from './teams';

/**
 * Agent members (agents A, docs/design/agents-and-pipelines.md §1): one per person, created on
 * sign-up and by the backfill, named after its owner, never signing in or mailed, mirroring its
 * owner's teams, acting for API keys with permissions capped by its owner's, and pausable.
 */

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext({ env: { E2E_MAILBOX: 'true', LOG_LEVEL: 'silent' } });
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  team = createTeam(ctx.db, { ownerId: ethan.id, slug: 'acme', name: 'Acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', name: 'Api' });
});

afterEach(() => {
  ctx.close();
});

/** What a request with a new API key of `user` acts as: their agent member. */
function keyActor(user: UserRow): Actor {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'MSI' });
  return agentActor(ctx.db, user.id, { id: apiKey.id, name: apiKey.name });
}

function userRow(id: string) {
  return ctx.db.orm.select().from(s.user).where(eq(s.user.id, id)).get();
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request(url, json('POST', body, { Origin: ctx.env.baseUrl, ...headers }));
}

async function errorCode(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error.code;
}

describe('ensureAgent', () => {
  it('creates one agent per person, named after them, verified, never mailed, without a login', () => {
    const id = ensureAgent(ctx.db, ethan.id);
    expect(ensureAgent(ctx.db, ethan.id)).toBe(id);
    expect(userRow(id)).toMatchObject({
      kind: 'agent',
      agentOwnerId: ethan.id,
      username: 'ethan-ai',
      displayUsername: 'ethan-ai',
      name: 'Ethan AI',
      email: `${id.toLowerCase()}@agents.baton.invalid`,
      emailVerified: true,
      image: null,
    });
    expect(ctx.db.orm.select().from(s.account).where(eq(s.account.userId, id)).all()).toEqual([]);
    expect(ctx.db.orm.select().from(s.user).where(eq(s.user.kind, 'agent')).all()).toHaveLength(1);
    // Agents have no agents.
    expect(() => ensureAgent(ctx.db, id)).toThrow(/not a person/);
  });

  it('joins the owner’s teams with @everyone only', () => {
    const id = ensureAgent(ctx.db, ethan.id);
    const membership = getMembership(ctx.db.orm, team.team.id, id);
    expect(membership).toMatchObject({ isOwner: false, roleIds: [] });
    expect(membership?.permissions).not.toContain('MANAGE_PROJECTS');
  });
});

describe('backfill', () => {
  it('gives every existing person an agent in their teams, idempotently', () => {
    expect(backfillAgents(ctx.db)).toBe(2);
    const agentId = findAgentId(ctx.db.orm, mia.id) ?? '';
    expect(getMembership(ctx.db.orm, team.team.id, agentId)).not.toBeNull();
    expect(backfillAgents(ctx.db)).toBe(0);
    // An agent an admin removed stays out: memberships are only mirrored when an agent is made.
    removeMember(ctx.deps, person(ethan), team.team.id, agentId);
    runMigrations(ctx.db);
    expect(getMembership(ctx.db.orm, team.team.id, agentId)).toBeNull();
    expect(ctx.db.orm.select().from(s.user).where(eq(s.user.kind, 'agent')).all()).toHaveLength(2);
  });
});

describe('sign-up and renames', () => {
  it('creates the agent on email sign-up, and on OAuth sign-up before a username is chosen', async () => {
    const res = await post('/api/auth/sign-up/email', {
      email: 'zoe@example.test',
      password: 'hunter2hunter2',
      name: 'Zoe',
      username: 'Zoe_1',
    });
    expect(res.status).toBe(200);
    const zoe = ctx.db.orm.select().from(s.user).where(eq(s.user.email, 'zoe@example.test')).get();
    expect(userRow(findAgentId(ctx.db.orm, zoe?.id ?? '') ?? '')).toMatchObject({
      username: 'zoe_1-ai',
      displayUsername: 'Zoe_1-ai',
      name: 'Zoe AI',
    });

    const auth = await ctx.deps.auth.$context;
    const { user } = await auth.internalAdapter.createOAuthUser(
      { name: 'Olga', email: 'olga@example.test', emailVerified: true, image: null },
      { providerId: 'github', accountId: '4242' },
    );
    const agentId = findAgentId(ctx.db.orm, user.id) ?? '';
    expect(userRow(agentId)).toMatchObject({ username: null, name: 'Olga AI', kind: 'agent' });
    // Onboarding picks the username through Better Auth: the agent follows.
    await auth.internalAdapter.updateUser(user.id, { username: 'olga', displayUsername: 'Olga' });
    expect(userRow(agentId)).toMatchObject({ username: 'olga-ai', displayUsername: 'Olga-ai' });
  });

  it('renames the agent with its owner, and keeps the -ai suffix for agents', async () => {
    const agentId = ensureAgent(ctx.db, ethan.id);
    updateProfile(ctx.deps, person(ethan), { username: 'Ethan_H', name: 'Ethan H' });
    expect(userRow(agentId)).toMatchObject({
      username: 'ethan_h-ai',
      displayUsername: 'Ethan_H-ai',
      name: 'Ethan H AI',
    });
    // Through a key, the profile is still the person's (and the agent follows).
    const { key } = createApiKey(ctx.db, { userId: ethan.id });
    const patched = await ctx.app.request('/api/me', json('PATCH', { name: 'E' }, bearer(key)));
    expect(patched.status).toBe(200);
    expect(userRow(ethan.id)?.name).toBe('E');
    expect(userRow(agentId)?.name).toBe('E AI');

    expect(() => updateProfile(ctx.deps, person(mia), { username: 'mia-ai' })).toThrow();
    const signUp = await post('/api/auth/sign-up/email', {
      email: 'x@example.test',
      password: 'hunter2hunter2',
      name: 'X',
      username: 'x-ai',
    });
    expect(signUp.status).toBe(400);
  });
});

describe('agents never sign in and are never mailed', () => {
  it('refuses password sign-in, codes, resets and agent addresses at sign-up', async () => {
    const agent = createAgent(ctx.db, ethan.id);
    await addPassword(ctx.db, agent.id, 'hunter2hunter2');
    for (const body of [
      { email: agent.email, password: 'hunter2hunter2' },
      { username: 'ethan-ai', password: 'hunter2hunter2' },
    ]) {
      const path = 'email' in body ? '/api/auth/sign-in/email' : '/api/auth/sign-in/username';
      const res = await post(path, body);
      expect(res.status, path).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(ctx.db.orm.select().from(s.session).all()).toEqual([]);

    for (const [path, body] of [
      [
        '/api/auth/email-otp/send-verification-otp',
        { email: agent.email, type: 'email-verification' },
      ],
      ['/api/auth/email-otp/request-password-reset', { email: agent.email }],
      ['/api/auth/forget-password/email-otp', { email: agent.email }],
    ] as const) {
      expect((await post(path, body)).status, path).toBe(200);
    }
    expect(ctx.db.orm.select().from(s.verification).all()).toEqual([]);

    const signUp = await post('/api/auth/sign-up/email', {
      email: 'someone@agents.baton.invalid',
      password: 'hunter2hunter2',
      name: 'Someone',
      username: 'someone',
    });
    expect(signUp.status).toBe(400);
    await expect(
      ctx.deps.mailer.sendOtp(agent.email, 'email-verification', '123456'),
    ).resolves.toBe(undefined);
  });

  it('deletes the agent with its owner’s account', async () => {
    const agent = createAgent(ctx.db, mia.id);
    const task = createTask(ctx.db, { project: project.project });
    const written = createReply(ctx.deps, keyActor(mia), {
      parentType: 'task',
      parentId: task.id,
      body: 'by the agent',
    });
    await deleteAccount(ctx.deps, person(mia), { confirmUsername: 'mia' });
    expect(userRow(agent.id)).toBeUndefined();
    expect(ctx.db.orm.select().from(s.reply).where(eq(s.reply.id, written.id)).get()).toMatchObject(
      { authorId: null },
    );
  });
});

describe('team membership mirrors the owner', () => {
  it('joins with invites and new teams, leaves with the owner, and can be managed alone', () => {
    const zoe = createUser(ctx.db, { username: 'zoe' });
    const zoeAgent = ensureAgent(ctx.db, zoe.id);
    const invite = createInvite(ctx.deps, person(ethan), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    acceptInvite(ctx.deps, person(zoe), invite.code);
    expect(getMembership(ctx.db.orm, team.team.id, zoeAgent)?.roleIds).toEqual([]);

    // Admins can give the agent roles, and remove it on its own…
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_LABELS'] });
    assignRole(ctx.deps, person(ethan), team.team.id, zoeAgent, role.id);
    expect(getMembership(ctx.db.orm, team.team.id, zoeAgent)?.roleIds).toEqual([role.id]);
    removeMember(ctx.deps, person(ethan), team.team.id, zoeAgent);
    expect(getMembership(ctx.db.orm, team.team.id, zoe.id)).not.toBeNull();
    expect(getMembership(ctx.db.orm, team.team.id, zoeAgent)).toBeNull();
    // …and it goes and comes back with its owner.
    leaveTeam(ctx.deps, person(zoe), team.team.id);
    acceptInvite(ctx.deps, person(zoe), invite.code);
    expect(getMembership(ctx.db.orm, team.team.id, zoeAgent)?.roleIds).toEqual([]);
    removeMember(ctx.deps, person(ethan), team.team.id, zoe.id);
    expect(getMembership(ctx.db.orm, team.team.id, zoeAgent)).toBeNull();

    // A team made on the web: its owner's agent is a plain member.
    const created = createTeamService(ctx.deps, person(zoe), { name: 'Zoe Co' });
    expect(getMembership(ctx.db.orm, created.id, zoeAgent)).toMatchObject({
      isOwner: false,
      roleIds: [],
    });
  });

  it('refuses an agent removing the person it works for', () => {
    const ethanAgent = keyActor(ethan);
    ctx.db.orm.update(s.team).set({ ownerId: mia.id }).where(eq(s.team.id, team.team.id)).run();
    assignRole(ctx.deps, person(mia), team.team.id, ethan.id, team.adminRole.id);
    assignRole(ctx.deps, person(mia), team.team.id, ethanAgent.userId, team.adminRole.id);
    expect(() => removeMember(ctx.deps, ethanAgent, team.team.id, ethan.id)).toThrow(
      /person it works for/,
    );
  });
});

describe('permission cap', () => {
  it('limits an agent to what its owner may do, and never makes it the owner', async () => {
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    const miaAgent = createAgent(ctx.db, mia.id);
    // The agent is an admin, Mia isn't: the agent can do only what Mia can.
    assignRole(ctx.deps, person(ethan), team.team.id, miaAgent.id, team.adminRole.id);
    const membership = getMembership(ctx.db.orm, team.team.id, miaAgent.id);
    expect(membership?.isOwner).toBe(false);
    expect(membership?.permissions).not.toContain('ADMINISTRATOR');
    expect(membership?.permissions).toContain('CREATE_TASKS');
    const forbidden = await ctx.app.request(
      `/api/teams/${team.team.id}/projects`,
      json('POST', { name: 'Docs' }, bearer(key)),
    );
    expect(forbidden.status).toBe(403);

    // Once Mia may manage projects, so may her agent.
    const managers = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_PROJECTS'] });
    assignRole(ctx.deps, person(ethan), team.team.id, mia.id, managers.id);
    const allowed = await ctx.app.request(
      `/api/teams/${team.team.id}/projects`,
      json('POST', { name: 'Docs' }, bearer(key)),
    );
    expect(allowed.status).toBe(201);

    // The owner's agent administers but never owns.
    const ethanAgent = createAgent(ctx.db, ethan.id);
    assignRole(ctx.deps, person(ethan), team.team.id, ethanAgent.id, team.adminRole.id);
    expect(getMembership(ctx.db.orm, team.team.id, ethanAgent.id)).toMatchObject({
      isOwner: false,
      permissions: expect.arrayContaining(['ADMINISTRATOR']) as unknown,
    });
  });

  it('counts a person and their agent as one author', () => {
    const task = createTask(ctx.db, { project: project.project });
    const miaAgent = keyActor(mia);
    const byAgent = createReply(ctx.deps, miaAgent, {
      parentType: 'task',
      parentId: task.id,
      body: 'agent draft',
    });
    // Mia can fix what her agent wrote (no EDIT_ANY_CONTENT needed), and the other way round.
    expect(editReply(ctx.deps, person(mia), byAgent.id, { body: 'fixed' }).body).toBe('fixed');
    const byMia = createReply(ctx.deps, person(mia), {
      parentType: 'task',
      parentId: task.id,
      body: 'mine',
    });
    deleteReply(ctx.deps, miaAgent, byMia.id);
    // Nobody else can.
    const zoe = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: zoe.id });
    expect(() => editReply(ctx.deps, person(zoe), byAgent.id, { body: 'x' })).toThrow(
      /your own content/,
    );
  });
});

describe('pause', () => {
  function taskPath() {
    return `/api/projects/${project.project.id}/tasks`;
  }

  it('lets a paused agent read but not write, over REST and MCP; its owner is unaffected', async () => {
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    const cookie = web(ctx, await signIn(ctx, mia));
    const pause = await ctx.app.request('/api/me/agent', json('PATCH', { paused: true }, cookie));
    expect(agentSettingsSchema.parse(await pause.json()).pausedAt).not.toBeNull();

    expect((await ctx.app.request(taskPath(), { headers: bearer(key) })).status).toBe(200);
    const write = await ctx.app.request(taskPath(), json('POST', { title: 'X' }, bearer(key)));
    expect(write.status).toBe(423);
    const error = apiErrorSchema.parse(await write.json()).error;
    expect(error).toMatchObject({ code: 'agents_paused' });
    expect(error.message).toMatch(/Mia paused this agent/);
    expect((await ctx.app.request(taskPath(), json('POST', { title: 'Y' }, cookie))).status).toBe(
      201,
    );

    const server = new McpServer({ name: 'test', version: '0' });
    registerTools(server, {
      deps: ctx.deps,
      actor: keyActor(mia),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientTransport);
    const read = await client.callTool({ name: 'list_tasks', arguments: { project: 'API' } });
    expect(read.isError).toBeFalsy();
    const created = await client.callTool({
      name: 'create_task',
      arguments: { project: 'API', title: 'Z' },
    });
    expect(created.isError).toBe(true);
    expect(JSON.stringify(created.content)).toMatch(/agents_paused/);
    await client.close();

    await ctx.app.request('/api/me/agent', json('PATCH', { paused: false }, cookie));
    expect(
      (await ctx.app.request(taskPath(), json('POST', { title: 'W' }, bearer(key)))).status,
    ).toBe(201);
    expect(
      ctx.db.orm
        .select({ action: s.activity.action })
        .from(s.activity)
        .where(and(eq(s.activity.actorId, mia.id), isNull(s.activity.teamId)))
        .all()
        .map((row) => row.action)
        .filter((action) => action === 'user.agent_settings_changed'),
    ).toHaveLength(2);
  });

  it('pauses every agent of a team or a project, for those who may manage it', async () => {
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const task = createTask(ctx.db, { project: project.project });
    const owner = web(ctx, await signIn(ctx, ethan));
    const miaWeb = web(ctx, await signIn(ctx, mia, 'other password 1'));
    const react = () =>
      ctx.app.request(
        '/api/reactions',
        json('PUT', { targetType: 'task', targetId: task.id, emoji: '👍' }, bearer(key)),
      );

    // Project: MANAGE_PROJECTS (Mia hasn't got it).
    expect(
      (
        await ctx.app.request(
          `/api/projects/${project.project.id}`,
          json('PATCH', { agentsPaused: true }, miaWeb),
        )
      ).status,
    ).toBe(403);
    const paused = await ctx.app.request(
      `/api/projects/${project.project.id}`,
      json('PATCH', { agentsPaused: true }, owner),
    );
    expect(
      ((await paused.json()) as { agentsPausedAt: string | null }).agentsPausedAt,
    ).not.toBeNull();
    const refused = await ctx.app.request(taskPath(), json('POST', { title: 'X' }, bearer(key)));
    expect(refused.status).toBe(423);
    expect(await errorCode(refused)).toBe('agents_paused');
    expect((await react()).status).toBe(423);
    const elsewhere = await ctx.app.request(
      `/api/projects/${other.project.id}/tasks`,
      json('POST', { title: 'X' }, bearer(key)),
    );
    expect(elsewhere.status).toBe(201);
    await ctx.app.request(
      `/api/projects/${project.project.id}`,
      json('PATCH', { agentsPaused: false }, owner),
    );
    expect((await react()).status).toBe(200);

    // Team: MANAGE_TEAM.
    const teamPaused = await ctx.app.request(
      `/api/teams/${team.team.id}`,
      json('PATCH', { agentsPaused: true }, owner),
    );
    expect(
      ((await teamPaused.json()) as { agentsPausedAt: string | null }).agentsPausedAt,
    ).not.toBeNull();
    expect(
      (
        await ctx.app.request(
          `/api/projects/${other.project.id}/tasks`,
          json('POST', { title: 'Y' }, bearer(key)),
        )
      ).status,
    ).toBe(423);
    // People are never paused.
    expect(
      (
        await ctx.app.request(
          `/api/projects/${other.project.id}/tasks`,
          json('POST', { title: 'Y' }, miaWeb),
        )
      ).status,
    ).toBe(201);
    const audit = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'team.updated'))
      .all()
      .at(-1);
    expect(audit?.changes).toEqual({ agentsPaused: { from: false, to: true } });
  });

  it('keeps agent settings to their owner on the web', async () => {
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    expect((await ctx.app.request('/api/me/agent', { headers: bearer(key) })).status).toBe(403);
    expect((await ctx.app.request('/api/me/api-keys', { headers: bearer(key) })).status).toBe(403);
    const cookie = web(ctx, await signIn(ctx, mia));
    const settings = agentSettingsSchema.parse(
      await (await ctx.app.request('/api/me/agent', { headers: cookie })).json(),
    );
    expect(settings).toMatchObject({
      agent: { username: 'mia-ai', name: 'Mia AI', kind: 'agent' },
      pausedAt: null,
      notifications: 'needs_me',
    });
    const bad = await ctx.app.request(
      '/api/me/agent',
      json('PATCH', { notifications: 'sometimes' }, cookie),
    );
    expect(bad.status).toBe(400);
  });
});

describe('notifications', () => {
  function inbox(user: UserRow) {
    return ctx.db.orm
      .select({ type: s.notification.type, actorId: s.notification.actorId })
      .from(s.notification)
      .where(eq(s.notification.userId, user.id))
      .all();
  }

  function setLevel(user: UserRow, level: 'all' | 'needs_me' | 'none') {
    ctx.db.orm
      .update(s.user)
      .set({ agentNotifications: level })
      .where(eq(s.user.id, user.id))
      .run();
  }

  it('never go to agents, and reach owners by their agent notification level', () => {
    const task = createTask(ctx.db, { project: project.project, authorId: ethan.id });
    const miaAgent = keyActor(mia);
    const ethanAgent = createAgent(ctx.db, ethan.id);
    const say = (actor: Actor, body: string) =>
      createReply(ctx.deps, actor, { parentType: 'task', parentId: task.id, body });

    say(person(ethan), 'watching this one');
    // Mentioning an agent member notifies nobody (it gets a job, collected with start_listener).
    say(person(mia), '@ethan-ai please look');
    expect(
      ctx.db.orm
        .select()
        .from(s.notification)
        .where(eq(s.notification.userId, ethanAgent.id))
        .all(),
    ).toEqual([]);
    ctx.db.orm.delete(s.notification).run();

    // needs_me (default): Mia hears her agent only when it mentions her.
    say(person(mia), 'following along');
    say(miaAgent, 'a plain reply');
    expect(inbox(mia)).toEqual([]);
    say(miaAgent, '@mia done, have a look');
    expect(inbox(mia)).toEqual([{ type: 'mention', actorId: miaAgent.userId }]);
    expect(inbox(ethan).map((n) => n.type)).toEqual(['reply', 'reply', 'reply']);

    // all: whatever the agent's action notifies anyone of, Mia gets too.
    ctx.db.orm.delete(s.notification).run();
    setLevel(mia, 'all');
    say(miaAgent, 'another reply');
    expect(inbox(mia)).toEqual([{ type: 'reply', actorId: miaAgent.userId }]);

    // none: nothing from her agent, not even a mention.
    ctx.db.orm.delete(s.notification).run();
    setLevel(mia, 'none');
    say(miaAgent, '@mia ping');
    say(miaAgent, 'and a reply');
    expect(inbox(mia)).toEqual([]);
    expect(inbox(ethan)).toHaveLength(2);
  });
});
