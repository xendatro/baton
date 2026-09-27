import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { allTools, registerTools } from './tools';
import { suggestKey } from './tools/define';

/**
 * Regression tests for the MCP review findings (MCP-01 … MCP-17): strict inputs, team-qualified
 * refs, assignee filters, reply validation, text attachments, error messages, bounded outputs,
 * error details, parameter names in errors, absolute URLs and tool annotations.
 */

let ctx: TestContext;
let ethan: UserRow;
let leo: UserRow;
let teamId: string;
let web: CreatedProject;
let frontendRoleId: string;
let clients: Client[];

type Json = Record<string, unknown>;

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan' });
  leo = createUser(ctx.db, { username: 'leo' });
  teamId = createTeam(ctx.db, { ownerId: ethan.id, slug: 'northwind' }).team.id;
  frontendRoleId = createRole(ctx.db, { teamId, name: 'Frontend', slug: 'frontend' }).id;
  addMember(ctx.db, { teamId, userId: leo.id });
  web = createProject(ctx.db, {
    teamId,
    key: 'WEB',
    name: 'Web App',
    createdById: ethan.id,
  });
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

async function connect(user: UserRow): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Agent' });
  // The key acts as the user's agent member, with the user's roles (agents A).
  giveAgentOwnerRoles(ctx.db, user.id);
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, {
    deps: ctx.deps,
    actor: agentActor(ctx.db, user.id, { id: apiKey.id, name: apiKey.name }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function call<T = Json>(client: Client, name: string, args: Json = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as T;
}

async function callError(client: Client, name: string, args: Json = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} should fail`).toBe(true);
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

async function seedLabels(client: Client, names: string[]) {
  for (const name of names) await call(client, 'create_label', { project: 'WEB', name });
}

function taskRow(number: number) {
  return ctx.db.orm
    .select()
    .from(s.task)
    .where(eq(s.task.projectId, web.project.id))
    .all()
    .find((row) => row.number === number);
}

/** Every object node of a JSON schema. */
function objectNodes(schema: unknown, path = '$'): Array<{ path: string; node: Json }> {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Json;
  const found: Array<{ path: string; node: Json }> = [];
  if (node.type === 'object' || node.properties) found.push({ path, node });
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'object' && value !== null) {
      found.push(...objectNodes(value, `${path}.${key}`));
    }
  }
  return found;
}

describe('MCP-01: unknown or misspelled arguments are refused', () => {
  it('advertises additionalProperties: false on every input object of every tool', async () => {
    const client = await connect(ethan);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(allTools.length);
    const open = tools.flatMap((tool) =>
      objectNodes(tool.inputSchema)
        .filter(({ node }) => node.additionalProperties !== false)
        .map(({ path }) => `${tool.name} ${path}`),
    );
    expect(open).toEqual([]);
  });

  it('refuses a misspelled claim_next_task filter instead of claiming outside it', async () => {
    const client = await connect(ethan);
    await seedLabels(client, ['Bug', 'Documentation']);
    await call(client, 'create_task', { project: 'WEB', title: 'Blocker A', labels: ['Bug'] });
    const agent = await connect(leo);
    const error = await callError(agent, 'claim_next_task', {
      project: 'northwind/WEB',
      labels: ['Documentation'],
      statuses: ['Backlog'],
    });
    expect(error).toContain('Unknown parameters "labels" (did you mean "label"?)');
    expect(error).toContain('"statuses"');
    expect(error).toMatch(/Accepted: project, role, label, priority/);
    expect(taskRow(1)?.claimedById).toBeNull();
  });

  it('refuses misspelled list_tasks filters and create_task fields', async () => {
    const client = await connect(ethan);
    expect(
      await callError(client, 'list_tasks', { project: 'WEB', labels: ['Documentation'] }),
    ).toContain('"labels" (did you mean "label"?)');
    expect(await callError(client, 'list_issues', { project: 'WEB', query: 'x' })).toContain(
      '"query" (did you mean "q"?)',
    );
    const error = await callError(client, 'create_task', {
      project: 'northwind/WEB',
      title: 'typo test',
      assignee: ['leo'],
      label: ['Bug'],
      due: '2026-10-10',
    });
    expect(error).toContain('"assignee" (did you mean "assignees"?)');
    expect(error).toContain('"label" (did you mean "labels"?)');
    expect(error).toContain('"due" (did you mean "dueDate"?)');
    expect(taskRow(1)).toBeUndefined();
  });

  it('checks nested argument objects too', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Nested' });
    expect(
      await callError(client, 'update_task', {
        task: 'WEB-1',
        assignees: { replace: ['leo'] },
      }),
    ).toContain('Unknown parameter "replace"');
  });

  it('suggests the parameter an agent most likely meant', () => {
    expect(suggestKey('labels', ['project', 'label'])).toBe('label');
    expect(suggestKey('assignee', ['assignees', 'assigneeRoles'])).toBe('assignees');
    expect(suggestKey('q', ['project', 'query'])).toBe('query');
    expect(suggestKey('due', ['title', 'dueDate'])).toBe('dueDate');
    expect(suggestKey('priorty', ['priority', 'project'])).toBe('priority');
    expect(suggestKey('banana', ['project', 'title'])).toBeUndefined();
  });
});

describe('MCP-02: refs are team-qualified and keep resolving', () => {
  it('returns team/KEY refs that survive another team taking the same key', async () => {
    const caden = createUser(ctx.db, { username: 'caden' });
    const sideQuests = createTeam(ctx.db, { ownerId: caden.id, slug: 'side-quests' });
    addMember(ctx.db, { teamId: sideQuests.team.id, userId: ethan.id });
    const client = await connect(ethan);
    const created = await call<{ ref: string; teamSlug: string }>(client, 'create_task', {
      project: 'WEB',
      title: 'First',
    });
    expect(created).toMatchObject({ ref: 'northwind/WEB-1', teamSlug: 'northwind' });
    const issue = await call<{ ref: string }>(client, 'create_issue', {
      project: 'WEB',
      title: 'Crash on save',
    });
    expect(issue.ref).toBe('northwind/WEB#1');
    const list = await call<{ tasks: Array<{ ref: string; teamSlug: string }> }>(
      client,
      'list_tasks',
      { project: 'WEB' },
    );
    expect(list.tasks).toEqual([
      expect.objectContaining({ ref: 'northwind/WEB-1', teamSlug: 'northwind' }),
    ]);

    // Someone else creates WEB in another of ethan's teams: short refs become ambiguous…
    const other = await connect(caden);
    await call(other, 'create_project', { team: 'side-quests', name: 'Website', key: 'WEB' });
    const ambiguous = await callError(client, 'get_task', { task: 'WEB-1' });
    expect(ambiguous).toContain(
      'Task "WEB-1" is ambiguous. Use one of: northwind/WEB-1, side-quests/WEB-1',
    );
    expect(await callError(client, 'get_issue', { issue: 'WEB#1' })).toContain(
      'northwind/WEB#1, side-quests/WEB#1',
    );
    // …but the refs the tools returned still work, and come back the same.
    const task = await call<{ ref: string }>(client, 'get_task', { task: created.ref });
    expect(task.ref).toBe('northwind/WEB-1');
    await call(client, 'get_issue', { issue: issue.ref });

    const found = await call<{ results: Array<{ ref: string; teamSlug: string }> }>(
      client,
      'search',
      { query: 'crash' },
    );
    expect(found.results).toEqual([
      expect.objectContaining({ ref: 'northwind/WEB#1', teamSlug: 'northwind' }),
    ]);
    await call(client, 'delete_task', { task: created.ref });
    const trash = await call<{ items: Array<{ ref: string | null }> }>(client, 'list_trash', {
      team: 'northwind',
    });
    expect(trash.items.map((item) => item.ref)).toEqual(['northwind/WEB-1']);
  });
});

describe('MCP-03: list_tasks accepts a bare role name as assignee', () => {
  it('falls back to roles and flags names that are both', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', {
      project: 'WEB',
      title: 'Style the login',
      assigneeRoles: ['Frontend'],
    });
    await call(client, 'create_task', { project: 'WEB', title: 'Leo’s', assignees: ['leo'] });
    const refs = async (assignee: string[]) =>
      (
        await call<{ tasks: Array<{ ref: string }> }>(client, 'list_tasks', {
          project: 'WEB',
          assignee,
        })
      ).tasks.map((task) => task.ref);
    expect(await refs(['Frontend'])).toEqual(['northwind/WEB-1']);
    expect(await refs(['frontend'])).toEqual(['northwind/WEB-1']);
    expect(await refs(['@&frontend'])).toEqual(['northwind/WEB-1']);
    expect(await refs(['leo'])).toEqual(['northwind/WEB-2']);

    createRole(ctx.db, { teamId, name: 'leo', slug: 'leo-role' });
    expect(await callError(client, 'list_tasks', { project: 'WEB', assignee: ['leo'] })).toMatch(
      /"leo" is both a member \(@leo\) and a role \(leo\)/,
    );
    expect(await refs(['@leo'])).toEqual(['northwind/WEB-2']);
    expect(
      await callError(client, 'list_tasks', { project: 'WEB', assignee: ['Designers'] }),
    ).toContain('Assignee not found: "Designers"');
    expect(frontendRoleId).toBeTruthy();
  });
});

describe('MCP-05: replies must have text', () => {
  it('refuses whitespace-only bodies in add_reply and edit_reply', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Thread' });
    expect(await callError(client, 'add_reply', { item: 'WEB-1', body: '   ' })).toMatch(
      /^validation_failed: body: /,
    );
    const reply = await call<{ id: string }>(client, 'add_reply', {
      item: 'WEB-1',
      body: '  Real text  ',
    });
    expect(await callError(client, 'edit_reply', { reply: reply.id, body: ' \n\t ' })).toMatch(
      /^validation_failed: body: /,
    );
    const rows = ctx.db.orm.select().from(s.reply).all();
    expect(rows.map((row) => row.body)).toEqual(['Real text']);
  });
});

describe('MCP-06: get_attachment returns text for source files and diffs', () => {
  it('stores text types and returns the content, also for older rows', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Files' });
    const upload = (filename: string, content: Json) =>
      call<{ id: string; mimeType: string }>(client, 'upload_attachment', {
        item: 'WEB-1',
        filename,
        ...content,
      });
    const diff = '--- a/login.css\n+++ b/login.css\n@@ -1 +1 @@\n-a\n+b\n';
    const files = [
      await upload('fix.diff', { text: diff }),
      await upload('patch.ts', { text: 'export const x = 1;\n' }),
      await upload('Dockerfile', { text: 'FROM node:24\n' }),
      await upload('main.py', { contentBase64: Buffer.from('print("hi")\n').toString('base64') }),
    ];
    expect(files.map((file) => file.mimeType)).toEqual([
      'text/x-diff',
      'text/typescript',
      'text/plain',
      'text/x-python',
    ]);
    const first = await call<{ text: string | null }>(client, 'get_attachment', {
      attachment: files[0]?.id,
    });
    expect(first.text).toBe(diff);

    const binary = await upload('blob.bin', {
      contentBase64: Buffer.from([0, 1, 2, 255, 0]).toString('base64'),
    });
    expect(binary.mimeType).toBe('application/octet-stream');
    expect(
      (await call<{ text: string | null }>(client, 'get_attachment', { attachment: binary.id }))
        .text,
    ).toBeNull();

    // A row stored before text detection, under a binary type, still reads as text.
    ctx.db.orm
      .update(s.attachment)
      .set({ mimeType: 'video/mp2t' })
      .where(eq(s.attachment.id, files[1]?.id ?? ''))
      .run();
    expect(
      (await call<{ text: string | null }>(client, 'get_attachment', { attachment: files[1]?.id }))
        .text,
    ).toBe('export const x = 1;\n');
  });
});

// BAT-5: an agent couldn't see a screenshot that was a bug report's only evidence.
describe('BAT-5: get_attachment shows agents the image itself', () => {
  const png = (width: number, height: number, noise = false) => {
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let i = 0; i < raw.length; i += 1) {
      raw[i] = noise ? Math.floor(Math.random() * 256) : (i * 7) % 256;
    }
    return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
  };

  async function uploadImage(client: Client, filename: string, bytes: Buffer) {
    return call<{ id: string; mimeType: string }>(client, 'upload_attachment', {
      item: 'WEB-1',
      filename,
      contentBase64: bytes.toString('base64'),
    });
  }

  async function getImage(client: Client, id: string) {
    const result = await client.callTool({ name: 'get_attachment', arguments: { attachment: id } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const blocks = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
    const image = blocks.find((block) => block.type === 'image');
    return { json: result.structuredContent as Json, image };
  }

  it('returns a small image as it is', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Screenshot' });
    const bytes = await png(40, 20);
    const upload = await uploadImage(client, 'shot.png', bytes);
    const { json, image } = await getImage(client, upload.id);
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image?.data ?? '', 'base64').equals(bytes)).toBe(true);
    expect(json.image).toEqual({ mimeType: 'image/png', width: 40, height: 20, resized: false });
    expect(json.text).toBeNull();
  });

  it('scales big images down to 1568 px and 1 MB', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Screenshots' });
    const wide = await uploadImage(client, 'wide.png', await png(3136, 400));
    const shrunk = await getImage(client, wide.id);
    expect(shrunk.json.image).toEqual({
      mimeType: 'image/png',
      width: 1568,
      height: 200,
      resized: true,
    });
    const shrunkMeta = await sharp(Buffer.from(shrunk.image?.data ?? '', 'base64')).metadata();
    expect([shrunkMeta.width, shrunkMeta.height]).toEqual([1568, 200]);

    // Noise doesn't compress: the PNG would stay over 1 MB, so it becomes a JPEG.
    const noisy = await uploadImage(client, 'noise.png', await png(1400, 1000, true));
    const jpeg = await getImage(client, noisy.id);
    expect(jpeg.image?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(jpeg.image?.data ?? '', 'base64').length).toBeLessThanOrEqual(1_000_000);
    expect(jpeg.json.image).toMatchObject({ mimeType: 'image/jpeg', resized: true });
  });

  it('sends no image for other files', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Notes' });
    const text = await call<{ id: string }>(client, 'upload_attachment', {
      item: 'WEB-1',
      filename: 'notes.txt',
      text: 'hello',
    });
    const { json, image } = await getImage(client, text.id);
    expect(image).toBeUndefined();
    expect(json).toMatchObject({ text: 'hello', image: null });
  });
});

describe('MCP-07: not-found errors name the ref and the valid values', () => {
  it('says which value failed and what exists', async () => {
    const client = await connect(ethan);
    await seedLabels(client, ['bug', 'docs']);
    await call(client, 'create_task', { project: 'WEB', title: 'Labels' });
    await call(client, 'create_issue', { project: 'WEB', title: 'An issue' });

    const label = await callError(client, 'update_task', {
      task: 'WEB-1',
      labels: { add: ['bug', 'perf'] },
    });
    expect(label).toBe('not_found: Label not found: "perf" in northwind/WEB. Labels: bug, docs');
    expect(await callError(client, 'update_task', { task: 'WEB-1', status: 'Doing' })).toBe(
      'not_found: Status not found: "Doing" in northwind/WEB. Statuses: Open, Done',
    );
    expect(
      await callError(client, 'update_task', {
        task: 'WEB-1',
        assignees: { add: ['leo', 'nobody'] },
      }),
    ).toBe(
      'not_found: User not found: "nobody" is not a member of northwind. Members: ethan, ethan-ai, leo',
    );
    expect(await callError(client, 'get_task', { task: 'WEB#1' })).toMatch(
      /^validation_failed: "WEB#1" is an issue ref \(KEY#51\), not a task ref \(KEY-12\)/,
    );
    expect(await callError(client, 'get_task', { task: 'WEB-9' })).toBe(
      'not_found: Task not found: "WEB-9" in northwind/WEB',
    );
    expect(await callError(client, 'get_project', { project: 'Web App' })).toMatch(
      /^not_found: Project not found: "Web App"\. Use the project KEY, team-slug\/KEY or its id\. Your projects: northwind\/WEB \(Web App\)/,
    );
    expect(
      await callError(client, 'list_tasks', { project: 'northwind/WEB', status: ['x'] }),
    ).toContain('Statuses: Open, Done');
    expect(await callError(client, 'get_team', { team: 'agents' })).toBe(
      'not_found: Team not found: "agents". Your teams: northwind',
    );

    // App URLs work as refs.
    const byUrl = await call<{ ref: string }>(client, 'get_task', {
      task: `${ctx.env.baseUrl}/t/northwind/p/WEB/tasks/1`,
    });
    expect(byUrl.ref).toBe('northwind/WEB-1');
  });
});

describe('MCP-08: long threads, histories and lists are paged', () => {
  it('caps get_issue replies and pages list_replies, history and my_tasks', async () => {
    const client = await connect(ethan);
    await call(client, 'create_issue', { project: 'WEB', title: 'Busy thread' });
    for (let n = 1; n <= 25; n += 1) {
      await call(client, 'add_reply', { item: 'WEB#1', body: `Reply ${n}` });
    }
    const issue = await call<{ replyCount: number; replies: Array<{ body: string }> }>(
      client,
      'get_issue',
      { issue: 'WEB#1' },
    );
    expect(issue.replyCount).toBe(25);
    expect(issue.replies.map((reply) => reply.body)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Reply ${index + 6}`),
    );

    const pages: string[][] = [];
    let cursor: string | null | undefined;
    do {
      const page: { replies: Array<{ body: string }>; nextCursor: string | null; total: number } =
        await call(client, 'list_replies', {
          item: 'WEB#1',
          limit: 10,
          order: 'desc',
          ...(cursor ? { cursor } : {}),
        });
      expect(page.total).toBe(25);
      pages.push(page.replies.map((reply) => reply.body));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 5]);
    expect(pages[0]?.[0]).toBe('Reply 25');
    expect(pages[2]?.at(-1)).toBe('Reply 1');

    await call(client, 'create_task', { project: 'WEB', title: 'T', priority: 'high' });
    for (const title of ['Renamed 1', 'Renamed 2', 'Renamed 3']) {
      await call(client, 'update_task', { task: 'WEB-1', title });
    }
    const first = await call<{ items: Array<{ action: string }>; nextCursor: string | null }>(
      client,
      'get_activity',
      { item: 'WEB-1', limit: 2, order: 'desc' },
    );
    expect(first.items).toHaveLength(2);
    const rest = await call<{ items: Array<{ action: string }>; nextCursor: string | null }>(
      client,
      'get_activity',
      { item: 'WEB-1', limit: 10, order: 'desc', cursor: first.nextCursor },
    );
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.at(-1)?.action).toBe('task.created');

    for (let n = 2; n <= 5; n += 1) {
      await call(client, 'create_task', {
        project: 'WEB',
        title: `Mine ${n}`,
        // my_tasks through a key: the agent's own tasks (agents A).
        assignees: ['ethan-ai'],
      });
    }
    const mine1 = await call<{ total: number; tasks: unknown[]; nextCursor: string | null }>(
      client,
      'my_tasks',
      { limit: 3 },
    );
    expect(mine1).toMatchObject({ total: 4, returned: 3 });
    const mine2 = await call<{ total: number; tasks: unknown[]; nextCursor: string | null }>(
      client,
      'my_tasks',
      { limit: 3, cursor: mine1.nextCursor },
    );
    expect(mine2).toMatchObject({ total: 4, returned: 1, nextCursor: null });

    const dashboard = await call<{ activity: Array<Json> }>(client, 'dashboard_summary');
    expect(dashboard.activity.length).toBeGreaterThan(0);
    expect(dashboard.activity[0]).toMatchObject({ actor: 'ethan-ai', via: 'Agent' });
    expect(dashboard.activity[0]?.ref).toMatch(/^northwind\/WEB/);
  });
});

describe('MCP-09: error details reach the agent', () => {
  it('suggests a free key when a restored project’s key was taken', async () => {
    const client = await connect(ethan);
    await call(client, 'delete_project', { project: 'WEB' });
    await call(client, 'create_project', { team: 'northwind', name: 'New web', key: 'WEB' });
    const viaItem = await callError(client, 'restore_item', { item: web.project.id });
    expect(viaItem).toMatch(
      /^conflict: Another project now uses the key WEB\. Restore it with restore_project, passing project "\w+" and key \(e\.g\. "WEB2"\)\. \{"key":"WEB","suggestion":"WEB2"\}$/,
    );
    const viaProject = await callError(client, 'restore_project', { project: web.project.id });
    expect(viaProject).toContain('Call restore_project again with key (e.g. "WEB2")');
    await call(client, 'restore_project', { project: web.project.id, key: 'WEB2' });
  });
});

describe('MCP-10: errors name the MCP parameters and accepted values', () => {
  it('maps schema fields to parameters and lists priorities', async () => {
    const client = await connect(ethan);
    await call(client, 'create_task', { project: 'WEB', title: 'Fields' });
    expect(
      await callError(client, 'update_task', {
        task: 'WEB-1',
        assignees: { set: ['leo'], add: ['ethan'] },
      }),
    ).toBe('validation_failed: assignees: Use either set, or add/remove');
    expect(await callError(client, 'update_task', { task: 'WEB-1', priority: 'critical' })).toMatch(
      /Priority must be one of none, low, medium, high, urgent \(or 0–4\)/,
    );
    await call(client, 'move_task', { task: 'WEB-1', status: 'Done' });
    const done = await callError(client, 'claim_task', { task: 'WEB-1' });
    expect(done).toContain('WEB-1 is Done (done)');
    expect(done).not.toContain('moveToStatusId');
  });
});

describe('MCP-11: replies carry absolute URLs', () => {
  it('in add_reply, edit_reply and get_issue', async () => {
    const client = await connect(ethan);
    await call(client, 'create_issue', { project: 'WEB', title: 'Logs' });
    const file = await call<{ id: string }>(client, 'upload_attachment', {
      team: 'northwind',
      filename: 'log.txt',
      text: 'boom',
    });
    const reply = await call<{ id: string; attachments: Array<{ url: string }> }>(
      client,
      'add_reply',
      { item: 'WEB#1', body: 'Log attached', attachmentIds: [file.id] },
    );
    expect(reply.attachments[0]?.url).toBe(`${ctx.env.baseUrl}/api/attachments/${file.id}/log.txt`);
    const edited = await call<{ attachments: Array<{ url: string }> }>(client, 'edit_reply', {
      reply: reply.id,
      body: 'Log attached (edited)',
    });
    expect(edited.attachments[0]?.url.startsWith(ctx.env.baseUrl)).toBe(true);
    const issue = await call<{ replies: Array<{ url: string }> }>(client, 'get_issue', {
      issue: 'WEB#1',
    });
    expect(issue.replies[0]?.url).toBe(
      `${ctx.env.baseUrl}/t/northwind/p/WEB/issues/1#reply-${reply.id}`,
    );
  });
});

describe('MCP-17: tool annotations', () => {
  it('marks every tool closed-world and every write tool destructive or not', async () => {
    const client = await connect(ethan);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));
    expect(tools.filter((tool) => tool.annotations?.openWorldHint !== false)).toEqual([]);
    const undeclared = tools
      .filter(
        (tool) =>
          tool.annotations?.readOnlyHint !== true &&
          typeof tool.annotations?.destructiveHint !== 'boolean',
      )
      .map((tool) => tool.name);
    expect(undeclared).toEqual([]);
    for (const name of ['create_task', 'update_task', 'add_reply', 'claim_next_task']) {
      expect(byName.get(name)).toMatchObject({ destructiveHint: false });
    }
    for (const name of ['delete_task', 'delete_team', 'remove_member']) {
      expect(byName.get(name)).toMatchObject({ destructiveHint: true });
    }
    for (const name of ['renew_claim', 'subscribe', 'mark_notifications_read', 'join_team']) {
      expect(byName.get(name)).toMatchObject({ idempotentHint: true });
    }
  });
});
