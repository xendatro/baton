import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dashboardResponseSchema, myTasksResponseSchema } from '@shared/schemas/work';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createAgent,
  createApiKey,
  createProject,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';

let ctx: TestContext;
let owner: UserRow;
let ada: UserRow;
let key: string;
let teamId: string;

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  ada = createUser(ctx.db, { username: 'ada' });
  teamId = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' }).team.id;
  addMember(ctx.db, { teamId, userId: ada.id });
  key = createApiKey(ctx.db, { userId: ada.id }).key;
  const { project } = createProject(ctx.db, { teamId, key: 'WEB' });
  const task = createTask(ctx.db, { project, title: 'Ship it' });
  ctx.db.orm
    .insert(s.taskAssigneeUser)
    .values({ taskId: task.id, statusId: task.statusId, userId: ada.id })
    .run();
  // The key acts as Ada's agent (agents A): its work is what is assigned to the agent.
  const agentTask = createTask(ctx.db, { project, title: 'Write the tests' });
  const agent = createAgent(ctx.db, ada.id);
  ctx.db.orm
    .insert(s.taskAssigneeUser)
    .values({ taskId: agentTask.id, statusId: agentTask.statusId, userId: agent.id })
    .run();
});

afterEach(() => ctx.close());

describe('GET /api/me/tasks', () => {
  it('returns my open tasks for an API key (the agent’s) and a web session (the person’s)', async () => {
    const res = await ctx.app.request('/api/me/tasks?sort=due&due=none', { headers: bearer(key) });
    expect(res.status).toBe(200);
    const body = myTasksResponseSchema.parse(await res.json());
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ title: 'Write the tests', ref: 'WEB-2' });

    const cookie = await signIn(ctx, ada);
    const viaWeb = await ctx.app.request(`/api/me/tasks?teamId=${teamId}&priority=none,low`, {
      headers: web(ctx, cookie),
    });
    expect(myTasksResponseSchema.parse(await viaWeb.json()).total).toBe(1);
  });

  it('validates the query', async () => {
    for (const query of ['due=soon', 'priority=critical', 'sort=random', 'today=2026-02-30']) {
      const res = await ctx.app.request(`/api/me/tasks?${query}`, { headers: bearer(key) });
      expect(res.status, query).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'validation_failed',
      );
    }
  });

  it('answers 404 for a team the caller is not in, and 401 without credentials', async () => {
    const other = createTeam(ctx.db, { ownerId: owner.id, slug: 'other' }).team.id;
    const res = await ctx.app.request(`/api/me/tasks?teamId=${other}`, { headers: bearer(key) });
    expect(res.status).toBe(404);
    expect((await ctx.app.request('/api/me/tasks')).status).toBe(401);
  });
});

describe('GET /api/me/dashboard', () => {
  it('returns the dashboard in the documented shape', async () => {
    const res = await ctx.app.request('/api/me/dashboard?today=2026-03-10', {
      headers: bearer(key),
    });
    expect(res.status).toBe(200);
    const body = dashboardResponseSchema.parse(await res.json());
    expect(body.today).toBe('2026-03-10');
    expect(body.counts.assigned).toBe(1);
    expect(body.teams.map((team) => team.slug)).toEqual(['acme']);
  });

  it('rejects an invalid date and anonymous requests', async () => {
    const bad = await ctx.app.request('/api/me/dashboard?today=tomorrow', {
      headers: bearer(key),
    });
    expect(bad.status).toBe(400);
    expect((await ctx.app.request('/api/me/dashboard')).status).toBe(401);
  });
});
