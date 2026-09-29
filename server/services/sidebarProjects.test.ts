import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import { meResponseSchema } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { AppError } from '../lib/errors';
import {
  addMember,
  bearer,
  createApiKey,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { deleteProject } from './projects';
import { getMe, reorderMyProjects, reorderMyTeams } from './users';

/** BAT#27: each person's own order of a team's projects (within their team only). */

let ctx: TestContext;
let ethan: UserRow;
let mia: UserRow;
let acme: CreatedTeam;
let globex: CreatedTeam;

const person = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

const projectsOf = (user: UserRow, teamId: string) =>
  getMe(ctx.deps, person(user)).teams.find((team) => team.id === teamId)?.projects ?? [];
const keys = (user: UserRow, teamId: string) =>
  projectsOf(user, teamId).map((project) => project.key);
const idOf = (user: UserRow, teamId: string, key: string) =>
  projectsOf(user, teamId).find((project) => project.key === key)?.id as string;

function failure(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('Expected an error');
}

beforeEach(() => {
  ctx = createTestContext();
  ethan = createUser(ctx.db, { username: 'ethan' });
  mia = createUser(ctx.db, { username: 'mia' });
  acme = createTeam(ctx.db, { ownerId: ethan.id, name: 'Acme', slug: 'acme' });
  globex = createTeam(ctx.db, { ownerId: mia.id, name: 'Globex', slug: 'globex' });
  addMember(ctx.db, { teamId: acme.team.id, userId: mia.id });
  for (const key of ['API', 'DOCS', 'WEB']) {
    createProject(ctx.db, { teamId: acme.team.id, key, name: key });
  }
  createProject(ctx.db, { teamId: globex.team.id, key: 'GAME', name: 'GAME' });
});

afterEach(() => {
  ctx.close();
});

describe('sidebar project order', () => {
  it('lists projects by name until the person arranges them', () => {
    expect(keys(ethan, acme.team.id)).toEqual(['API', 'DOCS', 'WEB']);
  });

  it('keeps each person’s own order; new projects go to the end', () => {
    const events: LiveEvent[] = [];
    ctx.deps.events.subscribe((event) => events.push(event));
    const me = reorderMyProjects(ctx.deps, person(ethan), acme.team.id, {
      projectIds: ['WEB', 'API', 'DOCS'].map((key) => idOf(ethan, acme.team.id, key)),
    });
    expect(me.teams.find((team) => team.id === acme.team.id)?.projects.map((p) => p.key)).toEqual([
      'WEB',
      'API',
      'DOCS',
    ]);
    expect(events.map((event) => [event.type, event.userId])).toEqual([['me.updated', ethan.id]]);
    // Mia's order is her own.
    expect(keys(mia, acme.team.id)).toEqual(['API', 'DOCS', 'WEB']);

    // A project created after arranging follows the arranged ones, even if it sorts first.
    createProject(ctx.db, { teamId: acme.team.id, key: 'AAA', name: 'AAA' });
    expect(keys(ethan, acme.team.id)).toEqual(['WEB', 'API', 'DOCS', 'AAA']);

    // Arranging again replaces the team's order; ones left out follow by name.
    reorderMyProjects(ctx.deps, person(ethan), acme.team.id, {
      projectIds: [idOf(ethan, acme.team.id, 'DOCS')],
    });
    expect(keys(ethan, acme.team.id)).toEqual(['DOCS', 'AAA', 'API', 'WEB']);

    // A deleted project drops out; the rest keep their order.
    deleteProject(ctx.deps, person(ethan), idOf(ethan, acme.team.id, 'DOCS'));
    expect(keys(ethan, acme.team.id)).toEqual(['AAA', 'API', 'WEB']);
  });

  it('keeps the project order when the teams are reordered', () => {
    reorderMyProjects(ctx.deps, person(mia), acme.team.id, {
      projectIds: ['WEB', 'DOCS', 'API'].map((key) => idOf(mia, acme.team.id, key)),
    });
    reorderMyTeams(ctx.deps, person(mia), { teamIds: [globex.team.id, acme.team.id] });
    const teams = getMe(ctx.deps, person(mia)).teams;
    expect(teams.map((team) => team.name)).toEqual(['Globex', 'Acme']);
    expect(teams[1]?.projects.map((project) => project.key)).toEqual(['WEB', 'DOCS', 'API']);
  });

  it('moves projects within their own team only', () => {
    const game = idOf(mia, globex.team.id, 'GAME');
    const refused = failure(() =>
      reorderMyProjects(ctx.deps, person(mia), acme.team.id, { projectIds: [game] }),
    );
    expect(refused.code).toBe('validation_failed');
    expect(refused.message).toBe('Projects can only be reordered within their own team');
    // Not a member: the team doesn't exist for them.
    expect(
      failure(() =>
        reorderMyProjects(ctx.deps, person(ethan), globex.team.id, { projectIds: [game] }),
      ).code,
    ).toBe('not_found');
    expect(ctx.db.orm.select().from(s.sidebarProjectOrder).all()).toHaveLength(0);
  });

  it('works over REST and shows in GET /api/me', async () => {
    const { key } = createApiKey(ctx.db, { userId: ethan.id });
    const projectIds = ['WEB', 'DOCS', 'API'].map((k) => idOf(ethan, acme.team.id, k));
    const put = await ctx.app.request(
      `/api/me/teams/${acme.team.id}/projects/order`,
      json('PUT', { projectIds }, bearer(key)),
    );
    expect(put.status).toBe(200);
    const me = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(key) })).json(),
    );
    expect(me.teams[0]?.projects.map((project) => project.key)).toEqual(['WEB', 'DOCS', 'API']);

    const twice = await ctx.app.request(
      `/api/me/teams/${acme.team.id}/projects/order`,
      json('PUT', { projectIds: [projectIds[0], projectIds[0]] }, bearer(key)),
    );
    expect(twice.status).toBe(400);
    expect(apiErrorSchema.parse(await twice.json()).error.code).toBe('validation_failed');
  });
});
