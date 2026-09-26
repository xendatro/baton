import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { Actor } from './context';
import { registerTools } from './mcp/tools';
import {
  bearer,
  createApiKey,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from './test/helpers';

/**
 * Cross-module contracts end to end, through the real REST routes and MCP tools of several modules:
 * teams ↔ account (deleted teams, account deletion), teams/projects/issues ↔ admin (Trash handlers,
 * restore_item, audit-log facets), issues ↔ core (replies, search, notifications), issues ↔ tasks ↔
 * work (create task from issue, auto-resolve, notifications, My tasks and dashboard) and the live
 * events the web client invalidates on.
 */

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let ownerKey: string;
let memberKey: string;
let clients: Client[];
let events: LiveEvent[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'ethan' });
  member = createUser(ctx.db, { username: 'caden' });
  ownerKey = createApiKey(ctx.db, { userId: owner.id, name: 'Claude on laptop' }).key;
  memberKey = createApiKey(ctx.db, { userId: member.id, name: 'Codex' }).key;
  clients = [];
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function call<T = Record<string, unknown>>(
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const init =
    body === undefined ? { method, headers: bearer(key) } : json(method, body, bearer(key));
  const res = await ctx.app.request(`/api${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}

async function mcpAs(user: UserRow) {
  const actor: Actor = { userId: user.id, source: 'mcp', key: { id: 'key', name: 'Claude' } };
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, { deps: ctx.deps, actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    return result.structuredContent as Record<string, unknown>;
  };
}

/** Creates a team (owner) with the member joined through an invite link, and one project. */
async function setup() {
  const team = await call<{ id: string; slug: string }>(ownerKey, 'POST', '/teams', {
    name: 'Northwind',
  });
  expect(team.status).toBe(201);
  const invite = await call<{ code: string }>(
    ownerKey,
    'POST',
    `/teams/${team.body.id}/invites`,
    {},
  );
  expect(invite.status).toBe(201);
  expect((await call(memberKey, 'POST', `/invites/${invite.body.code}/accept`)).status).toBe(200);
  const project = await call<{ id: string; key: string }>(
    ownerKey,
    'POST',
    `/teams/${team.body.id}/projects`,
    { name: 'Web App' },
  );
  expect(project.status).toBe(201);
  return { team: team.body, project: project.body };
}

describe('teams ↔ account: deleted teams', () => {
  it('lists a deleted team for its owner, blocks account deletion, and restores through restore_item', async () => {
    const { team } = await setup();
    expect((await call(ownerKey, 'DELETE', `/teams/${team.id}`)).status).toBe(200);

    const deleted = await call<{ items: Array<{ id: string; slug: string }> }>(
      ownerKey,
      'GET',
      '/me/deleted-teams',
    );
    expect(deleted.body.items.map((item) => item.id)).toEqual([team.id]);
    // Other members don't own it, and no longer see it.
    expect(
      (await call<{ items: unknown[] }>(memberKey, 'GET', '/me/deleted-teams')).body.items,
    ).toEqual([]);
    expect((await call(memberKey, 'GET', `/teams/${team.id}`)).status).toBe(404);

    // The account page's delete is blocked while the owner has the team in Trash.
    const cookie = await signIn(ctx, owner, 'password123');
    const blocked = await ctx.app.request(
      '/api/me/delete',
      json('POST', { password: 'password123' }, web(ctx, cookie)),
    );
    expect(blocked.status).toBe(409);
    const conflict = (await blocked.json()) as {
      error: { details: { teams: Array<{ id: string }> } };
    };
    expect(conflict.error.details.teams.map((item) => item.id)).toEqual([team.id]);

    // The admin module's restore_item restores teams through the teams module's Trash handler.
    const tool = await mcpAs(owner);
    const restored = await tool('restore_item', { item: team.id });
    expect(restored).toMatchObject({ type: 'team', id: team.id });
    expect(restored.url).toBe(`${ctx.env.baseUrl}/t/${team.slug}`);
    expect((await call(memberKey, 'GET', `/teams/${team.id}`)).status).toBe(200);
    expect(
      (await call<{ items: unknown[] }>(ownerKey, 'GET', '/me/deleted-teams')).body.items,
    ).toEqual([]);
  });

  it('restores from account settings (POST /teams/:id/restore) and tells the owner’s other tabs', async () => {
    const { team } = await setup();
    await call(ownerKey, 'DELETE', `/teams/${team.id}`);
    events.length = 0;
    const restored = await call<{ id: string }>(ownerKey, 'POST', `/teams/${team.id}/restore`);
    expect(restored.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['member.updated', 'me.updated']),
    );
    expect(events.find((event) => event.type === 'me.updated')?.userId).toBe(owner.id);
  });
});

describe('projects ↔ admin: Trash', () => {
  it('lists a deleted project in the team Trash and restores it by key over MCP', async () => {
    const { team, project } = await setup();
    expect((await call(ownerKey, 'DELETE', `/projects/${project.id}`)).status).toBe(200);

    const trash = await call<{ items: Array<{ type: string; id: string; title: string }> }>(
      ownerKey,
      'GET',
      `/teams/${team.id}/trash`,
    );
    expect(trash.body.items).toEqual([
      expect.objectContaining({ type: 'project', id: project.id, title: 'Web App' }),
    ]);
    // The member didn't delete it and has no MANAGE_TRASH: nothing to see.
    expect(
      (await call<{ items: unknown[] }>(memberKey, 'GET', `/teams/${team.id}/trash`)).body.items,
    ).toEqual([]);

    const tool = await mcpAs(owner);
    const restored = await tool('restore_item', { item: `${team.slug}/${project.key}` });
    expect(restored.url).toBe(`${ctx.env.baseUrl}/t/${team.slug}/p/${project.key}`);
    expect((await call(memberKey, 'GET', `/projects/${project.id}`)).status).toBe(200);
  });

  it('restores through the Trash page endpoint and records both sides in the audit log', async () => {
    const { team, project } = await setup();
    await call(ownerKey, 'DELETE', `/projects/${project.id}`);
    const restored = await call<{ ok: boolean; url: string | null }>(
      ownerKey,
      'POST',
      '/trash/restore',
      {
        type: 'project',
        id: project.id,
      },
    );
    expect(restored.body).toMatchObject({ ok: true, url: `/t/${team.slug}/p/${project.key}` });

    const facets = await call<{ actions: string[]; entityTypes: string[] }>(
      ownerKey,
      'GET',
      `/teams/${team.id}/audit-log/facets`,
    );
    expect(facets.body.actions).toEqual(
      expect.arrayContaining([
        'team.created',
        'invite.created',
        'member.joined',
        'project.created',
        'project.deleted',
        'project.restored',
      ]),
    );
    const log = await call<{ items: Array<{ action: string; url: string | null }> }>(
      ownerKey,
      'GET',
      `/teams/${team.id}/audit-log?action=project.`,
    );
    expect(log.body.items.map((entry) => entry.action)).toEqual([
      'project.restored',
      'project.deleted',
      'project.created',
    ]);
  });
});

describe('issues ↔ core and admin', () => {
  it('threads replies, searches, notifies, and restores a deleted issue from Trash by ref', async () => {
    const { team, project } = await setup();
    const created = await call<{ id: string; ref: string }>(
      memberKey,
      'POST',
      `/projects/${project.id}/issues`,
      { title: 'Export is slow', body: 'Takes minutes for @ethan' },
    );
    expect(created.status).toBe(201);
    const issue = created.body;

    // Replies bump the reply count; the author (auto-subscribed) is notified of the reply.
    expect(
      (
        await call(ownerKey, 'POST', '/replies', {
          parentType: 'issue',
          parentId: issue.id,
          body: 'Looking into the CSV writer',
        })
      ).status,
    ).toBe(201);
    const list = await call<{ items: Array<{ replyCount: number }> }>(
      ownerKey,
      'GET',
      `/projects/${project.id}/issues?q=csv`,
    );
    expect(list.body.items).toEqual([expect.objectContaining({ replyCount: 1 })]);
    const inbox = await call<{ items: Array<{ type: string }> }>(
      memberKey,
      'GET',
      '/notifications',
    );
    expect(inbox.body.items.map((item) => item.type)).toEqual(['reply']);
    const mentioned = await call<{ items: Array<{ type: string }> }>(
      ownerKey,
      'GET',
      '/notifications',
    );
    // BAT-6: the owner's own reply went through their key, so it reaches their inbox too.
    expect(mentioned.body.items.map((item) => item.type)).toEqual(['reply', 'mention']);
    const found = await call<{ results: Array<{ ref: string }> }>(
      ownerKey,
      'GET',
      `/search?q=export&teamId=${team.id}`,
    );
    expect(found.body.results.map((result) => result.ref)).toEqual([issue.ref]);

    // Deleted: out of lists and search, in the author's Trash, restorable by ref over MCP.
    expect((await call(memberKey, 'DELETE', `/issues/${issue.id}`)).status).toBe(200);
    expect(
      (await call<{ results: unknown[] }>(ownerKey, 'GET', `/search?q=export&teamId=${team.id}`))
        .body.results,
    ).toEqual([]);
    const trash = await call<{ items: Array<{ type: string; ref: string | null }> }>(
      memberKey,
      'GET',
      `/teams/${team.id}/trash`,
    );
    expect(trash.body.items).toEqual([expect.objectContaining({ type: 'issue', ref: issue.ref })]);
    const tool = await mcpAs(member);
    const restored = await tool('restore_item', { item: `${team.slug}/${issue.ref}` });
    expect(restored.url).toBe(`${ctx.env.baseUrl}/t/${team.slug}/p/${project.key}/issues/1`);
    expect((await call(ownerKey, 'GET', `/issues/${issue.id}`)).status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['issue.created', 'reply.created', 'issue.deleted', 'issue.restored']),
    );
  });
});

describe('live events the web invalidates on', () => {
  it('announces joins, projects and role changes to the team', async () => {
    const { team, project } = await setup();
    const types = events.map((event) => `${event.type}:${event.teamId === team.id}`);
    expect(types).toEqual(
      expect.arrayContaining([
        'member.joined:true',
        'invite.changed:true',
        'project.created:true',
        'activity.created:true',
      ]),
    );
    events.length = 0;
    const role = await call<{ id: string }>(ownerKey, 'POST', `/teams/${team.id}/roles`, {
      name: 'Frontend',
    });
    await call(ownerKey, 'PUT', `/teams/${team.id}/members/${member.id}/roles/${role.body.id}`);
    await call(ownerKey, 'PATCH', `/projects/${project.id}`, { name: 'Web' });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['role.changed', 'member.updated', 'project.updated']),
    );
  });
});

describe('tasks ↔ admin and teams', () => {
  it('trashes a task, lists it for its author and restores it by ref over MCP', async () => {
    const { team, project } = await setup();
    const task = await call<{ id: string; ref: string }>(
      memberKey,
      'POST',
      `/projects/${project.id}/tasks`,
      { title: 'Ship the dashboard' },
    );
    expect(task.status).toBe(201);
    expect((await call(memberKey, 'DELETE', `/tasks/${task.body.id}`)).status).toBe(200);

    for (const key of [memberKey, ownerKey]) {
      const trash = await call<{ items: Array<{ type: string; ref: string | null }> }>(
        key,
        'GET',
        `/teams/${team.id}/trash?type=task`,
      );
      expect(trash.body.items).toEqual([
        expect.objectContaining({ type: 'task', ref: `${project.key}-1` }),
      ]);
    }

    const tool = await mcpAs(member);
    const restored = await tool('restore_item', { item: `${project.key}-1` });
    expect(restored).toMatchObject({ type: 'task', id: task.body.id });
    expect(restored.url).toBe(`${ctx.env.baseUrl}/t/${team.slug}/p/${project.key}/tasks/1`);

    const facets = await call<{ actions: string[] }>(
      ownerKey,
      'GET',
      `/teams/${team.id}/audit-log/facets`,
    );
    expect(facets.body.actions).toEqual(
      expect.arrayContaining(['task.created', 'task.deleted', 'task.restored']),
    );
  });

  it('points to the project when a task sits in a deleted project', async () => {
    const { project } = await setup();
    await call(ownerKey, 'POST', `/projects/${project.id}/tasks`, { title: 'Inside' });
    await call(ownerKey, 'DELETE', `/projects/${project.id}`);
    await mcpAs(owner);
    const client = clients.at(-1);
    const result = await client?.callTool({
      name: 'restore_item',
      arguments: { item: `${project.key}-1` },
    });
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toMatch(/Restore the project/);
  });

  it('counts open tasks on the team home and drops a removed member from assignments', async () => {
    const { team, project } = await setup();
    const task = await call<{ id: string }>(ownerKey, 'POST', `/projects/${project.id}/tasks`, {
      title: 'Pair on it',
      assigneeUserIds: [member.id],
    });
    const overview = await call<{ projects: Array<{ openTasks: number }> }>(
      ownerKey,
      'GET',
      `/teams/${team.id}/overview`,
    );
    expect(overview.body.projects[0]?.openTasks).toBe(1);

    expect((await call(ownerKey, 'DELETE', `/teams/${team.id}/members/${member.id}`)).status).toBe(
      200,
    );
    const after = await call<{ assignees: { users: unknown[] } }>(
      ownerKey,
      'GET',
      `/tasks/${task.body.id}`,
    );
    expect(after.body.assignees.users).toEqual([]);
  });
});

describe('wave B: issues ↔ tasks ↔ work', () => {
  it('turns an issue into a task whose completion resolves it and tells its author', async () => {
    const { team, project } = await setup();
    const statuses = await call<{ items: Array<{ id: string; name: string }> }>(
      ownerKey,
      'GET',
      `/projects/${project.id}/statuses`,
    );
    const done = statuses.body.items.find((status) => status.name === 'Done');
    const issue = await call<{ id: string; ref: string }>(
      memberKey,
      'POST',
      `/projects/${project.id}/issues`,
      { title: 'Search ignores accents', body: 'Searching "cafe" misses "café".' },
    );

    // The issue page's "Create task" button.
    const task = await call<{ id: string; ref: string; path: string; issues: unknown[] }>(
      ownerKey,
      'POST',
      `/projects/${project.id}/tasks/from-issue`,
      { issueId: issue.body.id },
    );
    expect(task.status).toBe(201);
    expect(task.body.path).toBe(`/t/${team.slug}/p/${project.key}/tasks/1`);
    expect(task.body.issues).toEqual([
      expect.objectContaining({ ref: issue.body.ref, kind: 'fixes', resolved: false }),
    ]);
    const linked = await call<{ linkedTasks: Array<{ ref: string; kind: string }> }>(
      memberKey,
      'GET',
      `/issues/${issue.body.id}`,
    );
    expect(linked.body.linkedTasks).toEqual([
      expect.objectContaining({ ref: task.body.ref, kind: 'fixes' }),
    ]);

    // Moving it to a done status on the board resolves the issue.
    events.length = 0;
    const moved = await call(ownerKey, 'POST', `/tasks/${task.body.id}/move`, {
      statusId: done?.id,
    });
    expect(moved.status).toBe(200);
    const resolved = await call<{
      resolved: boolean;
      resolvedBy: { username: string } | null;
      linkedTasks: Array<{ status: { category: string } }>;
    }>(memberKey, 'GET', `/issues/${issue.body.id}`);
    expect(resolved.body).toMatchObject({ resolved: true, resolvedBy: { username: 'ethan' } });
    expect(resolved.body.linkedTasks[0]?.status.category).toBe('done');

    const inbox = await call<{ items: Array<{ type: string; title: string; viaKeyName: string }> }>(
      memberKey,
      'GET',
      '/notifications',
    );
    expect(inbox.body.items[0]).toMatchObject({
      type: 'issue_resolved',
      title: `${issue.body.ref}: Search ignores accents`,
      viaKeyName: 'Claude on laptop',
    });
    // BAT-6: the owner moved it through a key, so the owner (the task's author) hears too.
    expect(
      events
        .filter((event) => event.type === 'notification.created')
        .map((event) => event.userId)
        .sort(),
    ).toEqual([member.id, owner.id].sort());
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task.updated', 'issue.updated']),
    );

    // The issue list's tabs count it as resolved.
    const list = await call<{ counts: { open: number; resolved: number } }>(
      ownerKey,
      'GET',
      `/projects/${project.id}/issues?state=all`,
    );
    expect(list.body.counts).toMatchObject({ open: 0, resolved: 1 });
  });

  it('notifies mentions, role mentions, assignments and replies, and shows the work on My tasks and the dashboard', async () => {
    const { team, project } = await setup();
    const role = await call<{ id: string; slug: string }>(
      ownerKey,
      'POST',
      `/teams/${team.id}/roles`,
      { name: 'Frontend', mentionable: true },
    );
    expect(role.status).toBe(201);
    expect(
      (await call(ownerKey, 'PUT', `/teams/${team.id}/members/${member.id}/roles/${role.body.id}`))
        .status,
    ).toBe(200);

    // Assigned through a role, with a user mention in the description.
    events.length = 0;
    const task = await call<{ id: string; ref: string }>(
      ownerKey,
      'POST',
      `/projects/${project.id}/tasks`,
      {
        title: 'Polish the empty states',
        description: 'Ping @caden when the copy is ready.',
        assigneeRoleIds: [role.body.id],
        priority: 3,
        dueDate: '2020-01-01',
      },
    );
    expect(task.status).toBe(201);
    // One notification per person per change: the assignment covers the mention.
    const afterCreate = await call<{ items: Array<{ type: string; entityId: string }> }>(
      memberKey,
      'GET',
      '/notifications',
    );
    expect(afterCreate.body.items.map((item) => item.type)).toEqual(['assigned']);
    expect(events.some((event) => event.type === 'notification.created')).toBe(true);

    // A role mention in an issue, then a reply to the member's subscribed task.
    await call(ownerKey, 'POST', `/projects/${project.id}/issues`, {
      title: 'Design review',
      body: `@&${role.body.slug} please review the new header.`,
    });
    await call(memberKey, 'POST', '/replies', {
      parentType: 'task',
      parentId: task.body.id,
      body: 'On it.',
    });
    await call(ownerKey, 'POST', '/replies', {
      parentType: 'task',
      parentId: task.body.id,
      body: 'Thanks!',
    });
    const inbox = await call<{ items: Array<{ type: string }> }>(
      memberKey,
      'GET',
      '/notifications',
    );
    // BAT-6: the member's own "On it." went through their key, so it is in their inbox too.
    expect(inbox.body.items.map((item) => item.type)).toEqual([
      'reply',
      'reply',
      'role_mention',
      'assigned',
    ]);

    // The member's agent claims it; My tasks and the dashboard show both facts.
    const claim = await call(memberKey, 'POST', `/tasks/${task.body.id}/claim`, {});
    expect(claim.status).toBe(200);
    const mine = await call<{
      items: Array<{ ref: string; assignment: { direct: boolean; roles: Array<{ id: string }> } }>;
    }>(memberKey, 'GET', '/me/tasks?today=2026-09-25');
    expect(mine.body.items).toEqual([
      expect.objectContaining({
        ref: task.body.ref,
        assignment: { direct: false, roles: [expect.objectContaining({ id: role.body.id })] },
      }),
    ]);
    const dashboard = await call<{
      counts: { assigned: number; overdue: number; claimed: number };
      claimed: Array<{ ref: string; claim: { via: { keyName: string } | null } | null }>;
    }>(memberKey, 'GET', '/me/dashboard?today=2026-09-25');
    expect(dashboard.body.counts).toMatchObject({ assigned: 1, overdue: 1, claimed: 1 });
    expect(dashboard.body.claimed[0]).toMatchObject({
      ref: task.body.ref,
      claim: { via: { keyName: 'Codex' } },
    });
  });
});
