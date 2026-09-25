import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogFacetsSchema, trashPageSchema } from '@shared/schemas/admin';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  createApiKey,
  createIssue,
  createProject,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  type CreatedProject,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { canRestoreContent, requireMember } from './access';
import { recordActivity } from './activity';
import {
  getAuditLogFacets,
  listTeamTrash,
  resolveAuditLogKey,
  resolveTrashRef,
  restoreTrashItem,
} from './admin';
import { uploadAttachmentContent, deleteAttachment } from './attachments';
import { createReply, deleteReply } from './replies';
import { trashHandlers, type TrashHandler } from './trashHandlers';

let ctx: TestContext;
let owner: UserRow;
let mia: UserRow;
let team: CreatedTeam;
let project: CreatedProject;
let savedTaskHandler: TrashHandler | undefined;

const web = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });
const DAY = 24 * 60 * 60 * 1000;

/**
 * A test-only task handler (the tasks module registers the real one): soft delete and restore
 * with the author / MANAGE_TRASH rule and an audit row, like every module's handler.
 */
const testTaskHandler: TrashHandler = {
  softDelete(deps, actor, id) {
    deps.db.write((tx) => {
      tx.update(s.task)
        .set({ deletedAt: new Date(), deletedById: actor.userId })
        .where(eq(s.task.id, id))
        .run();
    });
  },
  restore(deps, actor, id) {
    const row = deps.db.orm.select().from(s.task).where(eq(s.task.id, id)).get();
    if (!row?.deletedAt) throw new Error('not deleted');
    const membership = requireMember(deps.db.orm, actor, row.teamId, 'Deleted task');
    if (!canRestoreContent(membership, row.authorId)) throw new Error('forbidden');
    deps.db.write((tx) => {
      tx.update(s.task).set({ deletedAt: null, deletedById: null }).where(eq(s.task.id, id)).run();
      recordActivity(tx, actor, {
        teamId: row.teamId,
        projectId: row.projectId,
        entityType: 'task',
        entityId: id,
        action: 'task.restored',
      });
    });
  },
};

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner', name: 'Olive Owner' });
  mia = createUser(ctx.db, { username: 'mia', name: 'Mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: mia.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API', name: 'API' });
  savedTaskHandler = trashHandlers.task;
  trashHandlers.task = testTaskHandler;
});

afterEach(() => {
  if (savedTaskHandler) trashHandlers.task = savedTaskHandler;
  else delete trashHandlers.task;
  ctx.close();
});

function softDelete(
  table: typeof s.task | typeof s.issue | typeof s.project,
  id: string,
  by: string,
  at = new Date(),
) {
  ctx.db.orm.update(table).set({ deletedAt: at, deletedById: by }).where(eq(table.id, id)).run();
}

describe('listTeamTrash', () => {
  it('pages through the trash newest first with stable cursors and a type filter', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const tasks = Array.from({ length: 5 }, (_, index) =>
      createTask(ctx.db, { project: project.project, authorId: mia.id, title: `Task ${index}` }),
    );
    // Two deletions at the same instant exercise the tiebreaker.
    tasks.forEach((task, index) =>
      softDelete(s.task, task.id, mia.id, new Date(now.getTime() - Math.min(index, 3) * DAY)),
    );
    const issue = createIssue(ctx.db, { project: project.project, authorId: mia.id });
    softDelete(s.issue, issue.id, mia.id, new Date(now.getTime() - 10 * DAY));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listTeamTrash(ctx.deps, web(mia), team.team.id, { limit: 2, cursor }, now);
      expect(trashPageSchema.parse(page)).toEqual(page);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(seen.at(-1)).toBe(issue.id);

    const onlyIssues = listTeamTrash(ctx.deps, web(mia), team.team.id, {
      limit: 50,
      type: 'issue',
    });
    expect(onlyIssues).toMatchObject({
      items: [{ id: issue.id, type: 'issue' }],
      nextCursor: null,
    });
  });

  it('shows authors their own items, MANAGE_TRASH everything, and hides the team from outsiders', () => {
    const mine = createTask(ctx.db, { project: project.project, authorId: mia.id });
    const theirs = createTask(ctx.db, { project: project.project, authorId: owner.id });
    softDelete(s.task, mine.id, owner.id);
    softDelete(s.task, theirs.id, owner.id);

    const forMia = listTeamTrash(ctx.deps, web(mia), team.team.id, { limit: 50 });
    expect(forMia.items.map((item) => item.id)).toEqual([mine.id]);
    expect(forMia.items[0]).toMatchObject({ deletedBy: { username: 'owner' }, daysLeft: 30 });

    const moderator = createUser(ctx.db);
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_TRASH'] });
    addMember(ctx.db, { teamId: team.team.id, userId: moderator.id, roleIds: [role.id] });
    expect(listTeamTrash(ctx.deps, web(moderator), team.team.id, { limit: 50 }).items).toHaveLength(
      2,
    );

    const outsider = createUser(ctx.db);
    expect(() => listTeamTrash(ctx.deps, web(outsider), team.team.id, { limit: 50 })).toThrow(
      /Team not found/,
    );
  });

  it('rejects a malformed cursor', () => {
    expect(() =>
      listTeamTrash(ctx.deps, web(mia), team.team.id, { limit: 5, cursor: 'nope' }),
    ).toThrow(/Invalid cursor/);
  });
});

describe('restoreTrashItem', () => {
  it('restores a reply and links to it in its thread', () => {
    const task = createTask(ctx.db, { project: project.project, authorId: owner.id });
    const reply = createReply(ctx.deps, web(mia), {
      parentType: 'task',
      parentId: task.id,
      body: 'Looks good',
    });
    deleteReply(ctx.deps, web(mia), reply.id);

    expect(restoreTrashItem(ctx.deps, web(mia), { type: 'reply', id: reply.id })).toEqual({
      ok: true,
      type: 'reply',
      id: reply.id,
      url: `/t/acme/p/API/tasks/${task.number}#reply-${reply.id}`,
    });
    const row = ctx.db.orm.select().from(s.reply).where(eq(s.reply.id, reply.id)).get();
    expect(row?.deletedAt).toBeNull();
  });

  it('links a restored attachment to the item it belongs to', async () => {
    const issue = createIssue(ctx.db, { project: project.project, authorId: mia.id });
    const file = await uploadAttachmentContent(ctx.deps, web(mia), {
      teamId: team.team.id,
      parentType: 'issue',
      parentId: issue.id,
      filename: 'trace.txt',
      text: 'boom',
    });
    deleteAttachment(ctx.deps, web(mia), file.id);
    const restored = restoreTrashItem(ctx.deps, web(mia), { type: 'attachment', id: file.id });
    expect(restored.url).toBe(`/t/acme/p/API/issues/${issue.number}`);
  });

  it('restores through a registered handler and enforces its permission rule', () => {
    const task = createTask(ctx.db, { project: project.project, authorId: owner.id });
    softDelete(s.task, task.id, owner.id);
    expect(() => restoreTrashItem(ctx.deps, web(mia), { type: 'task', id: task.id })).toThrow(
      /forbidden/,
    );
    const restored = restoreTrashItem(ctx.deps, web(owner), { type: 'task', id: task.id });
    expect(restored.url).toBe(`/t/acme/p/API/tasks/${task.number}`);
    const history = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.entityId, task.id))
      .all();
    expect(history.map((row) => row.action)).toContain('task.restored');
  });

  it('has no URL while the restored task still sits in a deleted project', () => {
    const task = createTask(ctx.db, { project: project.project, authorId: owner.id });
    softDelete(s.task, task.id, owner.id);
    softDelete(s.project, project.project.id, owner.id);
    expect(restoreTrashItem(ctx.deps, web(owner), { type: 'task', id: task.id }).url).toBeNull();
  });
});

describe('resolveTrashRef', () => {
  it('finds deleted tasks, issues and projects by ref', () => {
    const task = createTask(ctx.db, { project: project.project });
    const issue = createIssue(ctx.db, { project: project.project });
    softDelete(s.task, task.id, owner.id);
    softDelete(s.issue, issue.id, owner.id);

    expect(resolveTrashRef(ctx.deps, web(mia), { item: `API-${task.number}` })).toEqual({
      type: 'task',
      id: task.id,
    });
    expect(resolveTrashRef(ctx.deps, web(mia), { item: `acme/api#${issue.number}` })).toEqual({
      type: 'issue',
      id: issue.id,
    });

    const other = createProject(ctx.db, { teamId: team.team.id, key: 'WEB' });
    softDelete(s.project, other.project.id, owner.id);
    expect(resolveTrashRef(ctx.deps, web(mia), { item: 'WEB' })).toEqual({
      type: 'project',
      id: other.project.id,
    });
  });

  it('finds deleted items by id, with an optional type', async () => {
    const task = createTask(ctx.db, { project: project.project });
    softDelete(s.task, task.id, owner.id);
    expect(resolveTrashRef(ctx.deps, web(mia), { item: task.id })).toEqual({
      type: 'task',
      id: task.id,
    });
    const file = await uploadAttachmentContent(ctx.deps, web(mia), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'a.txt',
      text: 'a',
    });
    deleteAttachment(ctx.deps, web(mia), file.id);
    expect(resolveTrashRef(ctx.deps, web(mia), { item: file.id, type: 'attachment' })).toEqual({
      type: 'attachment',
      id: file.id,
    });
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: file.id, type: 'reply' })).toThrow(
      /not found/,
    );
  });

  it('explains live items, items of deleted projects and type mismatches', () => {
    const live = createTask(ctx.db, { project: project.project });
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: `API-${live.number}` })).toThrow(
      /is not in Trash/,
    );
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: 'API' })).toThrow(/is not in Trash/);
    expect(() =>
      resolveTrashRef(ctx.deps, web(mia), { item: `API-${live.number}`, type: 'issue' }),
    ).toThrow(/is a task ref, not a issue/);

    softDelete(s.project, project.project.id, owner.id);
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: `API-${live.number}` })).toThrow(
      /Restore the project API instead/,
    );
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: 'API-999' })).toThrow(/not found/);
  });

  it('never resolves items in teams the caller is not in, and reports ambiguous refs', () => {
    const task = createTask(ctx.db, { project: project.project });
    softDelete(s.task, task.id, owner.id);
    const outsider = createUser(ctx.db);
    expect(() => resolveTrashRef(ctx.deps, web(outsider), { item: 'API-1' })).toThrow(/not found/);
    expect(() => resolveTrashRef(ctx.deps, web(outsider), { item: task.id })).toThrow(/not found/);

    const second = createTeam(ctx.db, { ownerId: owner.id, slug: 'beta' });
    const betaProject = createProject(ctx.db, { teamId: second.team.id, key: 'API' });
    const betaTask = createTask(ctx.db, { project: betaProject.project });
    softDelete(s.task, betaTask.id, owner.id);
    expect(() => resolveTrashRef(ctx.deps, web(owner), { item: 'API-1' })).toThrow(
      /ambiguous.*acme\/API-1.*beta\/API-1/,
    );
    expect(resolveTrashRef(ctx.deps, web(owner), { item: 'beta/API-1' })).toEqual({
      type: 'task',
      id: betaTask.id,
    });
  });

  it("resolves a deleted team's id for its owner only", () => {
    ctx.db.orm
      .update(s.team)
      .set({ deletedAt: new Date(), deletedById: owner.id })
      .where(eq(s.team.id, team.team.id))
      .run();
    expect(resolveTrashRef(ctx.deps, web(owner), { item: team.team.id })).toEqual({
      type: 'team',
      id: team.team.id,
    });
    expect(() => resolveTrashRef(ctx.deps, web(mia), { item: team.team.id })).toThrow(/not found/);
  });
});

describe('getAuditLogFacets', () => {
  function log(actor: Actor | null, input: Parameters<typeof recordActivity>[2]) {
    ctx.db.write((tx) => recordActivity(tx, actor, input));
  }

  it('lists the actors, sources, keys, entity types, actions and projects in the log', () => {
    const key = createApiKey(ctx.db, { userId: mia.id, name: 'Claude on laptop' });
    const agent: Actor = {
      userId: mia.id,
      source: 'mcp',
      key: { id: key.apiKey.id, name: 'Claude (old name)' },
    };
    const base = { teamId: team.team.id, projectId: project.project.id, entityId: 'x' } as const;
    log(agent, { ...base, entityType: 'task', action: 'task.created' });
    log(
      { ...agent, key: { id: key.apiKey.id, name: 'Claude on laptop' } },
      {
        ...base,
        entityType: 'task',
        action: 'task.status_changed',
      },
    );
    log(web(owner), {
      teamId: team.team.id,
      entityType: 'role',
      entityId: 'r',
      action: 'role.created',
    });
    log(null, { ...base, entityType: 'task', action: 'task.claim_expired' });
    const gone = createProject(ctx.db, { teamId: team.team.id, key: 'OLD', name: 'Old stuff' });
    softDelete(s.project, gone.project.id, owner.id);
    log(web(owner), {
      ...base,
      projectId: gone.project.id,
      entityType: 'project',
      action: 'project.deleted',
    });
    // Other teams' rows never leak into the facets.
    const other = createTeam(ctx.db, { ownerId: mia.id });
    log(web(mia), {
      teamId: other.team.id,
      entityType: 'team',
      entityId: 't',
      action: 'team.created',
    });

    const facets = getAuditLogFacets(ctx.deps, web(owner), team.team.id);
    expect(auditLogFacetsSchema.parse(facets)).toEqual(facets);
    expect(facets.actors.map((user) => user.username)).toEqual(['mia', 'owner']);
    expect(facets.sources).toEqual(['web', 'mcp', 'system']);
    expect(facets.keys.map((facet) => [facet.keyId, facet.keyName, facet.user?.username])).toEqual([
      [key.apiKey.id, 'Claude on laptop', 'mia'],
    ]);
    expect(facets.entityTypes).toEqual(['task', 'project', 'role']);
    expect(facets.actions).toEqual([
      'project.deleted',
      'role.created',
      'task.claim_expired',
      'task.created',
      'task.status_changed',
    ]);
    expect(facets.projects).toEqual([
      { id: project.project.id, key: 'API', name: 'API', deleted: false },
      { id: gone.project.id, key: 'OLD', name: 'Old stuff', deleted: true },
    ]);
  });

  it('needs VIEW_AUDIT_LOG and membership', () => {
    expect(() => getAuditLogFacets(ctx.deps, web(mia), team.team.id)).toThrow(
      /permission to view the audit log/,
    );
    const auditor = createUser(ctx.db);
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['VIEW_AUDIT_LOG'] });
    addMember(ctx.db, { teamId: team.team.id, userId: auditor.id, roleIds: [role.id] });
    expect(getAuditLogFacets(ctx.deps, web(auditor), team.team.id).actions).toEqual([]);
    expect(() => getAuditLogFacets(ctx.deps, web(createUser(ctx.db)), team.team.id)).toThrow(
      /Team not found/,
    );
  });

  it('resolves API keys by id or by name', () => {
    const first = createApiKey(ctx.db, { userId: mia.id, name: 'Codex' });
    const second = createApiKey(ctx.db, { userId: owner.id, name: 'Codex' });
    const third = createApiKey(ctx.db, { userId: owner.id, name: 'Claude' });
    for (const key of [first, second, third]) {
      log(
        {
          userId: key.apiKey.userId,
          source: 'mcp',
          key: { id: key.apiKey.id, name: key.apiKey.name },
        },
        { teamId: team.team.id, entityType: 'task', entityId: 'x', action: 'task.created' },
      );
    }
    expect(resolveAuditLogKey(ctx.deps, web(owner), team.team.id, 'claude')).toBe(third.apiKey.id);
    expect(resolveAuditLogKey(ctx.deps, web(owner), team.team.id, first.apiKey.id)).toBe(
      first.apiKey.id,
    );
    expect(() => resolveAuditLogKey(ctx.deps, web(owner), team.team.id, 'Codex')).toThrow(
      /ambiguous/,
    );
    expect(() => resolveAuditLogKey(ctx.deps, web(owner), team.team.id, 'Nope')).toThrow(
      /API key not found/,
    );
  });
});
