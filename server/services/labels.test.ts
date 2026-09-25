import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  deleteLabelResponseSchema,
  labelListResponseSchema,
  labelSchema,
} from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createLabel, deleteLabel, updateLabel } from './labels';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let outsider: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let memberKey: string;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  outsider = createUser(ctx.db, { username: 'olga' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  memberKey = createApiKey(ctx.db, { userId: member.id }).key;
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function lastActivity(entityId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(eq(s.activity.entityId, entityId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .at(-1);
}

describe('labels', () => {
  it('lets members create labels by default (MANAGE_LABELS is an @everyone permission)', async () => {
    const res = await ctx.app.request(
      `/api/projects/${project.project.id}/labels`,
      json(
        'POST',
        { name: 'bug', color: '#EF4444', description: 'Something is broken' },
        bearer(memberKey),
      ),
    );
    expect(res.status).toBe(201);
    const label = labelSchema.parse(await res.json());
    expect(label).toMatchObject({
      name: 'bug',
      color: '#ef4444',
      description: 'Something is broken',
      issueCount: 0,
      taskCount: 0,
    });
    expect(lastActivity(label.id)).toMatchObject({
      action: 'label.created',
      source: 'api',
      meta: { name: 'bug' },
    });
    expect(events.map((event) => event.type)).toContain('label.changed');
  });

  it('refuses labels without MANAGE_LABELS and hides the project from outsiders', () => {
    ctx.db.orm
      .update(s.role)
      .set({ permissions: [] })
      .where(eq(s.role.id, team.everyoneRole.id))
      .run();
    expect(() =>
      createLabel(ctx.deps, actorOf(member), project.project.id, { name: 'bug' }),
    ).toThrow(/permission/);
    expect(() =>
      createLabel(ctx.deps, actorOf(outsider), project.project.id, { name: 'bug' }),
    ).toThrow(/not found/);
  });

  it('keeps names unique per project, ignoring case', () => {
    const bug = createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'Bug' });
    expect(() =>
      createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'bug' }),
    ).toThrow(/already a label named "Bug"/);
    const feature = createLabel(ctx.deps, actorOf(owner), project.project.id, {
      name: 'Feature',
    });
    expect(() => updateLabel(ctx.deps, actorOf(owner), feature.id, { name: 'BUG' })).toThrow(
      /already/,
    );
    // Changing only the case of its own name is fine.
    expect(updateLabel(ctx.deps, actorOf(owner), bug.id, { name: 'bug' }).name).toBe('bug');
    // Another project may reuse the name.
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    expect(createLabel(ctx.deps, actorOf(owner), other.project.id, { name: 'Bug' }).name).toBe(
      'Bug',
    );
  });

  it('lists labels alphabetically with usage on live issues and tasks', async () => {
    const bug = createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'bug' });
    createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'API' });
    const issue = createIssue(ctx.db, { project: project.project });
    const task = createTask(ctx.db, { project: project.project });
    const deletedTask = createTask(ctx.db, { project: project.project });
    ctx.db.orm
      .update(s.task)
      .set({ deletedAt: new Date() })
      .where(eq(s.task.id, deletedTask.id))
      .run();
    ctx.db.orm.insert(s.issueLabel).values({ issueId: issue.id, labelId: bug.id }).run();
    ctx.db.orm.insert(s.taskLabel).values({ taskId: task.id, labelId: bug.id }).run();
    ctx.db.orm.insert(s.taskLabel).values({ taskId: deletedTask.id, labelId: bug.id }).run();

    const res = await ctx.app.request(`/api/projects/${project.project.id}/labels`, {
      headers: bearer(memberKey),
    });
    const { items } = labelListResponseSchema.parse(await res.json());
    expect(items.map((label) => [label.name, label.issueCount, label.taskCount])).toEqual([
      ['API', 0, 0],
      ['bug', 1, 1],
    ]);
  });

  it('audits updates with field-level diffs', () => {
    const label = createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'bug' });
    const updated = updateLabel(ctx.deps, actorOf(owner), label.id, {
      name: 'defect',
      color: '#f97316',
      description: 'Broken behaviour',
    });
    expect(updated).toMatchObject({ name: 'defect', color: '#f97316' });
    expect(lastActivity(label.id)).toMatchObject({
      action: 'label.updated',
      changes: {
        name: { from: 'bug', to: 'defect' },
        color: { from: '#6b7280', to: '#f97316' },
        description: { from: '', to: 'Broken behaviour' },
      },
    });
  });

  it('removes a deleted label from every item and audits how many it touched', async () => {
    const label = createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'bug' });
    const issue = createIssue(ctx.db, { project: project.project });
    const task = createTask(ctx.db, { project: project.project });
    ctx.db.orm.insert(s.issueLabel).values({ issueId: issue.id, labelId: label.id }).run();
    ctx.db.orm.insert(s.taskLabel).values({ taskId: task.id, labelId: label.id }).run();

    const res = await ctx.app.request(`/api/labels/${label.id}`, {
      method: 'DELETE',
      headers: bearer(memberKey),
    });
    expect(deleteLabelResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      removedFrom: { issues: 1, tasks: 1 },
    });
    expect(ctx.db.orm.select().from(s.issueLabel).all()).toEqual([]);
    expect(ctx.db.orm.select().from(s.taskLabel).all()).toEqual([]);
    expect(lastActivity(label.id)).toMatchObject({
      action: 'label.deleted',
      meta: { name: 'bug', removedFromIssues: 1, removedFromTasks: 1 },
    });
    expect(() => deleteLabel(ctx.deps, actorOf(owner), label.id)).toThrow(/not found/);
  });

  it('hides labels of deleted projects', () => {
    const label = createLabel(ctx.deps, actorOf(owner), project.project.id, { name: 'bug' });
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, project.project.id))
      .run();
    expect(() => updateLabel(ctx.deps, actorOf(owner), label.id, { name: 'x' })).toThrow(
      /not found/,
    );
  });
});
