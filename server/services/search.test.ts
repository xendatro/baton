import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchResponseSchema } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { markdownToPlainText } from '../lib/markdown';
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
  type CreatedProject,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { createReply } from './replies';
import { buildFtsQuery, indexSearch, parseRefQuery, removeFromSearch, search } from './search';

let ctx: TestContext;
let user: UserRow;
let project: CreatedProject;
let otherProject: CreatedProject;

const actorOf = (u: { id: string }): Actor => ({ userId: u.id, source: 'web', key: null });

function index(
  type: 'task' | 'issue',
  row: { id: string; teamId: string; projectId: string; title: string },
  body: string,
) {
  ctx.db.write((tx) =>
    indexSearch(tx, {
      entityType: type,
      entityId: row.id,
      teamId: row.teamId,
      projectId: row.projectId,
      title: row.title,
      text: markdownToPlainText(body),
    }),
  );
}

beforeEach(() => {
  ctx = createTestContext();
  user = createUser(ctx.db);
  const team = createTeam(ctx.db, { ownerId: user.id, slug: 'acme' });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  otherProject = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
});

afterEach(() => {
  ctx.close();
});

const q = (query: string, extra: Partial<Parameters<typeof search>[2]> = {}) =>
  search(ctx.deps, actorOf(user), {
    q: query,
    types: ['task', 'issue', 'reply'],
    limit: 20,
    ...extra,
  }).results;

describe('buildFtsQuery', () => {
  it('quotes and prefix-matches every word', () => {
    expect(buildFtsQuery('Fix login')).toBe('"fix"* "login"*');
    expect(buildFtsQuery('  ')).toBeNull();
    expect(buildFtsQuery('***')).toBeNull();
  });

  it('neutralises FTS syntax in user input', () => {
    expect(buildFtsQuery('a" OR b NEAR(c) title:x -y *')).toBe(
      '"a"* "or"* "b"* "near"* "c"* "title"* "x"* "y"*',
    );
    expect(buildFtsQuery('café 日本')).toBe('"café"* "日本"*');
  });
});

describe('search', () => {
  it('finds tasks, issues and replies by title and body with prefixes and stemming', () => {
    const task = createTask(ctx.db, { project: project.project, title: 'Fix login redirect' });
    index('task', task, 'Users bounce back to **/login** after OAuth');
    const issue = createIssue(ctx.db, { project: project.project, title: 'Crash on startup' });
    index('issue', issue, 'The server crashes when DATA_DIR is missing');
    createReply(ctx.deps, actorOf(user), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'Redirects fixed in v2',
    });

    expect(q('logi').map((r) => r.ref)).toEqual(['API-1']);
    expect(q('crashing').map((r) => r.ref)).toEqual(['API#1']);
    const redirect = q('redirect');
    expect(redirect.map((r) => r.entityType).sort()).toEqual(['reply', 'task']);
    const reply = redirect.find((r) => r.entityType === 'reply');
    expect(reply).toMatchObject({ ref: 'API#1', title: 'Crash on startup' });
    expect(reply?.url).toMatch(/^\/t\/acme\/p\/API\/issues\/1#reply-/);
    expect(q('redirect', { types: ['task'] }).map((r) => r.entityType)).toEqual(['task']);
    expect(redirect.find((r) => r.entityType === 'task')?.snippet).toContain('login');
  });

  it('ranks title matches above body matches', () => {
    const inBody = createTask(ctx.db, { project: project.project, title: 'Something else' });
    index('task', inBody, 'mentions deploy once');
    const inTitle = createTask(ctx.db, { project: project.project, title: 'Deploy pipeline' });
    index('task', inTitle, 'unrelated');
    expect(q('deploy').map((r) => r.entityId)).toEqual([inTitle.id, inBody.id]);
  });

  it('never errors on hostile input', () => {
    for (const input of [
      '"',
      'AND',
      'NEAR(',
      'title:',
      '(',
      '^x',
      'a OR',
      '*',
      "'; drop table task; --",
    ]) {
      expect(() => q(input)).not.toThrow();
    }
  });

  it('scopes to the caller’s teams, a project and live items', async () => {
    const task = createTask(ctx.db, { project: project.project, title: 'Secret roadmap' });
    index('task', task, '');
    const web = createTask(ctx.db, { project: otherProject.project, title: 'Roadmap page' });
    index('task', web, '');

    expect(q('roadmap')).toHaveLength(2);
    expect(q('roadmap', { projectId: otherProject.project.id }).map((r) => r.ref)).toEqual([
      'WEB-1',
    ]);

    const outsider = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: outsider.id });
    const res = await ctx.app.request('/api/search?q=roadmap', { headers: bearer(key) });
    expect(searchResponseSchema.parse(await res.json()).results).toEqual([]);

    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(q('roadmap').map((r) => r.ref)).toEqual(['WEB-1']);
    ctx.db.orm
      .update(s.project)
      .set({ deletedAt: new Date() })
      .where(eq(s.project.id, otherProject.project.id))
      .run();
    expect(q('roadmap')).toEqual([]);
  });

  it('hides replies of deleted items and removes purged documents', () => {
    const issue = createIssue(ctx.db, { project: project.project, title: 'Parent' });
    const reply = createReply(ctx.deps, actorOf(user), {
      parentType: 'issue',
      parentId: issue.id,
      body: 'zebra crossing',
    });
    expect(q('zebra')).toHaveLength(1);
    ctx.db.orm.update(s.issue).set({ deletedAt: new Date() }).where(eq(s.issue.id, issue.id)).run();
    expect(q('zebra')).toEqual([]);
    ctx.db.orm.update(s.issue).set({ deletedAt: null }).where(eq(s.issue.id, issue.id)).run();
    ctx.db.write((tx) => removeFromSearch(tx, 'reply', [reply.id]));
    expect(q('zebra')).toEqual([]);
  });

  it('validates the REST query', async () => {
    const member = createUser(ctx.db);
    addMember(ctx.db, { teamId: project.project.teamId, userId: member.id });
    const { key } = createApiKey(ctx.db, { userId: member.id });
    expect((await ctx.app.request('/api/search?q=', { headers: bearer(key) })).status).toBe(400);
    expect(
      (await ctx.app.request('/api/search?q=x&types=nope', { headers: bearer(key) })).status,
    ).toBe(400);
    expect(
      (await ctx.app.request('/api/search?q=x&limit=51', { headers: bearer(key) })).status,
    ).toBe(400);
  });
});

describe('search by ref (UX-04)', () => {
  it('reads task and issue refs, with or without the key', () => {
    expect(parseRefQuery('WEB-14')).toEqual({
      kinds: ['task'],
      teamSlug: null,
      projectKey: 'WEB',
      number: 14,
    });
    expect(parseRefQuery('acme/web#7')).toMatchObject({
      kinds: ['issue'],
      teamSlug: 'acme',
      projectKey: 'WEB',
      number: 7,
    });
    expect(parseRefQuery('WEB 14')).toMatchObject({ kinds: ['task', 'issue'], number: 14 });
    expect(parseRefQuery('WEB #14')).toMatchObject({ kinds: ['issue'], number: 14 });
    expect(parseRefQuery(' 14 ')).toMatchObject({ kinds: ['task', 'issue'], projectKey: null });
    expect(parseRefQuery('#3')).toMatchObject({ kinds: ['issue'], number: 3 });
    for (const input of ['WEB', 'fix login', '0', 'WEB-0', 'split the main', '14 15']) {
      expect(parseRefQuery(input)).toBeNull();
    }
  });

  it('puts the item a ref names first, before full-text matches', () => {
    for (let i = 0; i < 13; i += 1) createTask(ctx.db, { project: otherProject.project });
    const target = createTask(ctx.db, {
      project: otherProject.project,
      title: 'Board columns overflow',
      body: 'See **WEB#7** for the report.',
    });
    index('task', target, 'See **WEB#7** for the report.');
    expect(target.number).toBe(14);
    for (let i = 0; i < 6; i += 1) createIssue(ctx.db, { project: otherProject.project });
    const issue = createIssue(ctx.db, { project: otherProject.project, title: 'Overflow report' });
    index('issue', issue, '');
    expect(issue.number).toBe(7);

    const task14 = q('WEB-14');
    expect(task14[0]).toMatchObject({
      entityType: 'task',
      entityId: target.id,
      ref: 'WEB-14',
      title: 'Board columns overflow',
      snippet: 'See WEB#7 for the report.',
      url: '/t/acme/p/WEB/tasks/14',
    });
    expect(task14.filter((r) => r.entityId === target.id)).toHaveLength(1);
    // The issue itself comes first; the task mentioning it follows as a full-text match.
    expect(q('WEB#7').map((r) => r.ref)).toEqual(['WEB#7', 'WEB-14']);
    expect(q('acme/WEB-14')[0]?.entityId).toBe(target.id);
    expect(q('web 14')[0]?.entityId).toBe(target.id);
    // A bare number matches that number in every project the caller can see.
    createTask(ctx.db, { project: project.project });
    expect(q('1').map((r) => r.ref)).toEqual(['API-1', 'WEB-1', 'WEB#1']);
    expect(q('#7').map((r) => r.ref)).toEqual(['WEB#7', 'WEB-14']);
    expect(q('7', { types: ['task'] }).map((r) => r.ref)).toEqual(['WEB-7', 'WEB-14']);
    expect(q('1', { projectId: project.project.id }).map((r) => r.ref)).toEqual(['API-1']);
    expect(q('WEB-99')).toEqual([]);
    expect(q('other/WEB-14')).toEqual([]);
  });

  it('follows old project keys and skips deleted items and outsiders', async () => {
    const task = createTask(ctx.db, { project: otherProject.project, title: 'Renamed' });
    ctx.db.orm
      .insert(s.projectKeyAlias)
      .values({
        projectId: otherProject.project.id,
        teamId: otherProject.project.teamId,
        key: 'OLD',
      })
      .run();
    expect(q('OLD-1').map((r) => r.ref)).toEqual(['WEB-1']);

    const outsider = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: outsider.id });
    const res = await ctx.app.request('/api/search?q=WEB-1', { headers: bearer(key) });
    expect(searchResponseSchema.parse(await res.json()).results).toEqual([]);

    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, task.id)).run();
    expect(q('WEB-1')).toEqual([]);
  });
});
