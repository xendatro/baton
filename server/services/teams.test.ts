import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { EVERYONE_DEFAULTS } from '@shared/permissions';
import { meResponseSchema } from '@shared/schemas/core';
import {
  deletedTeamsResponseSchema,
  teamDetailSchema,
  teamListResponseSchema,
  teamOverviewSchema,
  teamSlugFromName,
  slugify,
} from '@shared/schemas/teams';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createAgent,
  createApiKey,
  createIssue,
  createProject,
  createTask,
  createTeam as createTeamFixture,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { restoreItem } from './trash';
import {
  createTeam,
  deleteTeam,
  getTeamOverview,
  listDeletedTeams,
  restoreTeam,
  transferOwnership,
  updateTeam,
} from './teams';

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan' });
  mia = createUser(ctx.db, { username: 'mia' });
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function activity(action: string) {
  return ctx.db.orm.select().from(s.activity).where(eq(s.activity.action, action)).all();
}

describe('slugs', () => {
  it('derives URL slugs from names', () => {
    expect(slugify('  Crème Brûlée & Co.  ')).toBe('creme-brulee-co');
    expect(slugify('🚀🚀')).toBe('');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(teamSlugFromName('Acme Inc')).toBe('acme-inc');
    expect(teamSlugFromName('X')).toBe('team-x');
    expect(teamSlugFromName('🚀')).toBe('team');
  });
});

describe('createTeam', () => {
  it('creates the team with the owner, @everyone and Admin, audited and announced', () => {
    const team = createTeam(ctx.deps, actorOf(ethan), {
      name: 'Acme Inc',
      description: 'Rockets',
      icon: '🚀',
      color: '#22c55e',
    });
    expect(teamDetailSchema.parse(team)).toMatchObject({
      slug: 'acme-inc',
      name: 'Acme Inc',
      ownerId: ethan.id,
      memberCount: 1,
      owner: { username: 'ethan' },
    });
    const roles = ctx.db.orm.select().from(s.role).where(eq(s.role.teamId, team.id)).all();
    expect(roles.map((role) => [role.name, role.position, role.isEveryone])).toEqual(
      expect.arrayContaining([
        ['@everyone', 0, true],
        ['Admin', 1, false],
      ]),
    );
    expect(roles.find((role) => role.isEveryone)?.permissions).toEqual([...EVERYONE_DEFAULTS]);
    expect(roles.find((role) => !role.isEveryone)?.permissions).toEqual(['ADMINISTRATOR']);
    expect(activity('team.created')).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain('member.joined');
  });

  it('adds a numeric suffix to a derived slug that is taken, but refuses a taken explicit slug', () => {
    createTeam(ctx.deps, actorOf(ethan), { name: 'Acme' });
    const second = createTeam(ctx.deps, actorOf(mia), { name: 'Acme' });
    expect(second.slug).toBe('acme-2');
    expect(createTeam(ctx.deps, actorOf(mia), { name: 'ACME!' }).slug).toBe('acme-3');
    expect(() => createTeam(ctx.deps, actorOf(mia), { name: 'Other', slug: 'acme' })).toThrow(
      /already taken/,
    );
  });

  it('is reachable over REST for any verified user, with validation', async () => {
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    const res = await ctx.app.request(
      '/api/teams',
      json('POST', { name: 'Mia’s team', slug: 'Mias-Team' }, bearer(key)),
    );
    expect(res.status).toBe(201);
    // Agents never own teams: created through Mia's key, the team is Mia's (agents A).
    expect(teamDetailSchema.parse(await res.json())).toMatchObject({
      slug: 'mias-team',
      ownerId: mia.id,
    });

    const bad = await ctx.app.request(
      '/api/teams',
      json('POST', { name: '', icon: 'not an emoji', color: 'red' }, bearer(key)),
    );
    expect(bad.status).toBe(400);

    const me = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(key) })).json(),
    );
    expect(me.teams.map((team) => team.slug)).toEqual(['mias-team']);
    // Her agent, which created it, is its admin.
    expect(me.teams[0]).toMatchObject({
      isOwner: false,
      permissions: expect.arrayContaining(['ADMINISTRATOR']) as unknown,
    });

    const list = teamListResponseSchema.parse(
      await (await ctx.app.request('/api/teams', { headers: bearer(key) })).json(),
    );
    expect(list.items).toHaveLength(1);
  });
});

describe('reading teams', () => {
  it('hides teams from non-members (404)', async () => {
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    const { key } = createApiKey(ctx.db, { userId: mia.id });
    for (const path of [`/api/teams/${team.id}`, `/api/teams/${team.id}/overview`]) {
      expect((await ctx.app.request(path, { headers: bearer(key) })).status).toBe(404);
    }
  });

  it('lists project cards with open task and unresolved issue counts', () => {
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    const web = createProject(ctx.db, { teamId: team.id, key: 'WEB', name: 'Web' });
    const api = createProject(ctx.db, { teamId: team.id, key: 'API', name: 'API' });
    const gone = createProject(ctx.db, { teamId: team.id, key: 'OLD', name: 'Old' });
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, gone.project.id))
      .run();
    const done = web.statuses.find((status) => status.category === 'done');
    createTask(ctx.db, { project: web.project });
    createTask(ctx.db, { project: web.project });
    createTask(ctx.db, { project: web.project, statusId: done?.id });
    const deletedTask = createTask(ctx.db, { project: web.project });
    ctx.db.orm
      .update(s.task)
      .set({ deletedAt: new Date() })
      .where(eq(s.task.id, deletedTask.id))
      .run();
    createIssue(ctx.db, { project: web.project });
    const resolved = createIssue(ctx.db, { project: web.project });
    ctx.db.orm.update(s.issue).set({ resolved: true }).where(eq(s.issue.id, resolved.id)).run();

    const overview = teamOverviewSchema.parse(getTeamOverview(ctx.deps, actorOf(ethan), team.id));
    expect(overview.projects.map((p) => [p.key, p.openTasks, p.openIssues])).toEqual([
      ['API', 0, 0],
      ['WEB', 2, 1],
    ]);
    expect(api.project.id).toBe(overview.projects[0]?.id);
  });
});

describe('updateTeam', () => {
  it('needs Manage team and records field-level changes', () => {
    const { team, adminRole } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    addMember(ctx.db, { teamId: team.id, userId: mia.id });
    expect(() => updateTeam(ctx.deps, actorOf(mia), team.id, { name: 'Nope' })).toThrow(
      /permission/,
    );

    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.id, userId: mia.id, roleId: adminRole.id })
      .run();
    const updated = updateTeam(ctx.deps, actorOf(mia), team.id, {
      name: 'Acme Corp',
      slug: 'acme-corp',
      icon: '🛰️',
      description: team.description,
    });
    expect(updated).toMatchObject({ name: 'Acme Corp', slug: 'acme-corp', icon: '🛰️' });
    const [row] = activity('team.updated');
    expect(row?.changes).toEqual({
      name: { from: team.name, to: 'Acme Corp' },
      slug: { from: 'acme', to: 'acme-corp' },
      icon: { from: null, to: '🛰️' },
    });
    expect(events.some((event) => event.type === 'team.updated')).toBe(true);

    // No-op updates write nothing.
    updateTeam(ctx.deps, actorOf(mia), team.id, { name: 'Acme Corp' });
    expect(activity('team.updated')).toHaveLength(1);
  });

  it('refuses a slug another team uses', () => {
    createTeamFixture(ctx.db, { ownerId: mia.id, slug: 'taken' });
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    expect(() => updateTeam(ctx.deps, actorOf(ethan), team.id, { slug: 'taken' })).toThrow(
      /already taken/,
    );
  });
});

describe('deleting and restoring', () => {
  it('only the owner can delete; the team disappears for everyone and can be restored', async () => {
    const { team, adminRole } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    addMember(ctx.db, { teamId: team.id, userId: mia.id, roleIds: [adminRole.id] });
    expect(() => deleteTeam(ctx.deps, actorOf(mia), team.id)).toThrow(/owner/);

    // Owner-only, so never through a key: keys act as the owner's agent (agents A).
    const { key: agentKey } = createApiKey(ctx.db, { userId: ethan.id });
    const refused = await ctx.app.request(`/api/teams/${team.id}`, {
      method: 'DELETE',
      headers: bearer(agentKey),
    });
    expect(refused.status).toBe(403);
    const session = web(ctx, await signIn(ctx, ethan));
    const res = await ctx.app.request(`/api/teams/${team.id}`, {
      method: 'DELETE',
      headers: session,
    });
    expect(res.status).toBe(200);
    expect(activity('team.deleted')).toHaveLength(1);
    expect(events.some((event) => event.type === 'team.deleted')).toBe(true);
    expect((await ctx.app.request(`/api/teams/${team.id}`, { headers: session })).status).toBe(404);

    const deleted = deletedTeamsResponseSchema.parse(
      await (await ctx.app.request('/api/me/deleted-teams', { headers: session })).json(),
    );
    expect(deleted.items).toHaveLength(1);
    const [item] = deleted.items;
    expect(new Date(item?.purgeAt ?? 0).getTime() - new Date(item?.deletedAt ?? 0).getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    // Not listed for other members, nor restorable by them.
    expect(listDeletedTeams(ctx.deps, actorOf(mia)).items).toEqual([]);
    expect(() => restoreTeam(ctx.deps, actorOf(mia), team.id)).toThrow(/not found/);

    const restored = await ctx.app.request(
      `/api/teams/${team.id}/restore`,
      json('POST', {}, session),
    );
    expect(restored.status).toBe(200);
    expect(teamDetailSchema.parse(await restored.json()).slug).toBe('acme');
    expect(activity('team.restored')).toHaveLength(1);
    const restoreEvents = events.filter((event) => event.type === 'me.updated');
    expect(restoreEvents[0]?.userId).toBe(ethan.id);
  });

  it('does not list teams deleted more than 30 days ago', () => {
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id });
    ctx.db.orm
      .update(s.team)
      .set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(s.team.id, team.id))
      .run();
    expect(listDeletedTeams(ctx.deps, actorOf(ethan)).items).toEqual([]);
  });

  it('restores under a numbered slug when the old one was taken', () => {
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    deleteTeam(ctx.deps, actorOf(ethan), team.id);
    createTeam(ctx.deps, actorOf(mia), { name: 'Acme', slug: 'acme' });
    const restored = restoreTeam(ctx.deps, actorOf(ethan), team.id);
    expect(restored.slug).toBe('acme-2');
    expect(activity('team.restored')[0]?.changes).toEqual({
      slug: { from: 'acme', to: 'acme-2' },
    });
  });

  it('is registered with the trash registry', () => {
    const { team } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    deleteTeam(ctx.deps, actorOf(ethan), team.id);
    restoreItem(ctx.deps, actorOf(ethan), { type: 'team', id: team.id });
    const row = ctx.db.orm.select().from(s.team).where(eq(s.team.id, team.id)).get();
    expect(row?.deletedAt).toBeNull();
  });
});

describe('transferOwnership', () => {
  it('hands the team to another member; only the owner can', async () => {
    const { team, adminRole } = createTeamFixture(ctx.db, { ownerId: ethan.id, slug: 'acme' });
    addMember(ctx.db, { teamId: team.id, userId: mia.id, roleIds: [adminRole.id] });
    const outsider = createUser(ctx.db, { username: 'olga' });
    expect(() => transferOwnership(ctx.deps, actorOf(mia), team.id, { userId: mia.id })).toThrow(
      /owner/,
    );
    expect(() =>
      transferOwnership(ctx.deps, actorOf(ethan), team.id, { userId: outsider.id }),
    ).toThrow(/Member not found/);
    expect(() =>
      transferOwnership(ctx.deps, actorOf(ethan), team.id, { userId: ethan.id }),
    ).toThrow(/already own/);

    // Agents never own teams, nor hand them over (agents A).
    const { key } = createApiKey(ctx.db, { userId: ethan.id, name: 'Claude' });
    const miaAgent = createAgent(ctx.db, mia.id);
    expect(() =>
      transferOwnership(ctx.deps, actorOf(ethan), team.id, { userId: miaAgent.id }),
    ).toThrow(/Agents can’t own teams/);
    const byAgent = await ctx.app.request(
      `/api/teams/${team.id}/transfer`,
      json('POST', { userId: mia.id }, bearer(key)),
    );
    expect(byAgent.status).toBe(403);

    const cookie = await signIn(ctx, ethan);
    const res = await ctx.app.request(
      `/api/teams/${team.id}/transfer`,
      json('POST', { userId: mia.id }, web(ctx, cookie)),
    );
    expect(res.status).toBe(200);
    expect(teamDetailSchema.parse(await res.json()).ownerId).toBe(mia.id);
    const [row] = activity('team.ownership_transferred');
    expect(row).toMatchObject({
      source: 'web',
      changes: { owner: { from: 'ethan', to: 'mia' } },
    });
    // The previous owner stays a member.
    const membership = ctx.db.orm
      .select()
      .from(s.teamMember)
      .where(and(eq(s.teamMember.teamId, team.id), eq(s.teamMember.userId, ethan.id)))
      .get();
    expect(membership).toBeDefined();
  });
});
