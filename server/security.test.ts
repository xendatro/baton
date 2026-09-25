import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@shared/schemas/common';
import { attachmentSchema } from '@shared/schemas/core';
import { canAssignRole, canManageRole, getMembership } from './services/access';
import { createReply } from './services/replies';
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
  json,
  signIn,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from './test/helpers';

/**
 * Cross-cutting security guarantees (SPEC §1.3, §5): one place that proves the attack paths are
 * closed end to end. Module tests cover the details.
 */

let ctx: TestContext;
let alice: UserRow;
let mallory: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

beforeEach(() => {
  ctx = createTestContext();
  alice = createUser(ctx.db, { username: 'alice' });
  mallory = createUser(ctx.db, { username: 'mallory' });
  team = createTeam(ctx.db, { ownerId: alice.id, slug: 'acme' });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
});

afterEach(() => {
  ctx.close();
});

async function codeOf(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error.code;
}

describe('security', () => {
  it('rejects cross-site cookie writes (CSRF)', async () => {
    const cookie = await signIn(ctx, alice);
    const task = createTask(ctx.db, { project: project.project });
    const res = await ctx.app.request(
      '/api/replies',
      json(
        'POST',
        { parentType: 'task', parentId: task.id, body: 'forged' },
        { Cookie: cookie, Origin: 'https://evil.example' },
      ),
    );
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('forbidden');
  });

  it('answers 404, never 403, to non-members everywhere', async () => {
    const task = createTask(ctx.db, { project: project.project });
    const issue = createIssue(ctx.db, { project: project.project });
    const reply = createReply(
      ctx.deps,
      { userId: alice.id, source: 'web', key: null },
      {
        parentType: 'task',
        parentId: task.id,
        body: 'secret',
      },
    );
    const { key } = createApiKey(ctx.db, { userId: mallory.id });
    const requests: Array<[string, RequestInit?]> = [
      [`/api/replies?parentType=task&parentId=${task.id}`],
      [
        '/api/replies',
        json('POST', { parentType: 'issue', parentId: issue.id, body: 'x' }, bearer(key)),
      ],
      [`/api/replies/${reply.id}`, json('PATCH', { body: 'x' }, bearer(key))],
      [`/api/replies/${reply.id}`, { method: 'DELETE', headers: bearer(key) }],
      [`/api/activity?entityType=task&entityId=${task.id}`],
      [`/api/teams/${team.team.id}/audit-log`],
      [`/api/teams/${team.team.id}/mentionables`],
      [`/api/subscriptions?entityType=task&entityId=${task.id}`],
      [`/api/attachments?parentType=task&parentId=${task.id}`],
    ];
    for (const [url, init] of requests) {
      const res = await ctx.app.request(url, init ?? { headers: bearer(key) });
      expect(res.status, url).toBe(404);
      expect(await codeOf(res)).toBe('not_found');
    }
  });

  it('rejects revoked keys with 401', async () => {
    const { key } = createApiKey(ctx.db, { userId: alice.id, revokedAt: new Date() });
    const res = await ctx.app.request('/api/me', { headers: bearer(key) });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('unauthorized');
  });

  it('rejects unverified accounts with 403 email_not_verified', async () => {
    const unverified = createUser(ctx.db, { emailVerified: false });
    const { key } = createApiKey(ctx.db, { userId: unverified.id });
    const res = await ctx.app.request('/api/search?q=x', { headers: bearer(key) });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('email_not_verified');
  });

  it('denies privilege escalation through roles', () => {
    const manager = createUser(ctx.db);
    const managers = createRole(ctx.db, {
      teamId: team.team.id,
      permissions: ['MANAGE_ROLES', 'MANAGE_MEMBERS'],
    });
    addMember(ctx.db, { teamId: team.team.id, userId: manager.id, roleIds: [managers.id] });
    addMember(ctx.db, { teamId: team.team.id, userId: mallory.id });
    const m = getMembership(ctx.db.orm, team.team.id, manager.id);
    const target = getMembership(ctx.db.orm, team.team.id, mallory.id);
    const owner = getMembership(ctx.db.orm, team.team.id, alice.id);
    if (!m || !target || !owner) throw new Error('memberships missing');

    expect(canManageRole(m, [], ['ADMINISTRATOR'])).toBe(false);
    expect(canManageRole(m, [], ['DELETE_ANY_CONTENT'])).toBe(false);
    expect(canAssignRole(m, team.adminRole, target)).toBe(false);
    expect(canAssignRole(m, { permissions: ['VIEW_AUDIT_LOG'], isEveryone: false }, m)).toBe(false);
    expect(canAssignRole(m, { permissions: [], isEveryone: false }, owner)).toBe(false);
  });

  it('keeps attachments inside their team', async () => {
    addMember(ctx.db, { teamId: team.team.id, userId: mallory.id });
    const task = createTask(ctx.db, { project: project.project, authorId: alice.id });
    const aliceKey = createApiKey(ctx.db, { userId: alice.id }).key;
    const form = new FormData();
    form.set('file', new File(['secret'], 'secret.txt'));
    form.set('teamId', team.team.id);
    form.set('parentType', 'task');
    form.set('parentId', task.id);
    const uploaded = attachmentSchema.parse(
      await (
        await ctx.app.request('/api/attachments', {
          method: 'POST',
          headers: bearer(aliceKey),
          body: form,
        })
      ).json(),
    );

    // A member of another team can't read it, even knowing the URL.
    const outsider = createUser(ctx.db);
    createTeam(ctx.db, { ownerId: outsider.id });
    const outsiderKey = createApiKey(ctx.db, { userId: outsider.id }).key;
    expect((await ctx.app.request(uploaded.url, { headers: bearer(outsiderKey) })).status).toBe(
      404,
    );

    // Nor upload into this team or attach its files elsewhere.
    const foreign = new FormData();
    foreign.set('file', new File(['x'], 'x.txt'));
    foreign.set('teamId', team.team.id);
    const res = await ctx.app.request('/api/attachments', {
      method: 'POST',
      headers: bearer(outsiderKey),
      body: foreign,
    });
    expect(res.status).toBe(404);
    // A teammate can read it (members see everything in the team).
    const malloryKey = createApiKey(ctx.db, { userId: mallory.id }).key;
    expect((await ctx.app.request(uploaded.url, { headers: bearer(malloryKey) })).status).toBe(200);
  });
});
