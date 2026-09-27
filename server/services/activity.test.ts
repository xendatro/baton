import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  activityListResponseSchema,
  auditLogResponseSchema,
  securityLogResponseSchema,
} from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  agentActor,
  bearer,
  createApiKey,
  createIssue,
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
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { listAuditLog, listEntityActivity, recordActivity } from './activity';

let ctx: TestContext;
let owner: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
});

afterEach(() => {
  ctx.close();
});

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

function record(
  actor: Actor | null,
  overrides: Partial<Parameters<typeof recordActivity>[2]> = {},
) {
  return ctx.db.write((tx) =>
    recordActivity(tx, actor, {
      teamId: team.team.id,
      projectId: project.project.id,
      entityType: 'project',
      entityId: project.project.id,
      action: 'project.updated',
      ...overrides,
    }),
  );
}

describe('recordActivity', () => {
  it('snapshots the key name and emits activity.created after commit', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: owner.id, name: 'Codex desktop' });
    const actor = agentActor(ctx.db, owner.id, { id: apiKey.id, name: 'Codex desktop' });
    const events: LiveEvent[] = [];
    ctx.deps.events.subscribe((event) => events.push(event));
    const row = record(actor, {
      changes: { name: { from: 'A', to: 'B' } },
      meta: { title: 'B' },
    });
    ctx.db.orm.update(s.apiKey).set({ name: 'Renamed' }).where(eq(s.apiKey.id, apiKey.id)).run();

    const [entry] = listEntityActivity(ctx.deps, web(owner), {
      entityType: 'project',
      entityId: project.project.id,
    }).items;
    expect(entry).toMatchObject({
      id: row.id,
      actor: {
        // Written through a key: the owner's agent member, "via" the key (agents A).
        user: { id: actor.userId, kind: 'agent', agentOwner: { id: owner.id } },
        via: { keyId: apiKey.id, keyName: 'Codex desktop' },
        source: 'mcp',
      },
      changes: { name: { from: 'A', to: 'B' } },
      meta: { title: 'B' },
      url: '/t/acme/p/API',
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'activity.created',
        teamId: team.team.id,
        entityId: row.id,
        parentType: 'project',
        parentId: project.project.id,
      }) as unknown,
    ]);
  });

  it('snapshots the key’s agent, so the history keeps naming it (BAT-10)', () => {
    const { apiKey } = createApiKey(ctx.db, { userId: owner.id, name: 'MSI' });
    const row = record({
      userId: owner.id,
      source: 'mcp',
      key: { id: apiKey.id, name: 'MSI', agentName: 'Claude' },
    });
    expect(row.viaAgentName).toBe('Claude');
    // Another agent later using the same key does not rewrite the past.
    ctx.db.orm.update(s.apiKey).set({ agentName: 'Codex' }).where(eq(s.apiKey.id, apiKey.id)).run();

    const [entry] = listEntityActivity(ctx.deps, web(owner), {
      entityType: 'project',
      entityId: project.project.id,
    }).items;
    expect(entry?.actor.via).toEqual({ keyId: apiKey.id, keyName: 'MSI', agentName: 'Claude' });
  });

  it('gives older rows without an agent snapshot the key’s current agent (BAT-10)', () => {
    const { apiKey: named } = createApiKey(ctx.db, { userId: owner.id, name: 'MSI' });
    const { apiKey: unnamed } = createApiKey(ctx.db, { userId: owner.id, name: 'Script' });
    record({ userId: owner.id, source: 'mcp', key: { id: named.id, name: 'MSI' } });
    record({ userId: owner.id, source: 'api', key: { id: unnamed.id, name: 'Script' } });
    expect(ctx.db.orm.select({ agent: s.activity.viaAgentName }).from(s.activity).all()).toEqual([
      { agent: null },
      { agent: null },
    ]);
    ctx.db.orm.update(s.apiKey).set({ agentName: 'Claude' }).where(eq(s.apiKey.id, named.id)).run();

    const entries = listEntityActivity(ctx.deps, web(owner), {
      entityType: 'project',
      entityId: project.project.id,
    }).items;
    expect(entries.map((entry) => entry.actor.via)).toEqual([
      { keyId: named.id, keyName: 'MSI', agentName: 'Claude' },
      { keyId: unnamed.id, keyName: 'Script' },
    ]);
  });

  it('names the agent on rows written through an API key over REST (BAT-10)', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: owner.id, name: 'MSI' });
    ctx.db.orm
      .update(s.apiKey)
      .set({ agentName: 'Claude' })
      .where(eq(s.apiKey.id, apiKey.id))
      .run();
    const task = createTask(ctx.db, { project: project.project, authorId: owner.id });
    const res = await ctx.app.request(
      `/api/tasks/${task.id}`,
      json('PATCH', { title: 'Renamed by Claude' }, bearer(key)),
    );
    expect(res.status).toBe(200);
    const row = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, task.id))
      .all()
      .at(-1);
    expect(row).toMatchObject({ viaKeyId: apiKey.id, viaAgentName: 'Claude' });

    const history = await ctx.app.request(`/api/activity?entityType=task&entityId=${task.id}`, {
      headers: bearer(key),
    });
    const body = activityListResponseSchema.parse(await history.json());
    expect(body.items.at(-1)?.actor.via).toEqual({
      keyId: apiKey.id,
      keyName: 'MSI',
      agentName: 'Claude',
    });
  });

  it('records system actions with a null actor', () => {
    const row = record(null);
    expect(row).toMatchObject({ actorId: null, source: 'system', viaKeyId: null });
  });

  it('is rolled back with the transaction, including its event', () => {
    const events: LiveEvent[] = [];
    ctx.deps.events.subscribe((event) => events.push(event));
    expect(() =>
      ctx.db.write((tx) => {
        recordActivity(tx, web(owner), {
          teamId: team.team.id,
          entityType: 'team',
          entityId: team.team.id,
          action: 'team.updated',
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ctx.db.orm.select().from(s.activity).all()).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('entity URLs', () => {
  it('links rows to their entity while it can still be opened', () => {
    const task = createTask(ctx.db, { project: project.project });
    const issue = createIssue(ctx.db, { project: project.project });
    const role = createRole(ctx.db, { teamId: team.team.id });
    const rows = [
      record(web(owner), { entityType: 'task', entityId: task.id, action: 'task.created' }),
      record(web(owner), { entityType: 'issue', entityId: issue.id, action: 'issue.created' }),
      record(web(owner), { entityType: 'role', entityId: role.id, action: 'role.created' }),
      record(web(owner), { entityType: 'status', entityId: 'x', action: 'status.created' }),
      record(web(owner), { entityType: 'member', entityId: owner.id, action: 'member.joined' }),
    ];
    ctx.db.orm.update(s.issue).set({ deletedAt: new Date() }).where(eq(s.issue.id, issue.id)).run();
    const page = listAuditLog(ctx.deps, web(owner), team.team.id, { limit: 50 });
    const urls = Object.fromEntries(page.items.map((item) => [item.id, item.url]));
    expect(urls[rows[0]?.id ?? '']).toBe('/t/acme/p/API/tasks/1');
    expect(urls[rows[1]?.id ?? '']).toBeNull();
    expect(urls[rows[2]?.id ?? '']).toBe(`/t/acme/settings/roles/${role.id}`);
    expect(urls[rows[3]?.id ?? '']).toBe('/t/acme/p/API/settings/pipelines');
    expect(urls[rows[4]?.id ?? '']).toBe('/t/acme/settings/members');
  });
});

// Regression (SEC-3): any member could read the history of roles, the team, invites and so on,
// and of Trash items they may not see, through GET /api/activity.
describe('entity history access', () => {
  const history = async (key: string, entityType: string, entityId: string) =>
    ctx.app.request(`/api/activity?entityType=${entityType}&entityId=${entityId}`, {
      headers: bearer(key),
    });

  it('shows item history to members and team entities only with VIEW_AUDIT_LOG', async () => {
    const member = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: member.id });
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['ADMINISTRATOR'] });
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    record(web(owner), { entityType: 'role', entityId: role.id, action: 'role.created' });
    record(web(owner), { entityType: 'team', entityId: team.team.id, action: 'team.updated' });
    record(web(owner), { entityType: 'issue', entityId: issue.id, action: 'issue.created' });

    expect((await history(key, 'issue', issue.id)).status).toBe(200);
    for (const [type, id] of [
      ['role', role.id],
      ['team', team.team.id],
      ['project', project.project.id],
    ] as const) {
      expect((await history(key, type, id)).status).toBe(403);
    }

    const auditor = createRole(ctx.db, { teamId: team.team.id, permissions: ['VIEW_AUDIT_LOG'] });
    giveRoleWithAgent(ctx.db, { teamId: team.team.id, userId: member.id, roleId: auditor.id });
    const res = await history(key, 'role', role.id);
    expect(res.status).toBe(200);
    expect(activityListResponseSchema.parse(await res.json()).items).toHaveLength(1);
  });

  it('hides the history of Trash items and others’ pending uploads from other members', async () => {
    const member = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: member.id });
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const ownerKey = createApiKey(ctx.db, { userId: owner.id });
    const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
    record(web(owner), { entityType: 'issue', entityId: issue.id, action: 'issue.created' });
    ctx.db.orm.update(s.issue).set({ deletedAt: new Date() }).where(eq(s.issue.id, issue.id)).run();
    expect((await history(key, 'issue', issue.id)).status).toBe(404);
    expect((await history(ownerKey.key, 'issue', issue.id)).status).toBe(200);

    const pending = ctx.db.orm
      .insert(s.attachment)
      .values({
        teamId: team.team.id,
        uploaderId: owner.id,
        parentType: 'pending',
        filename: 'secret-plan.txt',
        mimeType: 'text/plain',
        size: 1,
        sha256: 'x',
        storagePath: 'x',
      })
      .returning()
      .get();
    record(web(owner), {
      entityType: 'attachment',
      entityId: pending.id,
      action: 'attachment.uploaded',
    });
    expect((await history(key, 'attachment', pending.id)).status).toBe(404);
    expect((await history(ownerKey.key, 'attachment', pending.id)).status).toBe(200);
  });
});

describe('team audit log', () => {
  it('needs VIEW_AUDIT_LOG and membership', async () => {
    const member = createUser(ctx.db);
    addMember(ctx.db, { teamId: team.team.id, userId: member.id });
    const { key } = createApiKey(ctx.db, { userId: member.id });
    const forbidden = await ctx.app.request(`/api/teams/${team.team.id}/audit-log`, {
      headers: bearer(key),
    });
    expect(forbidden.status).toBe(403);
    const outsider = createApiKey(ctx.db, { userId: createUser(ctx.db).id });
    const hidden = await ctx.app.request(`/api/teams/${team.team.id}/audit-log`, {
      headers: bearer(outsider.key),
    });
    expect(hidden.status).toBe(404);

    const auditor = createRole(ctx.db, { teamId: team.team.id, permissions: ['VIEW_AUDIT_LOG'] });
    giveRoleWithAgent(ctx.db, { teamId: team.team.id, userId: member.id, roleId: auditor.id });
    const allowed = await ctx.app.request(`/api/teams/${team.team.id}/audit-log`, {
      headers: bearer(key),
    });
    expect(allowed.status).toBe(200);
  });

  it('filters by actor, key, source, entity type, action, project and date range', async () => {
    const other = createUser(ctx.db, { username: 'other' });
    addMember(ctx.db, { teamId: team.team.id, userId: other.id });
    const otherProject = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const { apiKey } = createApiKey(ctx.db, { userId: other.id, name: 'Bot' });
    const t = (iso: string) => new Date(iso);
    const insert = (values: Partial<typeof s.activity.$inferInsert>) =>
      ctx.db.orm
        .insert(s.activity)
        .values({
          teamId: team.team.id,
          projectId: project.project.id,
          actorId: owner.id,
          source: 'web',
          entityType: 'task',
          entityId: 't1',
          action: 'task.created',
          createdAt: t('2026-01-01T00:00:00Z'),
          ...values,
        })
        .run();
    insert({});
    insert({ action: 'task.status_changed', createdAt: t('2026-01-02T00:00:00Z') });
    insert({
      actorId: other.id,
      source: 'mcp',
      viaKeyId: apiKey.id,
      viaKeyName: 'Bot',
      action: 'task.claimed',
      createdAt: t('2026-01-03T00:00:00Z'),
    });
    insert({
      entityType: 'issue',
      action: 'issue.created',
      projectId: otherProject.project.id,
      createdAt: t('2026-01-04T00:00:00Z'),
    });
    // Another team's rows never show up.
    insert({ teamId: 'another-team' });

    const { key } = createApiKey(ctx.db, { userId: owner.id });
    giveAgentOwnerRoles(ctx.db, owner.id);
    const query = async (params: string) =>
      auditLogResponseSchema
        .parse(
          await (
            await ctx.app.request(`/api/teams/${team.team.id}/audit-log?${params}`, {
              headers: bearer(key),
            })
          ).json(),
        )
        .items.map((item) => item.action);

    expect(await query('')).toEqual([
      'issue.created',
      'task.claimed',
      'task.status_changed',
      'task.created',
    ]);
    expect(await query(`actorId=${other.id}`)).toEqual(['task.claimed']);
    expect(await query(`keyId=${apiKey.id}`)).toEqual(['task.claimed']);
    expect(await query('source=mcp')).toEqual(['task.claimed']);
    expect(await query('entityType=issue')).toEqual(['issue.created']);
    expect(await query('action=task.created')).toEqual(['task.created']);
    expect(await query('action=task.')).toEqual([
      'task.claimed',
      'task.status_changed',
      'task.created',
    ]);
    expect(await query('action=task_')).toEqual([]);
    expect(await query(`projectId=${otherProject.project.id}`)).toEqual(['issue.created']);
    expect(
      await query(
        `from=${encodeURIComponent('2026-01-02T00:00:00Z')}&to=${encodeURIComponent('2026-01-04T00:00:00Z')}`,
      ),
    ).toEqual(['task.claimed', 'task.status_changed']);
    const bad = await ctx.app.request(`/api/teams/${team.team.id}/audit-log?source=nope`, {
      headers: bearer(key),
    });
    expect(bad.status).toBe(400);
  });

  it('paginates newest first with an opaque cursor, stable for equal timestamps', () => {
    const at = new Date('2026-02-01T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      ctx.db.orm
        .insert(s.activity)
        .values({
          teamId: team.team.id,
          source: 'web',
          entityType: 'team',
          entityId: team.team.id,
          action: `team.updated`,
          meta: { i },
          createdAt: at,
        })
        .run();
    }
    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = listAuditLog(ctx.deps, web(owner), team.team.id, { limit: 2, cursor });
      seen.push(...page.items.map((item) => item.meta.i));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(() =>
      listAuditLog(ctx.deps, web(owner), team.team.id, { limit: 2, cursor: 'garbage' }),
    ).toThrow('Invalid cursor');
  });
});

describe('security log', () => {
  it('lists only the user’s own account-level rows', async () => {
    const user = createUser(ctx.db);
    const cookieless = createApiKey(ctx.db, { userId: user.id });
    const log = (userId: string, action: string) =>
      ctx.db.write((tx) =>
        recordActivity(tx, web({ id: userId }), {
          teamId: null,
          entityType: 'user',
          entityId: userId,
          action,
        }),
      );
    log(user.id, 'user.signed_in');
    log(owner.id, 'user.signed_in');
    record(web(user));

    const res = await ctx.app.request('/api/me/security-log', { headers: bearer(cookieless.key) });
    const page = securityLogResponseSchema.parse(await res.json());
    expect(page.items.map((item) => [item.action, item.url])).toEqual([
      ['user.signed_in', '/settings/security'],
    ]);

    // Account-level history of someone else is hidden.
    expect(() =>
      listEntityActivity(ctx.deps, web(user), { entityType: 'user', entityId: owner.id }),
    ).toThrow(/not found/);
    expect(
      listEntityActivity(ctx.deps, web(user), { entityType: 'user', entityId: user.id }).items,
    ).toHaveLength(1);
  });
});
