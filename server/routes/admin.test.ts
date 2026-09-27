import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditLogFacetsSchema,
  restoreTrashResponseSchema,
  trashPageSchema,
} from '@shared/schemas/admin';
import { apiErrorSchema } from '@shared/schemas/common';
import { auditLogResponseSchema, searchResponseSchema } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  createAgent,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  json,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { recordActivity } from '../services/activity';
import { createReply, deleteReply } from '../services/replies';
import { indexSearch } from '../services/search';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let ownerKey: string;
let miaKey: string;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  mia = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
  ownerKey = createApiKey(ctx.db, { userId: owner.id, name: 'Owner script' }).key;
  miaKey = createApiKey(ctx.db, { userId: mia.id, name: 'Mia script' }).key;
  // Keys act as their owner's agent (agents A); the owner's agent administers the team with him.
  giveAgentOwnerRoles(ctx.db, owner.id);
});

afterEach(() => {
  ctx.close();
});

async function body(res: Response): Promise<unknown> {
  return res.json();
}

function deletedReply(author: UserRow, text = 'Remove me') {
  const issue = createIssue(ctx.db, { project: project.project, authorId: owner.id });
  const reply = createReply(ctx.deps, web(author), {
    parentType: 'issue',
    parentId: issue.id,
    body: text,
  });
  deleteReply(ctx.deps, web(author), reply.id);
  return { issue, reply };
}

describe('GET /api/teams/:teamId/trash', () => {
  it('lists the caller’s trash with pagination and a type filter', async () => {
    deletedReply(mia, 'first');
    deletedReply(mia, 'second');
    deletedReply(owner, 'owner only');

    const first = await ctx.app.request(`/api/teams/${team.team.id}/trash?limit=1`, {
      headers: bearer(miaKey),
    });
    expect(first.status).toBe(200);
    const page = trashPageSchema.parse(await body(first));
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    const second = trashPageSchema.parse(
      await body(
        await ctx.app.request(
          `/api/teams/${team.team.id}/trash?limit=5&cursor=${page.nextCursor ?? ''}`,
          { headers: bearer(miaKey) },
        ),
      ),
    );
    expect(second).toMatchObject({ items: [{ type: 'reply' }], nextCursor: null });
    expect([...page.items, ...second.items].map((item) => item.title).sort()).toEqual([
      'first',
      'second',
    ]);

    const filtered = trashPageSchema.parse(
      await body(
        await ctx.app.request(`/api/teams/${team.team.id}/trash?type=task`, {
          headers: bearer(ownerKey),
        }),
      ),
    );
    expect(filtered.items).toEqual([]);
  });

  it('validates the query and hides other teams', async () => {
    const bad = await ctx.app.request(`/api/teams/${team.team.id}/trash?type=team`, {
      headers: bearer(miaKey),
    });
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(await body(bad)).error.code).toBe('validation_failed');

    const outsiderKey = createApiKey(ctx.db, { userId: createUser(ctx.db).id }).key;
    const hidden = await ctx.app.request(`/api/teams/${team.team.id}/trash`, {
      headers: bearer(outsiderKey),
    });
    expect(hidden.status).toBe(404);
  });
});

describe('POST /api/trash/restore', () => {
  it('restores an item and returns its URL', async () => {
    const { issue, reply } = deletedReply(mia);
    const res = await ctx.app.request(
      '/api/trash/restore',
      json('POST', { type: 'reply', id: reply.id }, bearer(miaKey)),
    );
    expect(res.status).toBe(200);
    expect(restoreTrashResponseSchema.parse(await body(res))).toEqual({
      ok: true,
      type: 'reply',
      id: reply.id,
      url: `/t/acme/p/API/issues/${issue.number}#reply-${reply.id}`,
    });
    const activity = auditLogResponseSchema.parse(
      await body(
        await ctx.app.request(`/api/teams/${team.team.id}/audit-log?action=reply.restored`, {
          headers: bearer(ownerKey),
        }),
      ),
    );
    expect(activity.items).toHaveLength(1);
    expect(activity.items[0]?.actor).toMatchObject({
      source: 'api',
      via: { keyName: 'Mia script' },
    });
  });

  it("refuses someone else's item without MANAGE_TRASH and an unregistered type", async () => {
    const { reply } = deletedReply(owner);
    const forbidden = await ctx.app.request(
      '/api/trash/restore',
      json('POST', { type: 'reply', id: reply.id }, bearer(miaKey)),
    );
    expect(forbidden.status).toBe(403);

    // Mia's key acts as her agent: it needs the role too (and Mia must have it, as the cap).
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_TRASH'] });
    const miaAgent = createAgent(ctx.db, mia.id);
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: mia.id, roleId: role.id })
      .run();
    const capped = await ctx.app.request(
      '/api/trash/restore',
      json('POST', { type: 'reply', id: reply.id }, bearer(miaKey)),
    );
    expect(capped.status).toBe(403);
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: miaAgent.id, roleId: role.id })
      .run();
    const allowed = await ctx.app.request(
      '/api/trash/restore',
      json('POST', { type: 'reply', id: reply.id }, bearer(miaKey)),
    );
    expect(allowed.status).toBe(200);

    const invalid = await ctx.app.request(
      '/api/trash/restore',
      json('POST', { type: 'comment', id: reply.id }, bearer(miaKey)),
    );
    expect(invalid.status).toBe(400);
  });
});

describe('GET /api/teams/:teamId/audit-log', () => {
  it('filters by every SPEC §1.11 dimension', async () => {
    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    const key = createApiKey(ctx.db, { userId: mia.id, name: 'Claude' });
    const at = (iso: string) => new Date(iso);
    const rows: Array<[Actor | null, Parameters<typeof recordActivity>[2], Date]> = [
      [
        web(owner),
        {
          teamId: team.team.id,
          projectId: project.project.id,
          entityType: 'task',
          entityId: 't1',
          action: 'task.created',
        },
        at('2026-01-01T10:00:00Z'),
      ],
      [
        { userId: mia.id, source: 'mcp', key: { id: key.apiKey.id, name: 'Claude' } },
        {
          teamId: team.team.id,
          projectId: project.project.id,
          entityType: 'task',
          entityId: 't1',
          action: 'task.status_changed',
        },
        at('2026-01-02T10:00:00Z'),
      ],
      [
        web(owner),
        {
          teamId: team.team.id,
          projectId: other.project.id,
          entityType: 'label',
          entityId: 'l1',
          action: 'label.created',
        },
        at('2026-01-03T10:00:00Z'),
      ],
      [
        null,
        { teamId: team.team.id, entityType: 'role', entityId: 'r1', action: 'role.updated' },
        at('2026-01-04T10:00:00Z'),
      ],
    ];
    for (const [actor, input, createdAt] of rows) {
      ctx.db.write((tx) => {
        const row = recordActivity(tx, actor, input);
        tx.update(s.activity).set({ createdAt }).where(eq(s.activity.id, row.id)).run();
      });
    }
    const ids = async (query: string) => {
      const res = await ctx.app.request(`/api/teams/${team.team.id}/audit-log?${query}`, {
        headers: bearer(ownerKey),
      });
      expect(res.status, query).toBe(200);
      return auditLogResponseSchema.parse(await body(res)).items.map((item) => item.action);
    };
    expect(await ids('')).toEqual([
      'role.updated',
      'label.created',
      'task.status_changed',
      'task.created',
    ]);
    expect(await ids(`actorId=${mia.id}`)).toEqual(['task.status_changed']);
    expect(await ids('source=system')).toEqual(['role.updated']);
    expect(await ids(`keyId=${key.apiKey.id}`)).toEqual(['task.status_changed']);
    expect(await ids('entityType=label')).toEqual(['label.created']);
    expect(await ids('action=task.')).toEqual(['task.status_changed', 'task.created']);
    expect(await ids('action=task.created')).toEqual(['task.created']);
    expect(await ids(`projectId=${other.project.id}`)).toEqual(['label.created']);
    expect(
      await ids(
        `from=${encodeURIComponent('2026-01-02T00:00:00Z')}&to=${encodeURIComponent('2026-01-04T00:00:00Z')}`,
      ),
    ).toEqual(['label.created', 'task.status_changed']);

    const denied = await ctx.app.request(`/api/teams/${team.team.id}/audit-log`, {
      headers: bearer(miaKey),
    });
    expect(denied.status).toBe(403);
  });
});

describe('GET /api/teams/:teamId/audit-log/facets', () => {
  it('returns the filter values to auditors only', async () => {
    deletedReply(mia);
    const res = await ctx.app.request(`/api/teams/${team.team.id}/audit-log/facets`, {
      headers: bearer(ownerKey),
    });
    expect(res.status).toBe(200);
    const facets = auditLogFacetsSchema.parse(await body(res));
    expect(facets.actions).toEqual(['reply.created', 'reply.deleted']);
    expect(facets.actors.map((user) => user.username)).toEqual(['mia']);

    const denied = await ctx.app.request(`/api/teams/${team.team.id}/audit-log/facets`, {
      headers: bearer(miaKey),
    });
    expect(denied.status).toBe(403);
  });
});

describe('GET /api/search', () => {
  it('searches the caller’s teams', async () => {
    const issue = createIssue(ctx.db, { project: project.project, title: 'Login crash' });
    ctx.db.write((tx) =>
      indexSearch(tx, {
        entityType: 'issue',
        entityId: issue.id,
        teamId: team.team.id,
        projectId: project.project.id,
        title: issue.title,
        text: 'Safari crashes on submit',
      }),
    );
    const res = await ctx.app.request('/api/search?q=crash&types=issue', {
      headers: bearer(miaKey),
    });
    expect(res.status).toBe(200);
    expect(searchResponseSchema.parse(await body(res)).results).toMatchObject([
      { entityId: issue.id, ref: `API#${issue.number}`, title: 'Login crash' },
    ]);
    const invalid = await ctx.app.request('/api/search?q=crash&types=comment', {
      headers: bearer(miaKey),
    });
    expect(invalid.status).toBe(400);
  });
});
