import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meResponseSchema, mentionablesResponseSchema } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { AppError } from '../lib/errors';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import {
  resolveIssue,
  resolveLabel,
  resolveProject,
  resolveRole,
  resolveStatus,
  resolveTask,
  resolveTeam,
  resolveUser,
} from './refs';

let ctx: TestContext;
let me: UserRow;

const actorOf = (u: { id: string }): Actor => ({ userId: u.id, source: 'mcp', key: null });

beforeEach(() => {
  ctx = createTestContext();
  me = createUser(ctx.db, { username: 'ethan' });
});

afterEach(() => {
  ctx.close();
});

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('team, project, task and issue refs', () => {
  it('resolves by slug, key, team/KEY and id within the caller’s teams', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id, slug: 'acme' });
    const api = createProject(ctx.db, { teamId: acme.team.id, key: 'API' });
    const task = createTask(ctx.db, { project: api.project });
    const issue = createIssue(ctx.db, { project: api.project });

    expect(resolveTeam(ctx.deps, actorOf(me), 'ACME').team.id).toBe(acme.team.id);
    expect(resolveTeam(ctx.deps, actorOf(me), acme.team.id).membership.isOwner).toBe(true);
    expect(resolveProject(ctx.deps, actorOf(me), 'api').project.id).toBe(api.project.id);
    expect(resolveProject(ctx.deps, actorOf(me), 'acme/API').project.id).toBe(api.project.id);
    expect(resolveProject(ctx.deps, actorOf(me), api.project.id).team.slug).toBe('acme');
    expect(resolveTask(ctx.deps, actorOf(me), 'API-1').task.id).toBe(task.id);
    expect(resolveTask(ctx.deps, actorOf(me), 'acme/api-1').task.id).toBe(task.id);
    expect(resolveTask(ctx.deps, actorOf(me), task.id).task.number).toBe(1);
    expect(resolveIssue(ctx.deps, actorOf(me), 'API#1').issue.id).toBe(issue.id);
    expect(errorOf(() => resolveTask(ctx.deps, actorOf(me), 'API#1')).code).toBe('not_found');
    expect(errorOf(() => resolveTask(ctx.deps, actorOf(me), 'API-2')).code).toBe('not_found');
  });

  it('hides other teams’ entities as not found', () => {
    const stranger = createUser(ctx.db);
    const theirs = createTeam(ctx.db, { ownerId: stranger.id, slug: 'theirs' });
    const project = createProject(ctx.db, { teamId: theirs.team.id, key: 'SEC' });
    const task = createTask(ctx.db, { project: project.project });
    for (const fn of [
      () => resolveTeam(ctx.deps, actorOf(me), 'theirs'),
      () => resolveProject(ctx.deps, actorOf(me), 'SEC'),
      () => resolveProject(ctx.deps, actorOf(me), project.project.id),
      () => resolveTask(ctx.deps, actorOf(me), 'theirs/SEC-1'),
      () => resolveTask(ctx.deps, actorOf(me), task.id),
    ]) {
      expect(errorOf(fn).code).toBe('not_found');
    }
  });

  it('reports ambiguous keys with the candidates', () => {
    const a = createTeam(ctx.db, { ownerId: me.id, slug: 'team-a' });
    const b = createTeam(ctx.db, { ownerId: me.id, slug: 'team-b' });
    createProject(ctx.db, { teamId: a.team.id, key: 'WEB' });
    createProject(ctx.db, { teamId: b.team.id, key: 'WEB' });
    const error = errorOf(() => resolveProject(ctx.deps, actorOf(me), 'WEB'));
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual({ candidates: ['team-a/WEB', 'team-b/WEB'] });
    expect(resolveProject(ctx.deps, actorOf(me), 'team-b/WEB').team.slug).toBe('team-b');
  });

  it('keeps old keys resolving through aliases', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id, slug: 'acme' });
    const project = createProject(ctx.db, { teamId: acme.team.id, key: 'NEW' });
    createTask(ctx.db, { project: project.project });
    ctx.db.orm
      .insert(s.projectKeyAlias)
      .values({ projectId: project.project.id, teamId: acme.team.id, key: 'OLD' })
      .run();
    expect(resolveTask(ctx.deps, actorOf(me), 'OLD-1').project.key).toBe('NEW');
  });

  it('skips deleted projects and tasks', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id });
    const project = createProject(ctx.db, { teamId: acme.team.id, key: 'DEL' });
    const task = createTask(ctx.db, { project: project.project });
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(errorOf(() => resolveTask(ctx.deps, actorOf(me), 'DEL-1')).code).toBe('not_found');
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, project.project.id))
      .run();
    expect(errorOf(() => resolveProject(ctx.deps, actorOf(me), 'DEL')).code).toBe('not_found');
  });
});

describe('users, roles, statuses and labels', () => {
  it('resolves users who share a team', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id });
    const mia = createUser(ctx.db, { username: 'mia' });
    const stranger = createUser(ctx.db, { username: 'stranger' });
    addMember(ctx.db, { teamId: acme.team.id, userId: mia.id });
    expect(resolveUser(ctx.deps, actorOf(me), '@MIA').id).toBe(mia.id);
    expect(resolveUser(ctx.deps, actorOf(me), mia.id).username).toBe('mia');
    expect(resolveUser(ctx.deps, actorOf(me), 'ethan').id).toBe(me.id);
    expect(errorOf(() => resolveUser(ctx.deps, actorOf(me), 'stranger')).code).toBe('not_found');
    expect(resolveUser(ctx.deps, actorOf(me), 'mia', { teamId: acme.team.id }).id).toBe(mia.id);
    expect(stranger.id).toBeTruthy();
  });

  it('resolves roles by slug, name or id', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id });
    const role = createRole(ctx.db, {
      teamId: acme.team.id,
      name: 'Backend Devs',
      slug: 'backend',
    });
    expect(resolveRole(ctx.db.orm, acme.team.id, 'backend').id).toBe(role.id);
    expect(resolveRole(ctx.db.orm, acme.team.id, '@&backend').id).toBe(role.id);
    expect(resolveRole(ctx.db.orm, acme.team.id, 'backend devs').id).toBe(role.id);
    expect(resolveRole(ctx.db.orm, acme.team.id, role.id).id).toBe(role.id);
    expect(resolveRole(ctx.db.orm, acme.team.id, 'everyone').isEveryone).toBe(true);
    expect(errorOf(() => resolveRole(ctx.db.orm, acme.team.id, 'nope')).code).toBe('not_found');
  });

  it('resolves statuses and labels by name, case-insensitively, and flags ambiguity', () => {
    const acme = createTeam(ctx.db, { ownerId: me.id });
    const project = createProject(ctx.db, { teamId: acme.team.id });
    const [open] = project.statuses;
    expect(resolveStatus(ctx.db.orm, project.project.id, 'open').id).toBe(open?.id);
    expect(resolveStatus(ctx.db.orm, project.project.id, open?.id ?? '').name).toBe('Open');
    ctx.db.orm
      .insert(s.label)
      .values([
        { projectId: project.project.id, name: 'Bug', color: '#ef4444' },
        { projectId: project.project.id, name: 'bug', color: '#ef4444' },
        { projectId: project.project.id, name: 'Docs', color: '#ef4444' },
      ])
      .run();
    expect(resolveLabel(ctx.db.orm, project.project.id, 'docs').name).toBe('Docs');
    expect(resolveLabel(ctx.db.orm, project.project.id, 'Bug').name).toBe('Bug');
    expect(errorOf(() => resolveLabel(ctx.db.orm, project.project.id, 'BUG')).code).toBe(
      'validation_failed',
    );
  });
});

describe('GET /api/me and mentionables', () => {
  it('returns teams with effective permissions and live projects', async () => {
    const acme = createTeam(ctx.db, { ownerId: me.id, slug: 'acme', name: 'Acme' });
    const other = createTeam(ctx.db, {
      ownerId: createUser(ctx.db).id,
      slug: 'other',
      name: 'Other',
    });
    addMember(ctx.db, { teamId: other.team.id, userId: me.id });
    createProject(ctx.db, { teamId: acme.team.id, key: 'API', name: 'Api' });
    const gone = createProject(ctx.db, { teamId: acme.team.id, key: 'OLD' });
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, gone.project.id))
      .run();
    const { key } = createApiKey(ctx.db, { userId: me.id });
    const body = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(key) })).json(),
    );
    expect(body.teams.map((t) => [t.slug, t.isOwner, t.projects.map((p) => p.key)])).toEqual([
      ['acme', true, ['API']],
      ['other', false, []],
    ]);
    expect(body.teams[0]?.permissions).toContain('ADMINISTRATOR');
    expect(body.teams[1]?.permissions).not.toContain('MANAGE_TEAM');
    expect(body.unreadNotifications).toBe(0);
  });

  it('lists mention candidates and only roles the caller may mention', async () => {
    const owner = createUser(ctx.db, { username: 'boss' });
    const acme = createTeam(ctx.db, { ownerId: owner.id });
    addMember(ctx.db, { teamId: acme.team.id, userId: me.id });
    createRole(ctx.db, { teamId: acme.team.id, slug: 'devs', mentionable: true });
    createRole(ctx.db, { teamId: acme.team.id, slug: 'hidden', mentionable: false });
    const { key } = createApiKey(ctx.db, { userId: me.id });
    const get = async (q: string, k = key) =>
      mentionablesResponseSchema.parse(
        await (
          await ctx.app.request(`/api/teams/${acme.team.id}/mentionables?q=${q}`, {
            headers: bearer(k),
          })
        ).json(),
      );
    const all = await get('');
    expect(all.users.map((u) => u.username).sort()).toEqual(['boss', 'ethan']);
    expect(all.roles.map((r) => r.slug)).toEqual(['devs']);
    expect((await get('bo')).users.map((u) => u.username)).toEqual(['boss']);
    expect((await get('%25')).users).toEqual([]);

    // Regression (WEB-14): chips resolved against the first 20 candidates only. A lookup names
    // them exactly, including roles the caller may not mention.
    const lookup = mentionablesResponseSchema.parse(
      await (
        await ctx.app.request(
          `/api/teams/${acme.team.id}/mentionables?usernames=Boss,nobody&roles=hidden,devs`,
          { headers: bearer(key) },
        )
      ).json(),
    );
    expect(lookup.users.map((u) => u.username)).toEqual(['boss']);
    expect(lookup.roles.map((r) => r.slug).sort()).toEqual(['devs', 'hidden']);

    const ownerKey = createApiKey(ctx.db, { userId: owner.id }).key;
    const asOwner = await get('', ownerKey);
    expect(asOwner.roles.map((r) => r.slug).sort()).toEqual([
      'admin',
      'devs',
      'everyone',
      'hidden',
    ]);
  });
});
