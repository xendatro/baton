import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../../test/helpers';
import { registerTools } from './index';
import { projectAccessTools } from './projectAccess';
import { projectsTools } from './projects';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let clients: Client[];

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  const teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: mia.id });
  createProject(ctx.db, { teamId, key: 'API' });
  createProject(ctx.db, { teamId, key: 'WEB' });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude on laptop' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(
    server,
    {
      deps: ctx.deps,
      actor: { userId: user.id, source: 'mcp', key: { id: apiKey.id, name: apiKey.name } },
    },
    [...projectAccessTools, ...projectsTools],
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function callError(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

describe('project access MCP tools', () => {
  it('manage project roles and overrides by ref', async () => {
    const client = await connect(owner);
    const role = await call<{ ref: string; url: string }>(client, 'create_project_role', {
      project: 'API',
      name: 'Reviewers',
    });
    expect(role.ref).toBe('reviewers');
    expect(role.url).toMatch(/\/t\/acme\/p\/API\/settings\/access$/);
    const assigned = await call<{ members: Array<{ ref: string }> }>(
      client,
      'assign_project_role',
      { project: 'API', role: 'Reviewers', user: '@mia' },
    );
    expect(assigned.members.map((member) => member.ref)).toEqual(['@mia']);
    const renamed = await call<{ ref: string }>(client, 'update_project_role', {
      project: 'API',
      role: 'reviewers',
      name: 'QA',
    });
    expect(renamed.ref).toBe('qa');

    await call(client, 'set_project_permission_override', {
      project: 'API',
      subjectType: 'team_role',
      subject: 'everyone',
      allow: [],
      deny: ['REPLY', 'VIEW_PROJECT'],
    });
    const perms = await call<{
      overrides: Array<{ subjectName: string }>;
      member: { canView: boolean; permissions: string[] };
    }>(client, 'get_project_permissions', { project: 'API', user: 'mia' });
    expect(perms.overrides.map((o) => o.subjectName)).toEqual(['@everyone']);
    expect(perms.member.canView).toBe(false);

    // Mia no longer sees API at all.
    const miaClient = await connect(mia);
    expect(await callError(miaClient, 'get_project', { project: 'API' })).toMatch(/not found/i);
    const listed = await call<{ projects: Array<{ key: string }> }>(miaClient, 'list_projects', {});
    expect(listed.projects.map((project) => project.key)).toEqual(['WEB']);

    // A project role allow brings it back for its members.
    await call(client, 'set_project_permission_override', {
      project: 'API',
      subjectType: 'project_role',
      subject: 'qa',
      allow: ['VIEW_PROJECT'],
      deny: [],
    });
    await call(miaClient, 'get_project', { project: 'API' });
    expect(
      await callError(miaClient, 'create_project_role', { project: 'API', name: 'Mine' }),
    ).toMatch(/permission/);

    await call(client, 'remove_project_permission_override', {
      project: 'API',
      subjectType: 'team_role',
      subject: 'everyone',
    });
    await call(client, 'unassign_project_role', { project: 'API', role: 'qa', user: 'mia' });
    await call(client, 'delete_project_role', { project: 'API', role: 'qa' });
    const roles = await call<{ roles: unknown[] }>(client, 'list_project_roles', {
      project: 'API',
    });
    expect(roles.roles).toEqual([]);
  });

  it('reject team-level permissions and unknown subjects', async () => {
    const client = await connect(owner);
    expect(
      await callError(client, 'set_project_permission_override', {
        project: 'API',
        subjectType: 'team_role',
        subject: 'everyone',
        allow: ['MANAGE_TEAM'],
        deny: [],
      }),
    ).toMatch(/MANAGE_TEAM|Invalid/);
    expect(
      await callError(client, 'set_project_permission_override', {
        project: 'API',
        subjectType: 'project_role',
        subject: 'nope',
        allow: [],
        deny: ['REPLY'],
      }),
    ).toMatch(/not found/i);
  });
});
