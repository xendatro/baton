import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import { meResponseSchema } from '@shared/schemas/core';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import {
  addMember,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';

/** Your own sidebar (BAT-36): team order, folded teams and pinned projects, through `/api/me`. */

let ctx: TestContext;
let user: UserRow;
let cookie: string;
let events: LiveEvent[];
let alpha: string;
let bravo: string;
let charlie: string;

beforeEach(async () => {
  ctx = createTestContext({ env: { LOG_LEVEL: 'silent' } });
  user = createUser(ctx.db, { username: 'ada', email: 'ada@example.test' });
  const other = createUser(ctx.db, { username: 'bob', email: 'bob@example.test' });
  cookie = await signIn(ctx, user);
  alpha = createTeam(ctx.db, { ownerId: user.id, name: 'Alpha' }).team.id;
  bravo = createTeam(ctx.db, { ownerId: other.id, name: 'Bravo' }).team.id;
  addMember(ctx.db, { teamId: bravo, userId: user.id });
  charlie = createTeam(ctx.db, { ownerId: user.id, name: 'Charlie' }).team.id;
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => ctx.close());

function request(method: string, url: string, body?: unknown, headers = web(ctx, cookie)) {
  return ctx.app.request(
    url,
    body === undefined ? { method, headers } : json(method, body, headers),
  );
}

async function me(headers = web(ctx, cookie)) {
  const res = await request('GET', '/api/me', undefined, headers);
  return meResponseSchema.parse(await res.json());
}

async function order() {
  return (await me()).teams.map((team) => team.name);
}

describe('sidebar order', () => {
  it('lists teams by name until you arrange them', async () => {
    const body = await me();
    expect(body.teams.map((team) => team.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(body.teams.every((team) => team.collapsed === false)).toBe(true);
  });

  it('saves your order and answers with the new me', async () => {
    const res = await request('PUT', '/api/me/teams/order', { teamIds: [charlie, alpha, bravo] });
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body.teams.map((team) => team.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(await order()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'me.updated', teamId: null, userId: user.id }),
    );
  });

  it('is personal: a teammate keeps their own order', async () => {
    await request('PUT', '/api/me/teams/order', { teamIds: [charlie, bravo, alpha] });
    const bob = createUser(ctx.db, { username: 'cy', email: 'cy@example.test' });
    addMember(ctx.db, { teamId: alpha, userId: bob.id });
    addMember(ctx.db, { teamId: charlie, userId: bob.id });
    const bobCookie = await signIn(ctx, bob);
    const theirs = await me(web(ctx, bobCookie));
    expect(theirs.teams.map((team) => team.name)).toEqual(['Alpha', 'Charlie']);
  });

  it('puts a team you join later after the arranged ones', async () => {
    await request('PUT', '/api/me/teams/order', { teamIds: [charlie, bravo, alpha] });
    const aardvark = createTeam(ctx.db, { ownerId: user.id, name: 'Aardvark' }).team.id;
    expect(await order()).toEqual(['Charlie', 'Bravo', 'Alpha', 'Aardvark']);
    await request('PUT', '/api/me/teams/order', { teamIds: [aardvark, charlie, bravo, alpha] });
    expect(await order()).toEqual(['Aardvark', 'Charlie', 'Bravo', 'Alpha']);
  });

  it('needs every one of your teams exactly once', async () => {
    const stranger = createUser(ctx.db, { username: 'eve', email: 'eve@example.test' });
    const foreign = createTeam(ctx.db, { ownerId: stranger.id, name: 'Foreign' }).team.id;
    for (const teamIds of [
      [alpha, bravo],
      [alpha, bravo, charlie, charlie],
      [alpha, bravo, foreign],
      [alpha, bravo, charlie, foreign],
    ]) {
      const res = await request('PUT', '/api/me/teams/order', { teamIds });
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('validation_failed');
    }
    expect(await order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(events.filter((event) => event.type === 'me.updated')).toHaveLength(0);
  });
});

describe('fold', () => {
  it('remembers a folded team', async () => {
    const res = await request('PATCH', `/api/me/teams/${bravo}`, { collapsed: true });
    expect(res.status).toBe(200);
    const body = await me();
    expect(body.teams.find((team) => team.id === bravo)?.collapsed).toBe(true);
    expect(body.teams.find((team) => team.id === alpha)?.collapsed).toBe(false);
  });

  it('is 404 for a team you are not in, and 400 with nothing to change', async () => {
    const stranger = createUser(ctx.db, { username: 'eve', email: 'eve@example.test' });
    const foreign = createTeam(ctx.db, { ownerId: stranger.id, name: 'Foreign' }).team.id;
    const res = await request('PATCH', `/api/me/teams/${foreign}`, { collapsed: true });
    expect(res.status).toBe(404);
    const empty = await request('PATCH', `/api/me/teams/${alpha}`, {});
    expect(empty.status).toBe(400);
  });

  it('no longer pins teams: a pin-only change is refused and the order stays', async () => {
    const res = await request('PATCH', `/api/me/teams/${charlie}`, { pinned: true });
    expect(res.status).toBe(400);
    expect(await order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('pinned projects', () => {
  let api: string;
  let web2: string;
  let game: string;

  beforeEach(() => {
    api = createProject(ctx.db, { teamId: alpha, key: 'API', name: 'Api' }).project.id;
    web2 = createProject(ctx.db, { teamId: alpha, key: 'WEB', name: 'Web' }).project.id;
    game = createProject(ctx.db, { teamId: bravo, key: 'GAME', name: 'Game' }).project.id;
  });

  const pinned = async () => (await me()).pinnedProjectIds;

  it('starts empty, pins in order across teams, and unpins', async () => {
    expect(await pinned()).toEqual([]);
    const res = await request('PUT', `/api/me/projects/${game}/pin`);
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).pinnedProjectIds).toEqual([game]);
    await request('PUT', `/api/me/projects/${api}/pin`);
    // Pinning again changes nothing (no duplicate, no event).
    await request('PUT', `/api/me/projects/${game}/pin`);
    expect(await pinned()).toEqual([game, api]);
    const unpin = await request('DELETE', `/api/me/projects/${game}/pin`);
    expect(unpin.status).toBe(200);
    expect(await pinned()).toEqual([api]);
    // Still listed under its team.
    expect((await me()).teams.find((t) => t.id === bravo)?.projects.map((p) => p.id)).toEqual([
      game,
    ]);
    expect(events.filter((event) => event.type === 'me.updated')).toHaveLength(3);
  });

  it('reorders the pinned section; unknown ids are refused', async () => {
    for (const id of [api, web2, game]) await request('PUT', `/api/me/projects/${id}/pin`);
    const res = await request('PUT', '/api/me/pinned-projects/order', {
      projectIds: [game, api],
    });
    expect(res.status).toBe(200);
    // Left out (web2) follows.
    expect(await pinned()).toEqual([game, api, web2]);
    await request('DELETE', `/api/me/projects/${api}/pin`);
    const bad = await request('PUT', '/api/me/pinned-projects/order', { projectIds: [api] });
    expect(bad.status).toBe(400);
    // A new pin goes last.
    await request('PUT', `/api/me/projects/${api}/pin`);
    expect(await pinned()).toEqual([game, web2, api]);
  });

  it('is personal', async () => {
    await request('PUT', `/api/me/projects/${api}/pin`);
    const cy = createUser(ctx.db, { username: 'cy', email: 'cy@example.test' });
    addMember(ctx.db, { teamId: alpha, userId: cy.id });
    const theirs = await me(web(ctx, await signIn(ctx, cy)));
    expect(theirs.pinnedProjectIds).toEqual([]);
  });

  it('only pins projects you can see, and hides pins you can no longer see', async () => {
    const stranger = createUser(ctx.db, { username: 'eve', email: 'eve@example.test' });
    const foreignTeam = createTeam(ctx.db, { ownerId: stranger.id, name: 'Foreign' }).team.id;
    const foreign = createProject(ctx.db, { teamId: foreignTeam, key: 'NOPE' }).project.id;
    const res = await request('PUT', `/api/me/projects/${foreign}/pin`);
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('not_found');

    await request('PUT', `/api/me/projects/${game}/pin`);
    await request('PUT', `/api/me/projects/${api}/pin`);
    // Hidden from you (no VIEW_PROJECT in Bravo, which you don't own): gone from the list.
    ctx.db.orm
      .insert(s.projectPermissionOverride)
      .values({ projectId: game, subjectType: 'user', subjectId: user.id, deny: ['VIEW_PROJECT'] })
      .run();
    expect(await pinned()).toEqual([api]);
    const hidden = await request('PUT', `/api/me/projects/${game}/pin`);
    expect(hidden.status).toBe(404);
    // Leaving the team drops its projects too.
    await request('PUT', `/api/me/projects/${api}/pin`);
    ctx.db.orm.delete(s.projectPermissionOverride).run();
    expect(await pinned()).toEqual([game, api]);
    await request('POST', `/api/teams/${bravo}/leave`);
    expect(await pinned()).toEqual([api]);
  });

  it('drops deleted projects from the list', async () => {
    await request('PUT', `/api/me/projects/${web2}/pin`);
    ctx.db.orm.update(s.project).set({ deletedAt: new Date() }).where(eq(s.project.id, web2)).run();
    expect(await pinned()).toEqual([]);
    expect((await request('PUT', `/api/me/projects/${web2}/pin`)).status).toBe(404);
  });
});
