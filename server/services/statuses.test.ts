import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import {
  deleteStatusResponseSchema,
  statusListResponseSchema,
  statusSchema,
} from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  giveRoleWithAgent,
  json,
  type CreatedProject,
  type CreatedTeam,
  type StatusRow,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createStatus, deleteStatus, reorderStatuses, updateStatus } from './statuses';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let open: StatusRow;
let done: StatusRow;
let ownerKey: string;
let memberKey: string;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  [open, done] = project.statuses as [StatusRow, StatusRow];
  ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
  memberKey = createApiKey(ctx.db, { userId: member.id }).key;
  // Keys act as their owner's agent member, capped by the owner (agents A): the owner's agent
  // administers the team with him.
  giveAgentOwnerRoles(ctx.db, owner.id);
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function statusRows() {
  return ctx.db.orm
    .select()
    .from(s.status)
    .where(eq(s.status.projectId, project.project.id))
    .orderBy(asc(s.status.position))
    .all();
}

function taskRow(id: string) {
  const row = ctx.db.orm.select().from(s.task).where(eq(s.task.id, id)).get();
  if (!row) throw new Error('task missing');
  return row;
}

function lastActivity(entityId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(eq(s.activity.entityId, entityId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .at(-1);
}

/** Grants MANAGE_STATUSES to `user` and their agent member (what their keys act as). */
function grantStatuses(user: UserRow) {
  const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_STATUSES'] });
  giveRoleWithAgent(ctx.db, { teamId: team.team.id, userId: user.id, roleId: role.id });
}

describe('statuses over REST', () => {
  it('lists statuses in order with task counts (any member)', async () => {
    createTask(ctx.db, { project: project.project });
    createTask(ctx.db, { project: project.project, statusId: done.id });
    const res = await ctx.app.request(`/api/projects/${project.project.id}/statuses`, {
      headers: bearer(memberKey),
    });
    const { items } = statusListResponseSchema.parse(await res.json());
    expect(items.map((status) => [status.name, status.position, status.taskCount])).toEqual([
      ['Open', 0, 1],
      ['Done', 1, 1],
    ]);
  });

  it('creates a status at the end; names are unique ignoring case', async () => {
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/statuses`,
      json('POST', { name: 'In review', color: '#8B5CF6' }, bearer(ownerKey)),
    );
    expect(res.status).toBe(201);
    const status = statusSchema.parse(await res.json());
    expect(status).toMatchObject({
      name: 'In review',
      color: '#8b5cf6',
      category: 'open',
      position: 2,
      isDefault: false,
      taskCount: 0,
    });
    expect(lastActivity(status.id)).toMatchObject({
      action: 'status.created',
      meta: { name: 'In review', category: 'open' },
    });
    expect(events.map((event) => event.type)).toContain('status.changed');

    const duplicate = await ctx.app.request(
      `/api/projects/${project.project.id}/statuses`,
      json('POST', { name: 'in REVIEW' }, bearer(ownerKey)),
    );
    expect(duplicate.status).toBe(409);
  });

  it('needs MANAGE_STATUSES for every change', async () => {
    const create = await ctx.app.request(
      `/api/projects/${project.project.id}/statuses`,
      json('POST', { name: 'Doing' }, bearer(memberKey)),
    );
    expect(create.status).toBe(403);
    const update = await ctx.app.request(
      `/api/statuses/${open.id}`,
      json('PATCH', { name: 'Todo' }, bearer(memberKey)),
    );
    expect(update.status).toBe(403);
    const remove = await ctx.app.request(`/api/statuses/${open.id}?moveTo=${done.id}`, {
      method: 'DELETE',
      headers: bearer(memberKey),
    });
    expect(remove.status).toBe(403);
    const reorder = await ctx.app.request(
      `/api/projects/${project.project.id}/statuses/order`,
      json('PUT', { statusIds: [done.id, open.id] }, bearer(memberKey)),
    );
    expect(reorder.status).toBe(403);

    grantStatuses(member);
    const allowed = await ctx.app.request(
      `/api/statuses/${open.id}`,
      json('PATCH', { name: 'Todo' }, bearer(memberKey)),
    );
    expect(allowed.status).toBe(200);
  });

  it('requires moveTo when deleting', async () => {
    const res = await ctx.app.request(`/api/statuses/${open.id}`, {
      method: 'DELETE',
      headers: bearer(ownerKey),
    });
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_failed');
  });
});

describe('default status', () => {
  it('keeps exactly one default', () => {
    const doing = createStatus(ctx.deps, actorOf(owner), project.project.id, {
      name: 'Doing',
      category: 'open',
      isDefault: true,
    });
    expect(
      statusRows()
        .filter((row) => row.isDefault)
        .map((row) => row.id),
    ).toEqual([doing.id]);

    const updated = updateStatus(ctx.deps, actorOf(owner), open.id, { isDefault: true });
    expect(updated.isDefault).toBe(true);
    expect(
      statusRows()
        .filter((row) => row.isDefault)
        .map((row) => row.name),
    ).toEqual(['Open']);
    expect(lastActivity(open.id)).toMatchObject({
      action: 'status.updated',
      changes: { isDefault: { from: false, to: true } },
      meta: { previousDefault: 'Doing' },
    });
  });
});

describe('recategorizing', () => {
  it('sets and clears completedAt on its tasks, audited once with the count', () => {
    const a = createTask(ctx.db, { project: project.project });
    const b = createTask(ctx.db, { project: project.project });
    const trashed = createTask(ctx.db, { project: project.project });
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, trashed.id)).run();

    const status = updateStatus(ctx.deps, actorOf(owner), open.id, {
      name: 'Shipped',
      category: 'done',
    });
    expect(status).toMatchObject({ name: 'Shipped', category: 'done' });
    for (const task of [a, b, trashed]) expect(taskRow(task.id).completedAt).toBeInstanceOf(Date);
    expect(lastActivity(open.id)).toMatchObject({
      changes: { name: { from: 'Open', to: 'Shipped' }, category: { from: 'open', to: 'done' } },
      meta: { name: 'Shipped', tasksAffected: 2 },
    });

    updateStatus(ctx.deps, actorOf(owner), open.id, { category: 'open' });
    for (const task of [a, b, trashed]) expect(taskRow(task.id).completedAt).toBeNull();
  });

  it('writes nothing when nothing changes', () => {
    const before = ctx.db.orm.select().from(s.activity).all().length;
    updateStatus(ctx.deps, actorOf(owner), open.id, { name: 'Open', color: open.color });
    expect(ctx.db.orm.select().from(s.activity).all()).toHaveLength(before);
  });
});

describe('reordering', () => {
  it('reorders every status and audits the new order', async () => {
    const review = createStatus(ctx.deps, actorOf(owner), project.project.id, {
      name: 'Review',
      category: 'open',
    });
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/statuses/order`,
      json('PUT', { statusIds: [review.id, open.id, done.id] }, bearer(ownerKey)),
    );
    const { items } = statusListResponseSchema.parse(await res.json());
    expect(items.map((status) => [status.name, status.position])).toEqual([
      ['Review', 0],
      ['Open', 1],
      ['Done', 2],
    ]);
    expect(lastActivity(project.project.id)).toMatchObject({
      entityType: 'project',
      action: 'project.statuses_reordered',
      changes: {
        statusOrder: { from: 'Open → Done → Review', to: 'Review → Open → Done' },
      },
    });
  });

  it('rejects partial, duplicate or foreign lists', () => {
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const reorder = (statusIds: string[]) =>
      reorderStatuses(ctx.deps, actorOf(owner), project.project.id, { statusIds });
    expect(() => reorder([open.id])).toThrow(/exactly once/);
    expect(() => reorder([open.id, open.id])).toThrow(/exactly once/);
    expect(() => reorder([open.id, other.statuses[0]?.id ?? ''])).toThrow(/exactly once/);
  });
});

describe('deleting', () => {
  it('moves tasks to the end of the target column and passes the default on', async () => {
    const review = createStatus(ctx.deps, actorOf(owner), project.project.id, {
      name: 'Review',
      category: 'open',
    });
    const existing = createTask(ctx.db, { project: project.project, statusId: done.id });
    const first = createTask(ctx.db, { project: project.project, statusId: open.id });
    const second = createTask(ctx.db, { project: project.project, statusId: open.id });

    const res = await ctx.app.request(`/api/statuses/${open.id}?moveTo=${done.id}`, {
      method: 'DELETE',
      headers: bearer(ownerKey),
    });
    expect(deleteStatusResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      movedTasks: 2,
    });

    const moved = [existing, first, second].map((task) => taskRow(task.id));
    expect(moved.map((task) => task.statusId)).toEqual([done.id, done.id, done.id]);
    const positions = moved.map((task) => task.position);
    expect([...positions].sort()).toEqual(positions);
    expect(moved[1]?.completedAt).toBeInstanceOf(Date);

    expect(statusRows().map((row) => [row.name, row.position, row.isDefault])).toEqual([
      ['Done', 0, true],
      ['Review', 1, false],
    ]);
    expect(lastActivity(open.id)).toMatchObject({
      action: 'status.deleted',
      meta: { name: 'Open', movedTo: 'Done', movedTasks: 2, newDefault: 'Done' },
    });
    expect(review.position).toBe(2);
  });

  it('clears completion when tasks move to an open status', () => {
    const task = createTask(ctx.db, { project: project.project, statusId: done.id });
    ctx.db.orm.update(s.task).set({ completedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    deleteStatus(ctx.deps, actorOf(owner), done.id, { moveTo: open.id });
    expect(taskRow(task.id)).toMatchObject({ statusId: open.id, completedAt: null });
  });

  it('refuses to delete the last status or to move tasks into the deleted one', () => {
    expect(() => deleteStatus(ctx.deps, actorOf(owner), open.id, { moveTo: open.id })).toThrow(
      /another status/,
    );
    deleteStatus(ctx.deps, actorOf(owner), done.id, { moveTo: open.id });
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    expect(() =>
      deleteStatus(ctx.deps, actorOf(owner), open.id, { moveTo: other.statuses[0]?.id ?? '' }),
    ).toThrow(/last status/);
  });

  it('refuses a target from another project', () => {
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    expect(() =>
      deleteStatus(ctx.deps, actorOf(owner), open.id, { moveTo: other.statuses[0]?.id ?? '' }),
    ).toThrow(/Status to move the tasks to not found/);
  });
});
