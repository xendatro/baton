import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { listNotificationsQuerySchema } from '@shared/schemas/core';
import type { Actor } from './context';
import * as s from './db/schema';
import { runTrashPurge } from './jobs/purge';
import { registerTools } from './mcp/tools/index';
import { deleteAccount } from './services/account';
import { HISTORY_LIMIT, listEntityActivity } from './services/activity';
import { uploadAttachmentContent } from './services/attachments';
import { claimTask, releaseTask } from './services/claims';
import { createIssue, deleteIssue, updateIssue } from './services/issues';
import { removeMember } from './services/members';
import { listNotifications, unreadNotificationCount } from './services/notifications';
import { deleteProject, updateProject } from './services/projects';
import { deleteRole } from './services/roles';
import { createStatus, deleteStatus, updateStatus } from './services/statuses';
import { createTask, deleteTask, getTask, restoreTask, updateTask } from './services/tasks';
import {
  addMember,
  createApiKey,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type RoleRow,
  type StatusRow,
  type TestContext,
  type UserRow,
} from './test/helpers';

/**
 * Regression tests for the data-integrity findings CDI-01 … CDI-15: side effects, audit rows and
 * live events that a change must carry whichever path makes it.
 */

let ctx: TestContext;
let owner: UserRow;
let bob: UserRow;
let team: CreatedTeam;
let backend: RoleRow;
let api: CreatedProject;
let webProject: CreatedProject;
let open: StatusRow;
let done: StatusRow;
let events: LiveEvent[];
let clients: Client[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  bob = createUser(ctx.db, { username: 'bob' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  backend = createRole(ctx.db, { teamId: team.team.id, name: 'Backend', slug: 'backend' });
  addMember(ctx.db, { teamId: team.team.id, userId: bob.id, roleIds: [backend.id] });
  api = createProject(ctx.db, { teamId: team.team.id, key: 'API', createdById: owner.id });
  webProject = createProject(ctx.db, { teamId: team.team.id, key: 'WEB', createdById: owner.id });
  [open, done] = api.statuses as [StatusRow, StatusRow];
  events = [];
  clients = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

function taskRow(id: string) {
  const row = ctx.db.orm.select().from(s.task).where(eq(s.task.id, id)).get();
  if (!row) throw new Error('task missing');
  return row;
}

function actions(entityType: 'task' | 'issue', entityId: string): string[] {
  return ctx.db.orm
    .select({ action: s.activity.action })
    .from(s.activity)
    .where(and(eq(s.activity.entityType, entityType), eq(s.activity.entityId, entityId)))
    .orderBy(asc(s.activity.createdAt), asc(s.activity.id))
    .all()
    .map((row) => row.action);
}

function lastRow(entityType: 'task' | 'issue', entityId: string) {
  const rows = ctx.db.orm
    .select()
    .from(s.activity)
    .where(and(eq(s.activity.entityType, entityType), eq(s.activity.entityId, entityId)))
    .orderBy(asc(s.activity.createdAt), asc(s.activity.id))
    .all();
  return rows.at(-1);
}

function eventsOf(type: LiveEvent['type']): LiveEvent[] {
  return events.filter((event) => event.type === type);
}

function inbox(user: UserRow) {
  const actor = actorOf(user);
  return {
    count: unreadNotificationCount(ctx.deps, actor),
    items: listNotifications(ctx.deps, actor, listNotificationsQuerySchema.parse({})).items,
  };
}

async function mcpClient(user: UserRow): Promise<Client> {
  const { apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude' });
  const server = new McpServer({ name: 'baton-test', version: '0.0.0' });
  registerTools(server, { deps: ctx.deps, actor: { userId: user.id, source: 'mcp', key: apiKey } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe('CDI-01: deleting a status moves its tasks like any other move', () => {
  it('resolves fixes issues, notifies task_done, releases claims and audits each task', () => {
    const inProgress = createStatus(ctx.deps, actorOf(owner), api.project.id, {
      name: 'In progress',
      category: 'open',
    });
    const issue = createIssue(ctx.deps, actorOf(owner), api.project.id, { title: 'Crash' });
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Fix crash',
      statusId: inProgress.id,
      assigneeUserIds: [bob.id],
      issueLinks: [{ issueId: issue.id, kind: 'fixes' }],
    });
    claimTask(ctx.deps, actorOf(bob), task.id, {});
    expect(taskRow(task.id).claimedById).toBe(bob.id);
    const bobInbox = inbox(bob).count;
    events = [];

    const result = deleteStatus(ctx.deps, actorOf(owner), inProgress.id, { moveTo: done.id });

    expect(result).toEqual({ ok: true, movedTasks: 1 });
    const row = taskRow(task.id);
    expect(row.statusId).toBe(done.id);
    expect(row.completedAt).not.toBeNull();
    expect(row.claimedById).toBeNull();
    expect(row.claimExpiresAt).toBeNull();
    const resolved = ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get();
    expect(resolved?.resolved).toBe(true);
    expect(actions('issue', issue.id)).toContain('issue.resolved');
    expect(actions('task', task.id).slice(-2)).toEqual(['task.moved', 'task.released']);
    const moved = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.moved')))
      .get();
    expect(moved?.changes).toEqual({ status: { from: 'In progress', to: 'Done' } });
    expect(moved?.meta).toMatchObject({ ref: 'API-1', reason: 'status_deleted' });
    expect(
      inbox(bob)
        .items.filter((n) => n.type === 'task_done')
        .map((n) => n.entityId),
    ).toEqual([task.id]);
    expect(inbox(bob).count).toBe(bobInbox + 1);
    expect(eventsOf('task.released').map((event) => event.entityId)).toEqual([task.id]);
    expect(eventsOf('issue.updated').map((event) => event.entityId)).toEqual([issue.id]);
    expect(eventsOf('status.changed')).toHaveLength(1);
  });

  it('clears completedAt when the tasks leave done, and leaves tasks in Trash un-audited', () => {
    const shipped = createStatus(ctx.deps, actorOf(owner), api.project.id, {
      name: 'Shipped',
      category: 'done',
    });
    const live = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Live',
      statusId: shipped.id,
    });
    const trashed = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Trashed',
      statusId: shipped.id,
    });
    deleteTask(ctx.deps, actorOf(owner), trashed.id);

    deleteStatus(ctx.deps, actorOf(owner), shipped.id, { moveTo: open.id });

    expect(taskRow(live.id)).toMatchObject({ statusId: open.id, completedAt: null });
    expect(taskRow(trashed.id)).toMatchObject({ statusId: open.id, completedAt: null });
    expect(actions('task', live.id).at(-1)).toBe('task.moved');
    expect(actions('task', trashed.id).at(-1)).toBe('task.deleted');
  });
});

describe('CDI-03: assignees removed from outside the task are recorded on the task', () => {
  it('removing a member records task.updated on their tasks and announces it', () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Mine',
      assigneeUserIds: [bob.id, owner.id],
      assigneeRoleIds: [backend.id],
    });
    events = [];

    removeMember(ctx.deps, actorOf(owner), team.team.id, bob.id);

    const row = lastRow('task', task.id);
    expect(row?.action).toBe('task.updated');
    expect(row?.changes).toEqual({
      assignees: {
        from: ['@bob', '@owner', 'Backend (role)'],
        to: ['@owner', 'Backend (role)'],
      },
    });
    expect(row?.meta).toMatchObject({ ref: 'API-1', title: 'Mine', reason: 'member_removed' });
    expect(eventsOf('task.updated').map((event) => event.entityId)).toEqual([task.id]);
    const removed = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'member.removed'))
      .get();
    expect(removed?.meta).toMatchObject({ unassignedTasks: 1 });
  });

  it('deleting a role records task.updated on the tasks assigned to it', () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Backend work',
      assigneeRoleIds: [backend.id],
    });
    events = [];

    deleteRole(ctx.deps, actorOf(owner), team.team.id, backend.id);

    const row = lastRow('task', task.id);
    expect(row?.action).toBe('task.updated');
    expect(row?.changes).toEqual({ assignees: { from: ['Backend (role)'], to: [] } });
    expect(row?.meta).toMatchObject({ reason: 'role_deleted' });
    expect(eventsOf('task.updated').map((event) => event.entityId)).toEqual([task.id]);
    expect(getTask(ctx.deps, actorOf(owner), task.id).assignees).toEqual({ users: [], roles: [] });
  });

  it('deleting an account records task.updated on the tasks they were assigned', async () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Bob’s',
      assigneeUserIds: [bob.id],
    });
    events = [];

    await deleteAccount(ctx.deps, actorOf(bob), { confirmUsername: 'bob' });

    const row = lastRow('task', task.id);
    expect(row?.action).toBe('task.updated');
    expect(row?.changes).toEqual({ assignees: { from: ['@bob'], to: [] } });
    expect(row?.meta).toMatchObject({ reason: 'account_deleted' });
    expect(eventsOf('task.updated').map((event) => event.entityId)).toEqual([task.id]);
  });
});

describe('CDI-04: attaching files through a task update is audited', () => {
  it('records changes.attachments, bumps the activity time and emits task.updated', async () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, { title: 'Logs' });
    const before = taskRow(task.id).lastActivityAt;
    const file = await uploadAttachmentContent(ctx.deps, actorOf(owner), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'trace.log',
      text: 'boom',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    events = [];

    updateTask(ctx.deps, actorOf(owner), task.id, { attachmentIds: [file.id] });

    const row = lastRow('task', task.id);
    expect(row?.action).toBe('task.updated');
    expect(row?.changes).toEqual({ attachments: { from: [], to: ['trace.log'] } });
    expect(taskRow(task.id).lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
    expect(eventsOf('task.updated').map((event) => event.entityId)).toEqual([task.id]);
    expect(getTask(ctx.deps, actorOf(owner), task.id).attachments.map((a) => a.id)).toEqual([
      file.id,
    ]);
  });
});

describe('CDI-05: entity history keeps the newest rows', () => {
  it('drops the oldest rows past the cap, never the latest', () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, { title: 'Long' });
    const base = Date.now() - 60 * 60 * 1000;
    ctx.db.write((tx) => {
      // The task was created before its 1000 renewals.
      tx.update(s.activity)
        .set({ createdAt: new Date(base - 1000) })
        .where(and(eq(s.activity.entityId, task.id), eq(s.activity.action, 'task.created')))
        .run();
      for (let i = 0; i < HISTORY_LIMIT; i += 1) {
        tx.insert(s.activity)
          .values({
            teamId: team.team.id,
            projectId: api.project.id,
            actorId: owner.id,
            source: 'mcp',
            entityType: 'task',
            entityId: task.id,
            action: 'task.claim_renewed',
            changes: {},
            meta: {},
            createdAt: new Date(base + i),
          })
          .run();
      }
    });
    updateTask(ctx.deps, actorOf(owner), task.id, { title: 'Longer' });

    const { items } = listEntityActivity(ctx.deps, actorOf(owner), {
      entityType: 'task',
      entityId: task.id,
    });
    expect(items).toHaveLength(HISTORY_LIMIT);
    expect(items.at(-1)?.action).toBe('task.updated');
    // Oldest first, and the oldest rows are the ones left out (task.created is the very first).
    expect(items.map((item) => item.action)).not.toContain('task.created');
    const times = items.map((item) => item.createdAt);
    expect([...times].sort()).toEqual(times);
  });
});

describe('CDI-06: linked items in other projects are announced', () => {
  it('task changes emit issue.updated for linked issues of other projects', () => {
    const issue = createIssue(ctx.deps, actorOf(owner), webProject.project.id, { title: 'Bug' });
    const sameProject = createIssue(ctx.deps, actorOf(owner), api.project.id, { title: 'Local' });
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Fix',
      issueLinks: [
        { issueId: issue.id, kind: 'relates' },
        { issueId: sameProject.id, kind: 'relates' },
      ],
    });
    const linkedIssueEvents = () =>
      eventsOf('issue.updated').map((event) => [event.entityId, event.projectId]);

    events = [];
    updateTask(ctx.deps, actorOf(owner), task.id, { title: 'Fix it' });
    expect(linkedIssueEvents()).toEqual([[issue.id, webProject.project.id]]);

    events = [];
    deleteTask(ctx.deps, actorOf(owner), task.id);
    expect(linkedIssueEvents()).toEqual([[issue.id, webProject.project.id]]);

    events = [];
    restoreTask(ctx.deps, actorOf(owner), task.id);
    expect(linkedIssueEvents()).toEqual([[issue.id, webProject.project.id]]);

    events = [];
    updateStatus(ctx.deps, actorOf(owner), open.id, { name: 'Todo' });
    expect(linkedIssueEvents()).toEqual([[issue.id, webProject.project.id]]);
  });

  it('issue changes emit task.updated for linked tasks of other projects', () => {
    const issue = createIssue(ctx.deps, actorOf(owner), webProject.project.id, { title: 'Bug' });
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Fix',
      issueLinks: [{ issueId: issue.id, kind: 'relates' }],
    });
    const linkedTaskEvents = () =>
      eventsOf('task.updated').map((event) => [event.entityId, event.projectId]);

    events = [];
    updateIssue(ctx.deps, actorOf(owner), issue.id, { title: 'Bad bug' });
    expect(linkedTaskEvents()).toEqual([[task.id, api.project.id]]);

    events = [];
    deleteIssue(ctx.deps, actorOf(owner), issue.id);
    expect(linkedTaskEvents()).toEqual([[task.id, api.project.id]]);
  });
});

describe('CDI-08: the inbox hides notifications about trashed items', () => {
  it('an assignment on a deleted task leaves the list and the count until restored', async () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'T',
      assigneeUserIds: [bob.id],
    });
    expect(inbox(bob).count).toBe(1);

    deleteTask(ctx.deps, actorOf(owner), task.id);
    expect(inbox(bob)).toEqual({ count: 0, items: [] });
    const client = await mcpClient(bob);
    const result = await client.callTool({ name: 'list_notifications', arguments: {} });
    expect((result.structuredContent as { items: unknown[] }).items).toEqual([]);

    restoreTask(ctx.deps, actorOf(owner), task.id);
    expect(inbox(bob).count).toBe(1);
  });
});

describe('CDI-09: the trash purge removes notifications of purged projects', () => {
  it('drops README mention notifications with the project', () => {
    updateProject(ctx.deps, actorOf(owner), api.project.id, { readme: 'hi @bob' });
    const mentions = () =>
      ctx.db.orm
        .select()
        .from(s.notification)
        .where(and(eq(s.notification.userId, bob.id), eq(s.notification.entityType, 'project')))
        .all();
    expect(mentions()).toHaveLength(1);
    deleteProject(ctx.deps, actorOf(owner), api.project.id);
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
      .where(eq(s.project.id, api.project.id))
      .run();

    runTrashPurge(ctx.deps);

    expect(
      ctx.db.orm.select().from(s.project).where(eq(s.project.id, api.project.id)).get(),
    ).toBeUndefined();
    expect(mentions()).toEqual([]);
  });
});

describe('CDI-12: files added to a task are writes on the task', () => {
  it('uploading to the task (or to a reply on it) renews the holder’s claim', async () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, { title: 'Work' });
    claimTask(ctx.deps, actorOf(bob), task.id, { leaseMinutes: 5 });
    const soon = new Date(Date.now() + 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);
    ctx.db.orm
      .update(s.task)
      .set({ claimExpiresAt: soon, lastActivityAt: past })
      .where(eq(s.task.id, task.id))
      .run();

    await uploadAttachmentContent(ctx.deps, actorOf(bob), {
      teamId: team.team.id,
      parentType: 'task',
      parentId: task.id,
      filename: 'notes.md',
      text: '# notes',
    });

    const row = taskRow(task.id);
    expect(row.claimExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    expect(row.lastActivityAt.getTime()).toBeGreaterThan(past.getTime());
  });
});

describe('CDI-13: release_task with a note is one transaction', () => {
  it('posts the note and releases the claim in a single write', () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, { title: 'Work' });
    claimTask(ctx.deps, actorOf(bob), task.id, {});
    const write = ctx.deps.db.write.bind(ctx.deps.db);
    let writes = 0;
    ctx.deps.db.write = ((fn: Parameters<typeof write>[0]) => {
      writes += 1;
      return write(fn);
    }) as typeof write;

    releaseTask(ctx.deps, actorOf(bob), task.id, { note: 'stopping here' });

    ctx.deps.db.write = write;
    expect(writes).toBe(1);
    expect(taskRow(task.id).claimedById).toBeNull();
    const replies = ctx.db.orm.select().from(s.reply).where(eq(s.reply.parentId, task.id)).all();
    expect(replies.map((reply) => reply.body)).toEqual(['stopping here']);
    expect(actions('task', task.id).at(-1)).toBe('task.released');
  });
});

describe('CDI-15: MCP list_tasks takes the caller’s date for due filters', () => {
  it('uses `today` to decide what is due today or overdue', async () => {
    const task = createTask(ctx.deps, actorOf(owner), api.project.id, {
      title: 'Due',
      dueDate: '2031-03-10',
    });
    const client = await mcpClient(owner);
    const refs = async (args: Record<string, unknown>) => {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: { project: 'API', ...args },
      });
      expect(result.isError).toBeFalsy();
      return (result.structuredContent as { tasks: Array<{ ref: string }> }).tasks.map(
        (item) => item.ref,
      );
    };
    expect(await refs({ due: 'today', today: '2031-03-10' })).toEqual([`acme/${task.ref}`]);
    expect(await refs({ due: 'overdue', today: '2031-03-11' })).toEqual([`acme/${task.ref}`]);
    expect(await refs({ due: 'overdue', today: '2031-03-10' })).toEqual([]);
    // Without it, the server's UTC date (years before) is used.
    expect(await refs({ due: 'today' })).toEqual([]);
  });
});
