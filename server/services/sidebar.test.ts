import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import { meResponseSchema } from '@shared/schemas/core';
import {
  addMember,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';

/** Your own sidebar (BAT-36): team order, pins and folded teams, through `/api/me`. */

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
    expect(body.teams.every((team) => team.pinned === false && team.collapsed === false)).toBe(
      true,
    );
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

describe('pin and fold', () => {
  it('pins a team to the top, keeping the order within pinned and unpinned', async () => {
    await request('PUT', '/api/me/teams/order', { teamIds: [alpha, bravo, charlie] });
    const res = await request('PATCH', `/api/me/teams/${charlie}`, { pinned: true });
    expect(res.status).toBe(200);
    const body = meResponseSchema.parse(await res.json());
    expect(body.teams.map((team) => [team.name, team.pinned])).toEqual([
      ['Charlie', true],
      ['Alpha', false],
      ['Bravo', false],
    ]);
    await request('PATCH', `/api/me/teams/${bravo}`, { pinned: true });
    expect(await order()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    await request('PATCH', `/api/me/teams/${charlie}`, { pinned: false });
    expect(await order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(events.filter((event) => event.type === 'me.updated')).toHaveLength(4);
  });

  it('remembers a folded team', async () => {
    await request('PATCH', `/api/me/teams/${bravo}`, { collapsed: true });
    const body = await me();
    expect(body.teams.find((team) => team.id === bravo)).toMatchObject({
      collapsed: true,
      pinned: false,
    });
    expect(body.teams.find((team) => team.id === alpha)?.collapsed).toBe(false);
  });

  it('is 404 for a team you are not in, and 400 with nothing to change', async () => {
    const stranger = createUser(ctx.db, { username: 'eve', email: 'eve@example.test' });
    const foreign = createTeam(ctx.db, { ownerId: stranger.id, name: 'Foreign' }).team.id;
    const res = await request('PATCH', `/api/me/teams/${foreign}`, { pinned: true });
    expect(res.status).toBe(404);
    const empty = await request('PATCH', `/api/me/teams/${alpha}`, {});
    expect(empty.status).toBe(400);
  });

  it('forgets the pin when you leave and rejoin', async () => {
    await request('PATCH', `/api/me/teams/${bravo}`, { pinned: true });
    const leave = await request('POST', `/api/teams/${bravo}/leave`);
    expect(leave.status).toBeLessThan(300);
    expect(await order()).toEqual(['Alpha', 'Charlie']);
    addMember(ctx.db, { teamId: bravo, userId: user.id });
    const body = await me();
    expect(body.teams.find((team) => team.id === bravo)?.pinned).toBe(false);
  });
});
