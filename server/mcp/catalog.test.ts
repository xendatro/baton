import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, createUser, type TestContext } from '../test/helpers';
import { allTools, registerTools } from './tools';

/**
 * The MCP tool catalog of SPEC §5.1 against what the server registers: every tool the spec lists
 * exists, and every tool beyond it is one of the documented additions (docs/DECISIONS.md), so a
 * new tool can't slip in without being written down.
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Tool names of SPEC §5.1's catalog, by module, read from SPEC.md itself. */
function specCatalog(): Map<string, string[]> {
  const spec = readFileSync(path.join(repoRoot, 'SPEC.md'), 'utf8');
  const start = spec.indexOf('- Tool catalog');
  const end = spec.indexOf('\n---', start);
  expect(start).toBeGreaterThan(0);
  const catalog = new Map<string, string[]>();
  let module = '';
  for (const line of spec.slice(start, end).split('\n')) {
    const heading = /^\s*- \[(\w+)\]/.exec(line);
    if (heading?.[1]) module = heading[1];
    if (!module) continue;
    const names = [...line.matchAll(/`([a-z_]+)`/g)].map((match) => match[1] ?? '');
    catalog.set(module, [...(catalog.get(module) ?? []), ...names]);
  }
  return catalog;
}

/** Tools added for web parity beyond SPEC §5.1, each recorded in docs/DECISIONS.md. */
const DOCUMENTED_ADDITIONS = [
  // teams (DECISIONS 2026-09-25 teams)
  'transfer_team_ownership',
  'delete_team',
  'restore_team',
  'list_deleted_teams',
  'reorder_roles',
  'get_invite',
  'join_team',
  // admin (DECISIONS 2026-09-25 admin)
  'get_audit_log_facets',
  // account (DECISIONS 2026-09-25 account)
  'set_avatar',
  'remove_avatar',
  'get_security_log',
  // core (DECISIONS 2026-09-26 BAT-6)
  'wait_for_mentions',
].sort();

let ctx: TestContext;
let client: Client;

beforeEach(async () => {
  ctx = createTestContext();
  const user = createUser(ctx.db, { username: 'ethan' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, {
    deps: ctx.deps,
    actor: { userId: user.id, source: 'mcp', key: null },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'catalog-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  ctx.close();
});

describe('MCP tool catalog (SPEC §5.1)', () => {
  it('reads a complete catalog from SPEC.md', () => {
    const catalog = specCatalog();
    expect([...catalog.keys()].sort()).toEqual(
      ['account', 'admin', 'core', 'issues', 'projects', 'tasks', 'teams', 'work'].sort(),
    );
    expect([...catalog.values()].flat()).toHaveLength(71);
  });

  it('lists every tool of the spec, and only documented additions beyond it', async () => {
    const { tools } = await client.listTools();
    const listed = new Set(tools.map((tool) => tool.name));
    const specified = [...specCatalog().values()].flat();

    const missing = specified.filter((name) => !listed.has(name));
    expect(missing, `SPEC §5.1 tools missing from the MCP server`).toEqual([]);

    const extra = [...listed].filter((name) => !specified.includes(name)).sort();
    expect(extra, 'tools beyond SPEC §5.1 must be documented additions').toEqual(
      DOCUMENTED_ADDITIONS,
    );
    expect(listed.size).toBe(allTools.length);
  });

  it('describes every tool and every input field for agents', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name, 'snake_case names').toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(20);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        const description = (schema as { description?: string }).description;
        expect(description, `${tool.name}.${field} needs a description`).toBeTruthy();
      }
    }
  });
});
