import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAction } from '@shared/constants';
import type { LiveEvent } from '@shared/events';
import {
  agentActionListResponseSchema,
  agentActionRequestSchema,
  pendingApprovalResponseSchema,
} from '@shared/schemas/agentActions';
import { teamDetailSchema } from '@shared/schemas/teams';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { registerTools } from '../mcp/tools';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  json,
  setAgentSignoff,
  signIn,
  web,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { getMembership } from './access';
import {
  approveActionRequest,
  denyActionRequest,
  expireActionRequests,
  getActionRequest,
  listActionRequests,
} from './agentActions';
import { createInvite } from './invites';
import { createLabel } from './labels';
import { listNotifications } from './notifications';
import { createReply } from './replies';
import { createStatus } from './statuses';
import { deleteTeam } from './teams';

/**
 * Human sign-off for agents' destructive actions (docs/design/agents-and-pipelines.md §6): each
 * destructive action through REST and MCP becomes a request for the owner, who approves (it runs,
 * checked again) or denies it; requests expire; owner-only actions run as the owner.
 */

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let zoe: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let key: string;
let keyId: string;
let agentId: string;
let events: LiveEvent[];
let clients: Client[];

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  zoe = createUser(ctx.db, { username: 'zoe', name: 'Zoe' });
  team = createTeam(ctx.db, { ownerId: ethan.id, slug: 'acme', name: 'Acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id, roleIds: [team.adminRole.id] });
  addMember(ctx.db, { teamId: team.team.id, userId: zoe.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'BAT', name: 'Baton' });
  const created = createApiKey(ctx.db, { userId: ethan.id, name: 'MSI' });
  key = created.key;
  keyId = created.apiKey.id;
  // Ethan's agent acts with Ethan's permissions (Admin), except owner-only actions.
  agentId = giveAgentOwnerRoles(ctx.db, ethan.id).id;
  // Sign-off requests reach the owner whatever this says.
  ctx.db.orm
    .update(s.user)
    .set({ agentNotifications: 'none' })
    .where(eq(s.user.id, ethan.id))
    .run();
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

function agent(): Actor {
  return agentActor(ctx.db, ethan.id, { id: keyId, name: 'MSI' });
}

async function mcpAs(actor: Actor) {
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, { deps: ctx.deps, actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
}

/** A request with the API key of Ethan (acting as his agent). */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return await ctx.app.request(path, {
    ...init,
    headers: { ...bearer(key), ...(init.headers as Record<string, string> | undefined) },
  });
}

function requestRow(requestId: string) {
  return ctx.db.orm
    .select()
    .from(s.agentActionRequest)
    .where(eq(s.agentActionRequest.id, requestId))
    .get();
}

function ownerNotifications() {
  return ctx.db.orm
    .select()
    .from(s.notification)
    .where(
      and(eq(s.notification.userId, ethan.id), eq(s.notification.type, 'agent_action_request')),
    )
    .all();
}

function activity(action: string) {
  return ctx.db.orm.select().from(s.activity).where(eq(s.activity.action, action)).all();
}

// ---------------------------------------------------------------------------------------------
// Every destructive action, through REST and MCP
// ---------------------------------------------------------------------------------------------

interface Arranged {
  rest: () => Promise<Response>;
  mcp: [string, Record<string, unknown>];
  /** Has the action happened? */
  done: () => boolean;
  /** Words the request's summary contains. */
  summary: RegExp;
}

const CASES: Record<AgentAction, () => Arranged> = {
  delete_task: () => {
    const task = createTask(ctx.db, { project: project.project, title: 'Fix login' });
    return {
      rest: () => request(`/api/tasks/${task.id}`, { method: 'DELETE' }),
      mcp: ['delete_task', { task: `BAT-${task.number}` }],
      done: () =>
        ctx.db.orm.select().from(s.task).where(eq(s.task.id, task.id)).get()?.deletedAt != null,
      summary: new RegExp(`delete BAT-${task.number} “Fix login”`),
    };
  },
  delete_issue: () => {
    const issue = createIssue(ctx.db, { project: project.project, title: 'Crash' });
    return {
      rest: () => request(`/api/issues/${issue.id}`, { method: 'DELETE' }),
      mcp: ['delete_issue', { issue: `BAT#${issue.number}` }],
      done: () =>
        ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get()?.deletedAt != null,
      summary: new RegExp(`delete BAT#${issue.number} “Crash”`),
    };
  },
  delete_project: () => {
    const old = createProject(ctx.db, { teamId: team.team.id, key: 'OLD', name: 'Old' }).project;
    return {
      rest: () => request(`/api/projects/${old.id}`, { method: 'DELETE' }),
      mcp: ['delete_project', { project: 'OLD' }],
      done: () =>
        ctx.db.orm.select().from(s.project).where(eq(s.project.id, old.id)).get()?.deletedAt !=
        null,
      summary: /delete the project OLD “Old”/,
    };
  },
  delete_status: () => {
    const review = createStatus(ctx.deps, person(ethan), project.project.id, {
      name: 'Review',
    });
    const open = project.statuses[0];
    if (!open) throw new Error('no status');
    return {
      rest: () => request(`/api/statuses/${review.id}?moveTo=${open.id}`, { method: 'DELETE' }),
      mcp: ['delete_status', { project: 'BAT', status: 'Review', moveTo: open.name }],
      done: () => !ctx.db.orm.select().from(s.status).where(eq(s.status.id, review.id)).get(),
      summary: /delete the status “Review” in BAT/,
    };
  },
  delete_label: () => {
    const label = createLabel(ctx.deps, person(ethan), project.project.id, { name: 'bug' });
    return {
      rest: () => request(`/api/labels/${label.id}`, { method: 'DELETE' }),
      mcp: ['delete_label', { project: 'BAT', label: 'bug' }],
      done: () => !ctx.db.orm.select().from(s.label).where(eq(s.label.id, label.id)).get(),
      summary: /delete the label “bug” in BAT/,
    };
  },
  delete_reply: () => {
    const task = createTask(ctx.db, { project: project.project });
    const reply = createReply(ctx.deps, person(mia), {
      parentType: 'task',
      parentId: task.id,
      body: 'Mia was here',
    });
    return {
      rest: () => request(`/api/replies/${reply.id}`, { method: 'DELETE' }),
      mcp: ['delete_reply', { reply: reply.id }],
      done: () =>
        ctx.db.orm.select().from(s.reply).where(eq(s.reply.id, reply.id)).get()?.deletedAt != null,
      summary: /delete Mia’s reply on BAT-\d+ “Mia was here”/,
    };
  },
  delete_attachment: () => {
    const task = createTask(ctx.db, { project: project.project });
    const file = ctx.db.orm
      .insert(s.attachment)
      .values({
        teamId: team.team.id,
        uploaderId: mia.id,
        parentType: 'task',
        parentId: task.id,
        filename: 'notes.txt',
        mimeType: 'text/plain',
        size: 1,
        sha256: 'x',
        storagePath: 'x/notes.txt',
      })
      .returning()
      .get();
    return {
      rest: () => request(`/api/attachments/${file.id}`, { method: 'DELETE' }),
      mcp: ['delete_attachment', { attachment: file.id }],
      done: () =>
        ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, file.id)).get()
          ?.deletedAt != null,
      summary: /delete the file “notes.txt” uploaded by Mia/,
    };
  },
  delete_role: () => {
    const role = createRole(ctx.db, { teamId: team.team.id, name: 'Design', slug: 'design' });
    return {
      rest: () => request(`/api/teams/${team.team.id}/roles/${role.id}`, { method: 'DELETE' }),
      mcp: ['delete_role', { team: 'acme', role: 'design' }],
      done: () => !ctx.db.orm.select().from(s.role).where(eq(s.role.id, role.id)).get(),
      summary: /delete the role @Design in Acme/,
    };
  },
  remove_member: () => ({
    rest: () => request(`/api/teams/${team.team.id}/members/${zoe.id}`, { method: 'DELETE' }),
    mcp: ['remove_member', { team: 'acme', user: 'zoe' }],
    done: () => getMembership(ctx.db.orm, team.team.id, zoe.id) === null,
    summary: /remove Zoe \(@zoe\) from Acme/,
  }),
  revoke_invite: () => {
    const invite = createInvite(ctx.deps, person(mia), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    return {
      rest: () => request(`/api/teams/${team.team.id}/invites/${invite.id}`, { method: 'DELETE' }),
      mcp: ['revoke_invite', { team: 'acme', invite: invite.id }],
      done: () =>
        ctx.db.orm.select().from(s.invite).where(eq(s.invite.id, invite.id)).get()?.revokedAt !=
        null,
      summary: /revoke the invite link .* to Acme created by Mia/,
    };
  },
  delete_team: () => ({
    rest: () => request(`/api/teams/${team.team.id}`, { method: 'DELETE' }),
    mcp: ['delete_team', { team: 'acme', confirm: 'acme' }],
    done: () =>
      ctx.db.orm.select().from(s.team).where(eq(s.team.id, team.team.id)).get()?.deletedAt != null,
    summary: /delete the team Acme/,
  }),
  restore_team: () => {
    deleteTeam(ctx.deps, person(ethan), team.team.id);
    return {
      rest: () => request(`/api/teams/${team.team.id}/restore`, { method: 'POST' }),
      mcp: ['restore_team', { team: team.team.id }],
      done: () =>
        ctx.db.orm.select().from(s.team).where(eq(s.team.id, team.team.id)).get()?.deletedAt ===
        null,
      summary: /restore the team Acme from Trash/,
    };
  },
  transfer_team_ownership: () => ({
    rest: () => request(`/api/teams/${team.team.id}/transfer`, json('POST', { userId: mia.id })),
    mcp: ['transfer_team_ownership', { team: 'acme', user: 'mia', confirm: 'acme' }],
    done: () =>
      ctx.db.orm.select().from(s.team).where(eq(s.team.id, team.team.id)).get()?.ownerId === mia.id,
    summary: /make Mia \(@mia\) the owner of Acme/,
  }),
};

const ACTIONS = Object.keys(CASES) as AgentAction[];

describe.each(['REST', 'MCP'] as const)('each destructive action through %s', (transport) => {
  it.each(ACTIONS)('%s waits for the owner, then runs once approved', async (action) => {
    const arranged = CASES[action]();
    let pending;
    if (transport === 'REST') {
      const res = await arranged.rest();
      expect(res.status).toBe(202);
      pending = pendingApprovalResponseSchema.parse(await res.json());
    } else {
      const client = await mcpAs(agent());
      const [tool, args] = arranged.mcp;
      pending = pendingApprovalResponseSchema.parse(await callTool(client, tool, args));
    }
    expect(pending.message).toMatch(/Nothing changed yet: Ethan has to approve/);
    expect(arranged.done()).toBe(false);

    const row = requestRow(pending.requestId);
    expect(row).toMatchObject({
      action,
      status: 'pending',
      agentUserId: agentId,
      ownerId: ethan.id,
      source: transport === 'REST' ? 'api' : 'mcp',
    });
    expect(row?.payload.summary).toMatch(arranged.summary);
    // Always delivered, although Ethan hears nothing else from his agent ('none').
    const [notification] = ownerNotifications();
    expect(notification).toMatchObject({
      entityType: 'agent_action_request',
      entityId: pending.requestId,
      actorId: agentId,
      title: expect.stringMatching(/^Ethan AI wants to /) as unknown,
    });
    expect(events.some((event) => event.type === 'agent_action.changed')).toBe(true);

    const approved = approveActionRequest(ctx.deps, person(ethan), pending.requestId);
    expect(approved.error).toBeNull();
    expect(approved.status).toBe('approved');
    expect(arranged.done()).toBe(true);
    expect(ownerNotifications()[0]?.readAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------------------------
// The team setting
// ---------------------------------------------------------------------------------------------

describe('the team setting', () => {
  it('lets agents act directly when off, except owner-only actions', async () => {
    setAgentSignoff(ctx.db, team.team.id, false);
    const task = CASES.delete_task();
    expect((await task.rest()).status).toBe(200);
    expect(task.done()).toBe(true);
    const client = await mcpAs(agent());
    const member = CASES.remove_member();
    expect(await callTool(client, ...member.mcp)).toEqual({ ok: true });
    expect(member.done()).toBe(true);

    // Agents never own teams: deleting one is always the owner's call.
    const res = await CASES.delete_team().rest();
    expect(res.status).toBe(202);
    expect(ctx.db.orm.select().from(s.agentActionRequest).all()).toHaveLength(1);
  });

  it('is on by default, and only people with Manage team can change it', async () => {
    const res = await request(`/api/teams/${team.team.id}`);
    expect(teamDetailSchema.parse(await res.json()).agentSignoff).toBe(true);

    // An agent may not switch off its own check, even with Admin.
    const byAgent = await request(
      `/api/teams/${team.team.id}`,
      json('PATCH', { agentSignoff: false }),
    );
    expect(byAgent.status).toBe(403);

    const zoeWeb = web(ctx, await signIn(ctx, zoe));
    const byZoe = await ctx.app.request(
      `/api/teams/${team.team.id}`,
      json('PATCH', { agentSignoff: false }, zoeWeb),
    );
    expect(byZoe.status).toBe(403);

    const ethanWeb = web(ctx, await signIn(ctx, ethan));
    const byOwner = await ctx.app.request(
      `/api/teams/${team.team.id}`,
      json('PATCH', { agentSignoff: false }, ethanWeb),
    );
    expect(teamDetailSchema.parse(await byOwner.json()).agentSignoff).toBe(false);
    expect(activity('team.updated').at(-1)?.changes).toEqual({
      agentSignoff: { from: true, to: false },
    });
  });

  it('needs no sign-off for the agent’s own replies and invite links', async () => {
    const task = createTask(ctx.db, { project: project.project });
    const own = createReply(ctx.deps, agent(), {
      parentType: 'task',
      parentId: task.id,
      body: 'My own note',
    });
    expect((await request(`/api/replies/${own.id}`, { method: 'DELETE' })).status).toBe(200);
    // Its owner's count as its own (agents A).
    const invite = createInvite(ctx.deps, person(ethan), team.team.id, {
      expiresIn: '7d',
      maxUses: null,
    });
    const res = await request(`/api/teams/${team.team.id}/invites/${invite.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(ctx.db.orm.select().from(s.agentActionRequest).all()).toEqual([]);
  });

  it('refuses without asking what the agent may not do anyway', async () => {
    // Zoe has @everyone only: her agent can't delete Mia's task, so nothing is asked.
    const zoeKey = createApiKey(ctx.db, { userId: zoe.id }).key;
    const task = createTask(ctx.db, { project: project.project, authorId: mia.id });
    const res = await ctx.app.request(`/api/tasks/${task.id}`, {
      method: 'DELETE',
      headers: bearer(zoeKey),
    });
    expect(res.status).toBe(403);
    // Nor can Mia's agent ask to delete a team Mia doesn't own.
    const miaKey = createApiKey(ctx.db, { userId: mia.id }).key;
    giveAgentOwnerRoles(ctx.db, mia.id);
    const team = await ctx.app.request(`/api/teams/${task.teamId}`, {
      method: 'DELETE',
      headers: bearer(miaKey),
    });
    expect(team.status).toBe(403);
    expect(ctx.db.orm.select().from(s.agentActionRequest).all()).toEqual([]);
  });

  it('asks once for the same action, and not at all while agents are paused', async () => {
    const task = CASES.delete_task();
    const first = pendingApprovalResponseSchema.parse(await (await task.rest()).json());
    const second = pendingApprovalResponseSchema.parse(await (await task.rest()).json());
    expect(second.requestId).toBe(first.requestId);
    expect(ownerNotifications()).toHaveLength(1);

    ctx.db.orm
      .update(s.team)
      .set({ agentsPausedAt: new Date() })
      .where(eq(s.team.id, team.team.id))
      .run();
    const paused = await CASES.delete_issue().rest();
    expect(paused.status).toBe(423);
    expect(ctx.db.orm.select().from(s.agentActionRequest).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------------------------

async function ask(action: AgentAction) {
  const arranged = CASES[action]();
  const res = await arranged.rest();
  expect(res.status).toBe(202);
  const { requestId } = pendingApprovalResponseSchema.parse(await res.json());
  return { ...arranged, requestId };
}

describe('deciding', () => {
  it('lets only the owner decide, in the web app', async () => {
    const { requestId, done } = await ask('delete_task');

    // Mia (another person) doesn't see it; the agent can't approve its own request.
    const miaWeb = web(ctx, await signIn(ctx, mia));
    const byMia = await ctx.app.request(
      `/api/agent-actions/${requestId}/approve`,
      json('POST', {}, miaWeb),
    );
    expect(byMia.status).toBe(404);
    const byAgent = await request(`/api/agent-actions/${requestId}/approve`, { method: 'POST' });
    expect(byAgent.status).toBe(403);
    expect(done()).toBe(false);

    // The agent can read its own request.
    const read = await request(`/api/agent-actions/${requestId}`);
    expect(agentActionRequestSchema.parse(await read.json()).status).toBe('pending');

    const ethanWeb = web(ctx, await signIn(ctx, ethan));
    const list = agentActionListResponseSchema.parse(
      await (
        await ctx.app.request('/api/agent-actions?status=pending', { headers: ethanWeb })
      ).json(),
    );
    expect(list.items.map((item) => item.id)).toEqual([requestId]);
    expect(list.items[0]).toMatchObject({
      agent: { id: agentId },
      via: { keyId, keyName: 'MSI' },
      team: { slug: 'acme' },
      runsAsOwner: false,
    });

    const res = await ctx.app.request(
      `/api/agent-actions/${requestId}/approve`,
      json('POST', {}, ethanWeb),
    );
    expect(res.status).toBe(200);
    expect(agentActionRequestSchema.parse(await res.json())).toMatchObject({
      status: 'approved',
      result: { ok: true },
      decidedBy: { id: ethan.id },
    });
    expect(done()).toBe(true);
    // It ran as the agent, through the key it asked with.
    expect(activity('task.deleted')[0]).toMatchObject({
      actorId: agentId,
      source: 'api',
      viaKeyId: keyId,
    });

    const again = await ctx.app.request(
      `/api/agent-actions/${requestId}/deny`,
      json('POST', {}, ethanWeb),
    );
    expect(again.status).toBe(409);
  });

  it('denies: nothing runs and the inbox item is answered', async () => {
    const { requestId, done } = await ask('remove_member');
    const denied = denyActionRequest(ctx.deps, person(ethan), requestId);
    expect(denied).toMatchObject({ status: 'denied', decidedBy: { id: ethan.id } });
    expect(done()).toBe(false);
    expect(ownerNotifications()[0]?.readAt).toBeInstanceOf(Date);
    expect(() => approveActionRequest(ctx.deps, person(ethan), requestId)).toThrow(
      /already denied/,
    );
    expect(
      events.filter((event) => event.type === 'agent_action.changed').map((event) => event.userId),
    ).toEqual([ethan.id, ethan.id]);
  });

  it('checks permissions again when it runs: revoked meanwhile → failed', async () => {
    const { requestId, done } = await ask('delete_project');
    // An admin takes the agent's roles away before Ethan gets to it.
    ctx.db.orm
      .delete(s.memberRole)
      .where(and(eq(s.memberRole.teamId, team.team.id), eq(s.memberRole.userId, agentId)))
      .run();
    const result = approveActionRequest(ctx.deps, person(ethan), requestId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'forbidden' });
    expect(done()).toBe(false);
  });

  it('fails when the target is gone by then', async () => {
    const { requestId } = await ask('delete_task');
    const row = requestRow(requestId);
    ctx.db.orm
      .update(s.task)
      .set({ deletedAt: new Date() })
      .where(eq(s.task.id, String(row?.payload.input.taskId)))
      .run();
    expect(approveActionRequest(ctx.deps, person(ethan), requestId)).toMatchObject({
      status: 'failed',
      error: { code: 'not_found', message: 'Task not found' },
    });
  });

  it('runs owner-only actions as the owner', async () => {
    const { requestId, done } = await ask('delete_team');
    const request = getActionRequest(ctx.deps, person(ethan), requestId);
    expect(request.runsAsOwner).toBe(true);
    approveActionRequest(ctx.deps, person(ethan), requestId);
    expect(done()).toBe(true);
    expect(activity('team.deleted')[0]).toMatchObject({
      actorId: ethan.id,
      source: 'web',
      viaKeyId: null,
    });
  });

  it('shows a restore request for a team in Trash in the owner’s inbox', async () => {
    const { requestId, done } = await ask('restore_team');
    const inbox = listNotifications(ctx.deps, person(ethan), { limit: 20 });
    expect(inbox.items.map((item) => item.entityId)).toContain(requestId);
    approveActionRequest(ctx.deps, person(ethan), requestId);
    expect(done()).toBe(true);
  });
});

describe('expiry', () => {
  it('expires pending requests after 7 days', async () => {
    const { requestId, done } = await ask('delete_issue');
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(expireActionRequests(ctx.deps, new Date())).toBe(0);
    expect(expireActionRequests(ctx.deps, later)).toBe(1);
    expect(requestRow(requestId)?.status).toBe('expired');
    expect(ownerNotifications()[0]?.readAt).toBeInstanceOf(Date);
    expect(() => approveActionRequest(ctx.deps, person(ethan), requestId)).toThrow(
      /already expired/,
    );
    expect(done()).toBe(false);
  });

  it('treats an overdue request as expired before the job runs', async () => {
    const { requestId, done } = await ask('delete_issue');
    ctx.db.orm
      .update(s.agentActionRequest)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(s.agentActionRequest.id, requestId))
      .run();
    expect(listActionRequests(ctx.deps, person(ethan), { status: 'pending', limit: 50 })).toEqual({
      items: [],
    });
    expect(() => approveActionRequest(ctx.deps, person(ethan), requestId)).toThrow(/expired/);
    expect(requestRow(requestId)?.status).toBe('expired');
    expect(done()).toBe(false);
  });
});

describe('get_action_request', () => {
  it('tells the agent the outcome; other agents can’t see it', async () => {
    const client = await mcpAs(agent());
    const arranged = CASES.delete_task();
    const pending = pendingApprovalResponseSchema.parse(await callTool(client, ...arranged.mcp));
    expect(await callTool(client, 'get_action_request', { id: pending.requestId })).toMatchObject({
      status: 'pending',
      action: 'delete_task',
    });
    approveActionRequest(ctx.deps, person(ethan), pending.requestId);
    expect(await callTool(client, 'get_action_request', { id: pending.requestId })).toMatchObject({
      status: 'approved',
      result: { ok: true },
    });

    const miaKey = createApiKey(ctx.db, { userId: mia.id });
    const other = await mcpAs(agentActor(ctx.db, mia.id, { id: miaKey.apiKey.id, name: 'x' }));
    const result = await other.callTool({
      name: 'get_action_request',
      arguments: { id: pending.requestId },
    });
    expect(result.isError).toBe(true);
  });
});
