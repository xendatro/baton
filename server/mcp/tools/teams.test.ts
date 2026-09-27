import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../../db/schema';
import {
  agentActor,
  createApiKey,
  createProject,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { deleteTeam } from '../../services/teams';
import { registerTools } from './index';
import { teamsTools } from './teams';

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan', name: 'Ethan' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

/** An MCP client acting as `user`'s agent member through a named API key (agents A). */
async function connect(user: UserRow, keyName = 'Claude on laptop'): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: keyName });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: agentActor(ctx.db, user.id, { id: apiKey.id, name: keyName }),
    },
    teamsTools,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

type Result = Awaited<ReturnType<Client['callTool']>>;

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result: Result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result: Result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

describe('teams MCP tools', () => {
  it('describes every input field', async () => {
    const client = await connect(ethan);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      teamsTools.map((tool) => tool.name).sort(),
    );
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect(
          (schema as { description?: string }).description,
          `${tool.name}.${field}`,
        ).toBeTruthy();
      }
    }
  });

  it('runs the team lifecycle an agent needs: create, invite, join, roles, members', async () => {
    const agent = await connect(ethan);
    const team = await call<{ id: string; slug: string; url: string; ref: string }>(
      agent,
      'create_team',
      { name: 'Acme Rockets', icon: '🚀' },
    );
    expect(team).toMatchObject({ slug: 'acme-rockets', ref: 'acme-rockets' });
    expect(team.url).toBe(`${ctx.env.baseUrl}/t/acme-rockets`);

    const audit = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'team.created'))
      .get();
    expect(audit).toMatchObject({ source: 'mcp', viaKeyName: 'Claude on laptop' });

    const invite = await call<{ code: string; url: string }>(agent, 'create_invite', {
      team: 'acme-rockets',
      expiresIn: '1d',
      maxUses: 5,
    });
    expect(invite.url).toBe(`${ctx.env.baseUrl}/join/${invite.code}`);

    const miaAgent = await connect(mia, 'Codex');
    const preview = await call<{ team: { name: string }; alreadyMember: boolean }>(
      miaAgent,
      'get_invite',
      { code: invite.url },
    );
    expect(preview).toMatchObject({ team: { name: 'Acme Rockets' }, alreadyMember: false });
    const joined = await call<{ alreadyMember: boolean; team: { url: string } }>(
      miaAgent,
      'join_team',
      { code: invite.code },
    );
    expect(joined.alreadyMember).toBe(false);

    const role = await call<{ id: string; ref: string; permissions: string[] }>(
      agent,
      'create_role',
      { team: 'acme-rockets', name: 'Triage', permissions: ['RESOLVE_ISSUES'], mentionable: true },
    );
    expect(role.ref).toBe('@&triage');
    const updated = await call<{ permissions: string[] }>(agent, 'update_role', {
      team: 'acme-rockets',
      role: 'triage',
      addPermissions: ['MANAGE_LABELS'],
      removePermissions: ['RESOLVE_ISSUES'],
    });
    expect(updated.permissions).toEqual(['MANAGE_LABELS']);

    const member = await call<{ roles: Array<{ name: string }> }>(agent, 'assign_role', {
      team: 'acme-rockets',
      user: '@mia',
      role: 'Triage',
    });
    expect(member.roles.map((r) => r.name)).toEqual(['Triage']);

    const { members } = await call<{ members: Array<{ ref: string; isOwner: boolean }> }>(
      miaAgent,
      'list_members',
      { team: 'acme-rockets' },
    );
    // Created and joined through keys: the people are members, their agents with them.
    expect(members.map((m) => [m.ref, m.isOwner])).toEqual([
      ['@ethan', true],
      ['@ethan-ai', false],
      ['@mia', false],
      ['@mia-ai', false],
    ]);

    const { roles } = await call<{ roles: Array<{ name: string }> }>(agent, 'reorder_roles', {
      team: 'acme-rockets',
      roles: ['triage', 'admin'],
    });
    expect(roles.map((r) => r.name)).toEqual(['Triage', 'Admin', '@everyone']);

    await call(agent, 'unassign_role', { team: 'acme-rockets', user: 'mia', role: 'triage' });
    await call(agent, 'delete_role', { team: 'acme-rockets', role: 'triage' });

    const { invites } = await call<{ invites: Array<{ code: string; uses: number }> }>(
      agent,
      'list_invites',
      { team: 'acme-rockets' },
    );
    expect(invites[0]?.uses).toBe(1);
    await call(agent, 'revoke_invite', { team: 'acme-rockets', invite: invite.code });

    await call(miaAgent, 'leave_team', { team: 'acme-rockets' });
    expect(await callError(miaAgent, 'get_team', { team: 'acme-rockets' })).toMatch(/not_found/);
  });

  it('shows a team with projects, roles and your permissions', async () => {
    const agent = await connect(ethan);
    const team = await call<{ id: string }>(agent, 'create_team', { name: 'Acme' });
    createProject(ctx.db, { teamId: team.id, key: 'WEB', name: 'Web' });
    const detail = await call<{
      you: { isOwner: boolean; permissions: string[] };
      projects: Array<{ ref: string; url: string; openTasks: number }>;
      roles: Array<{ name: string }>;
    }>(agent, 'get_team', { team: 'acme' });
    // The team is Ethan's; his agent, which created it, is its admin (never its owner).
    expect(detail.you.isOwner).toBe(false);
    expect(detail.you.permissions).toContain('ADMINISTRATOR');
    expect(detail.projects).toEqual([
      expect.objectContaining({
        ref: 'acme/WEB',
        url: `${ctx.env.baseUrl}/t/acme/p/WEB`,
        openTasks: 0,
      }),
    ]);
    expect(detail.roles.map((role) => role.name)).toEqual(['Admin', '@everyone']);
    const { teams } = await call<{ teams: Array<{ slug: string }> }>(agent, 'list_teams');
    expect(teams.map((t) => t.slug)).toEqual(['acme']);
  });

  it('guards owner-only actions with a typed confirmation, and keeps them from agents', async () => {
    const agent = await connect(ethan);
    const team = await call<{ id: string }>(agent, 'create_team', { name: 'Acme' });
    const miaAgent = await connect(mia);
    const invite = await call<{ code: string }>(agent, 'create_invite', { team: 'acme' });
    await call(miaAgent, 'join_team', { code: invite.code });

    expect(
      await callError(agent, 'transfer_team_ownership', {
        team: 'acme',
        user: 'mia',
        confirm: 'nope',
      }),
    ).toMatch(/confirm: "acme"/);
    expect(await callError(miaAgent, 'delete_team', { team: 'acme', confirm: 'acme' })).toMatch(
      /forbidden/,
    );
    // Agents never own teams (agents A): even the owner's agent can't do owner-only things.
    expect(
      await callError(agent, 'transfer_team_ownership', {
        team: 'acme',
        user: 'mia',
        confirm: 'acme',
      }),
    ).toMatch(/forbidden: Only the team owner/);
    expect(await callError(agent, 'delete_team', { team: team.id, confirm: 'ACME' })).toMatch(
      /forbidden/,
    );

    // The owner deletes it in the web app; their agent can't see or restore it in Trash.
    deleteTeam(ctx.deps, { userId: ethan.id, source: 'web', key: null }, team.id);
    const { items } = await call<{ items: Array<{ slug: string }> }>(agent, 'list_deleted_teams');
    expect(items).toEqual([]);
    expect(await callError(agent, 'restore_team', { team: 'acme' })).toMatch(/not_found/);
  });

  it('removes members within the rules', async () => {
    const agent = await connect(ethan);
    await call(agent, 'create_team', { name: 'Acme' });
    const invite = await call<{ code: string }>(agent, 'create_invite', { team: 'acme' });
    const miaAgent = await connect(mia);
    await call(miaAgent, 'join_team', { code: invite.code });
    expect(await callError(miaAgent, 'remove_member', { team: 'acme', user: 'ethan' })).toMatch(
      /forbidden/,
    );
    await call(agent, 'remove_member', { team: 'acme', user: 'mia' });
    expect(await callError(miaAgent, 'list_members', { team: 'acme' })).toMatch(/not_found/);
  });
});
