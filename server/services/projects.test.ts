import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { apiErrorSchema } from '@shared/schemas/common';
import { meResponseSchema } from '@shared/schemas/core';
import {
  deriveProjectKey,
  projectKeyCandidates,
  projectKeyCheckResponseSchema,
  projectListResponseSchema,
  projectSchema,
  projectSummarySchema,
} from '@shared/schemas/projects';
import type { Actor } from '../context';
import * as s from '../db/schema';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject as createProjectRow,
  createRole,
  createTask,
  createTeam,
  createTestContext,
  createUser,
  giveAgentOwnerRoles,
  giveRoleWithAgent,
  json,
  type CreatedTeam,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { listTrash, restoreItem } from './trash';
import { resolveTask } from './refs';
import {
  createProject,
  deleteProject,
  getProject,
  restoreProject,
  updateProject,
} from './projects';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let outsider: UserRow;
let team: CreatedTeam;
let ownerKey: string;
let memberKey: string;
let outsiderKey: string;
let events: LiveEvent[];

const actorOf = (user: { id: string }): Actor => ({ userId: user.id, source: 'web', key: null });

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  outsider = createUser(ctx.db, { username: 'olga' });
  // These tests are about the actions themselves; sign-off has its own (agentActions.test.ts).
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme', agentSignoff: false });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  ownerKey = createApiKey(ctx.db, { userId: owner.id, name: 'Claude on laptop' }).key;
  memberKey = createApiKey(ctx.db, { userId: member.id }).key;
  outsiderKey = createApiKey(ctx.db, { userId: outsider.id }).key;
  // Keys act as their owner's agent member, capped by the owner (agents A): the owner's agent
  // administers the team with him.
  giveAgentOwnerRoles(ctx.db, owner.id);
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  ctx.close();
});

function activityOf(entityId: string) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(eq(s.activity.entityId, entityId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function post(path: string, body: unknown, key = ownerKey) {
  return ctx.app.request(path, json('POST', body, bearer(key)));
}

async function errorCode(res: Response) {
  return apiErrorSchema.parse(await res.json()).error.code;
}

describe('deriveProjectKey', () => {
  it.each([
    ['Baton', 'BAT'],
    ['Web app', 'WA'],
    ['Customer support portal', 'CSP'],
    ['Customer support portal and friends', 'CSPA'],
    ['Café crème', 'CC'],
    ['3D printer', 'DP'],
    ['3D', 'DX'],
    ['X', 'XX'],
    ['API', 'API'],
    ['   ', 'PRJ'],
    ['日本語', 'PRJ'],
    ['Q3 plans', 'QP'],
  ])('%j → %s', (name, key) => {
    expect(deriveProjectKey(name)).toBe(key);
    expect(key).toMatch(/^[A-Z][A-Z0-9]{1,5}$/);
  });

  it('suggests numbered alternatives that stay within six characters', () => {
    expect(projectKeyCandidates('WEBAPP', 12)).toEqual([
      'WEBAPP',
      'WEBAP2',
      'WEBAP3',
      'WEBAP4',
      'WEBAP5',
      'WEBAP6',
      'WEBAP7',
      'WEBAP8',
      'WEBAP9',
      'WEBA10',
      'WEBA11',
      'WEBA12',
    ]);
  });
});

describe('creating projects', () => {
  it('creates a project over REST with a derived key, default statuses, audit and event', async () => {
    const res = await post(`/api/teams/${team.team.id}/projects`, {
      name: 'Web app',
      description: 'The customer-facing web app',
      icon: '🚀',
      color: '#0EA5E9',
    });
    expect(res.status).toBe(201);
    const project = projectSchema.parse(await res.json());
    expect(project).toMatchObject({
      name: 'Web app',
      key: 'WA',
      ref: 'acme/WA',
      teamSlug: 'acme',
      description: 'The customer-facing web app',
      icon: '🚀',
      color: '#0ea5e9',
      readme: '',
      path: '/t/acme/p/WA',
      // Created through the owner's key: by his agent member (agents A).
      createdBy: { username: 'owner-ai', kind: 'agent', agentOwner: { username: 'owner' } },
      keyAliases: [],
      labels: [],
      counts: {
        tasks: 0,
        assignedTasks: 0,
        completedTasks: 0,
        openTasks: 0,
        doneTasks: 0,
        openIssues: 0,
        resolvedIssues: 0,
      },
    });
    // Two ordinary stages: Open, and Done with the finishing rules.
    expect(
      project.statuses.map((status) => [
        status.name,
        status.icon,
        status.isDefault,
        status.rules?.handoff.mode,
        status.rules?.onEnter,
        status.rules?.blocksDependents,
        status.rules?.claimable,
      ]),
    ).toEqual([
      [
        'Open',
        'circle',
        true,
        'keep',
        { resolveIssues: false, releaseClaim: false, notifyAuthor: false },
        true,
        true,
      ],
      [
        'Done',
        'check-circle',
        false,
        'nobody',
        { resolveIssues: true, releaseClaim: true, notifyAuthor: true },
        false,
        false,
      ],
    ]);

    const [row] = activityOf(project.id);
    expect(row).toMatchObject({
      action: 'project.created',
      source: 'api',
      viaKeyName: 'Claude on laptop',
      teamId: team.team.id,
      projectId: project.id,
      meta: { name: 'Web app', key: 'WA' },
    });
    expect(events.map((event) => event.type)).toContain('project.created');
  });

  it('makes a derived key unique and refuses a key that is taken', async () => {
    const first = projectSchema.parse(
      await (await post(`/api/teams/${team.team.id}/projects`, { name: 'Web app' })).json(),
    );
    const second = projectSchema.parse(
      await (await post(`/api/teams/${team.team.id}/projects`, { name: 'Web App' })).json(),
    );
    expect([first.key, second.key]).toEqual(['WA', 'WA2']);

    const clash = await post(`/api/teams/${team.team.id}/projects`, { name: 'Other', key: 'wa' });
    expect(clash.status).toBe(409);
    expect(await errorCode(clash)).toBe('conflict');
  });

  it('validates input', async () => {
    const tooLong = await post(`/api/teams/${team.team.id}/projects`, {
      name: 'Docs',
      description: 'x'.repeat(281),
    });
    expect(tooLong.status).toBe(400);
    const badKey = await post(`/api/teams/${team.team.id}/projects`, { name: 'Docs', key: '1A' });
    expect(badKey.status).toBe(400);
    const badIcon = await post(`/api/teams/${team.team.id}/projects`, { name: 'Docs', icon: 'x' });
    expect(badIcon.status).toBe(400);
  });

  it('needs MANAGE_PROJECTS, and outsiders get 404', async () => {
    const forbidden = await post(
      `/api/teams/${team.team.id}/projects`,
      { name: 'Docs' },
      memberKey,
    );
    expect(forbidden.status).toBe(403);
    const hidden = await post(`/api/teams/${team.team.id}/projects`, { name: 'Docs' }, outsiderKey);
    expect(hidden.status).toBe(404);

    const managers = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_PROJECTS'] });
    giveRoleWithAgent(ctx.db, { teamId: team.team.id, userId: member.id, roleId: managers.id });
    expect(
      (await post(`/api/teams/${team.team.id}/projects`, { name: 'Docs' }, memberKey)).status,
    ).toBe(201);
  });

  it('attaches README uploads and notifies people mentioned in the README', () => {
    const upload = ctx.db.orm
      .insert(s.attachment)
      .values({
        teamId: team.team.id,
        uploaderId: owner.id,
        parentType: 'pending',
        filename: 'diagram.png',
        mimeType: 'image/png',
        size: 10,
        sha256: 'x',
        storagePath: '2026/09/diagram',
      })
      .returning()
      .get();
    const project = createProject(ctx.deps, actorOf(owner), team.team.id, {
      name: 'Docs',
      readme: `# Docs\n\n![diagram](/api/attachments/${upload.id}/diagram.png)\n\nOwned by @mia`,
    });
    const attached = ctx.db.orm
      .select()
      .from(s.attachment)
      .where(eq(s.attachment.id, upload.id))
      .get();
    expect(attached).toMatchObject({ parentType: 'project', parentId: project.id });
    const notifications = ctx.db.orm
      .select()
      .from(s.notification)
      .where(eq(s.notification.userId, member.id))
      .all();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'mention',
      entityType: 'project',
      entityId: project.id,
      title: 'Docs README',
      url: '/t/acme/p/DOC',
    });
  });
});

describe('reading projects', () => {
  it('lists and gets projects with counts that ignore deleted items', async () => {
    const { project, statuses } = createProjectRow(ctx.db, {
      teamId: team.team.id,
      name: 'API',
      key: 'API',
    });
    createProjectRow(ctx.db, { teamId: team.team.id, name: 'Backlog', key: 'BL' });
    const done = statuses.find((status) => status.name === 'Done');
    createTask(ctx.db, { project });
    createTask(ctx.db, { project });
    createTask(ctx.db, { project, statusId: done?.id });
    const trashed = createTask(ctx.db, { project });
    ctx.db.orm.update(s.task).set({ deletedAt: new Date() }).where(eq(s.task.id, trashed.id)).run();
    createIssue(ctx.db, { project });
    const resolved = createIssue(ctx.db, { project });
    ctx.db.orm.update(s.issue).set({ resolved: true }).where(eq(s.issue.id, resolved.id)).run();

    const list = projectListResponseSchema.parse(
      await (
        await ctx.app.request(`/api/teams/${team.team.id}/projects`, { headers: bearer(memberKey) })
      ).json(),
    );
    expect(list.items.map((item) => item.key)).toEqual(['API', 'BL']);
    expect(list.items[0]?.counts).toEqual({
      tasks: 3,
      assignedTasks: 0,
      completedTasks: 1,
      openTasks: 2,
      doneTasks: 1,
      openIssues: 1,
      resolvedIssues: 1,
    });

    const detail = projectSchema.parse(
      await (
        await ctx.app.request(`/api/projects/${project.id}`, { headers: bearer(memberKey) })
      ).json(),
    );
    expect(detail.statuses.map((status) => status.taskCount)).toEqual([2, 1]);

    const hidden = await ctx.app.request(`/api/projects/${project.id}`, {
      headers: bearer(outsiderKey),
    });
    expect(hidden.status).toBe(404);
    const hiddenList = await ctx.app.request(`/api/teams/${team.team.id}/projects`, {
      headers: bearer(outsiderKey),
    });
    expect(hiddenList.status).toBe(404);
  });

  it('checks key availability with a suggestion', async () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'API' });
    const check = async (query: string) =>
      projectKeyCheckResponseSchema.parse(
        await (
          await ctx.app.request(`/api/teams/${team.team.id}/projects/key-check?${query}`, {
            headers: bearer(memberKey),
          })
        ).json(),
      );
    expect(await check('key=api')).toEqual({
      key: 'API',
      valid: true,
      available: false,
      message: 'Another project in this team already uses API',
      suggestion: 'API2',
    });
    expect(await check(`key=API&projectId=${project.id}`)).toMatchObject({
      available: true,
      message: null,
      suggestion: 'API',
    });
    expect(await check('key=web')).toMatchObject({ key: 'WEB', valid: true, available: true });
    expect(await check('key=9x')).toMatchObject({ valid: false, available: false });
  });
});

describe('updating projects', () => {
  it('audits field-level changes and summarises README edits', () => {
    const project = createProject(ctx.deps, actorOf(owner), team.team.id, { name: 'Docs' });
    events = [];
    const updated = updateProject(ctx.deps, actorOf(owner), project.id, {
      name: 'Documentation',
      description: 'Guides and references',
      icon: '📚',
      readme: '# Welcome\n\nStart **here**.',
    });
    expect(updated).toMatchObject({
      name: 'Documentation',
      description: 'Guides and references',
      icon: '📚',
      readme: '# Welcome\n\nStart **here**.',
    });
    const row = activityOf(project.id).find((entry) => entry.action === 'project.updated');
    expect(row?.changes).toEqual({
      name: { from: 'Docs', to: 'Documentation' },
      description: { from: '', to: 'Guides and references' },
      icon: { from: null, to: '📚' },
      readme: { from: '', to: 'Welcome Start here.' },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['project.updated', 'activity.created']),
    );

    // No-op updates write nothing.
    const before = activityOf(project.id).length;
    updateProject(ctx.deps, actorOf(owner), project.id, { name: 'Documentation' });
    expect(activityOf(project.id)).toHaveLength(before);

    // Clearing the icon.
    expect(updateProject(ctx.deps, actorOf(owner), project.id, { icon: null }).icon).toBeNull();
  });

  it('keeps an old key resolving after a key change, and can take it back', async () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'OLD' });
    const task = createTask(ctx.db, { project });

    const res = await ctx.app.request(
      `/api/projects/${project.id}`,
      json('PATCH', { key: 'new' }, bearer(ownerKey)),
    );
    expect(res.status).toBe(200);
    const updated = projectSchema.parse(await res.json());
    expect(updated).toMatchObject({ key: 'NEW', keyAliases: ['OLD'], path: '/t/acme/p/NEW' });
    expect(activityOf(project.id).at(-1)).toMatchObject({
      action: 'project.updated',
      changes: { key: { from: 'OLD', to: 'NEW' } },
      meta: { previousKey: 'OLD', key: 'NEW' },
    });

    // Old refs and URLs resolve to the project.
    expect(resolveTask(ctx.deps, actorOf(member), 'acme/OLD-1').task.id).toBe(task.id);
    const resolved = await ctx.app.request('/api/projects/resolve?ref=acme/OLD', {
      headers: bearer(memberKey),
    });
    expect(projectSummarySchema.parse(await resolved.json())).toMatchObject({
      id: project.id,
      key: 'NEW',
    });
    const unknown = await ctx.app.request('/api/projects/resolve?ref=acme/NOPE', {
      headers: bearer(memberKey),
    });
    expect(unknown.status).toBe(404);

    // Back to the old key: the alias goes, the intermediate key becomes one.
    const back = updateProject(ctx.deps, actorOf(owner), project.id, { key: 'OLD' });
    expect(back.keyAliases).toEqual(['NEW']);
  });

  it('lets a new project take over a previous key, which then means the new project', () => {
    const { project: first } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'WEB' });
    updateProject(ctx.deps, actorOf(owner), first.id, { key: 'SITE' });
    const second = createProject(ctx.deps, actorOf(owner), team.team.id, {
      name: 'Web',
      key: 'WEB',
    });
    expect(getProject(ctx.deps, actorOf(owner), first.id).keyAliases).toEqual([]);
    const task = createTask(ctx.db, { project: { ...first, id: second.id } });
    expect(resolveTask(ctx.deps, actorOf(owner), 'acme/WEB-1').task.id).toBe(task.id);

    // Derived keys avoid previous keys when they can.
    updateProject(ctx.deps, actorOf(owner), second.id, { key: 'WWW' });
    const third = createProject(ctx.deps, actorOf(owner), team.team.id, { name: 'Web' });
    expect(third.key).toBe('WEB2');
  });

  it('refuses a key used by another project and needs MANAGE_PROJECTS', async () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'ONE' });
    createProjectRow(ctx.db, { teamId: team.team.id, key: 'TWO' });
    expect(() => updateProject(ctx.deps, actorOf(owner), project.id, { key: 'TWO' })).toThrow(
      /already uses the key TWO/,
    );
    const forbidden = await ctx.app.request(
      `/api/projects/${project.id}`,
      json('PATCH', { name: 'Renamed' }, bearer(memberKey)),
    );
    expect(forbidden.status).toBe(403);
    const empty = await ctx.app.request(
      `/api/projects/${project.id}`,
      json('PATCH', {}, bearer(ownerKey)),
    );
    expect(empty.status).toBe(400);
  });

  it('attaches README images uploaded while editing, and explicit uploads', () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'DOC' });
    const pending = (filename: string, uploaderId = owner.id) =>
      ctx.db.orm
        .insert(s.attachment)
        .values({
          teamId: team.team.id,
          uploaderId,
          parentType: 'pending',
          filename,
          mimeType: 'image/png',
          size: 1,
          sha256: 'x',
          storagePath: `2026/09/${filename}`,
        })
        .returning()
        .get();
    const image = pending('a.png');
    const file = pending('b.pdf');
    const someoneElses = pending('c.png', member.id);
    updateProject(ctx.deps, actorOf(owner), project.id, {
      readme: `![a](/api/attachments/${image.id}/a.png) ![c](/api/attachments/${someoneElses.id}/c.png)`,
      attachmentIds: [file.id],
    });
    const parents = ctx.db.orm
      .select({ id: s.attachment.id, parentType: s.attachment.parentType })
      .from(s.attachment)
      .all();
    expect(Object.fromEntries(parents.map((row) => [row.id, row.parentType]))).toEqual({
      [image.id]: 'project',
      [file.id]: 'project',
      [someoneElses.id]: 'pending',
    });
  });
});

describe('deleting and restoring projects', () => {
  it('hides a deleted project and everything in it until it is restored', async () => {
    const { project } = createProjectRow(ctx.db, {
      teamId: team.team.id,
      key: 'API',
      name: 'API',
      createdById: owner.id,
    });
    createTask(ctx.db, { project });

    const res = await ctx.app.request(`/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: bearer(ownerKey),
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(
      (await ctx.app.request(`/api/projects/${project.id}`, { headers: bearer(ownerKey) })).status,
    ).toBe(404);
    expect(() => resolveTask(ctx.deps, actorOf(owner), 'acme/API-1')).toThrow(/not found/);
    const me = meResponseSchema.parse(
      await (await ctx.app.request('/api/me', { headers: bearer(ownerKey) })).json(),
    );
    expect(me.teams[0]?.projects).toEqual([]);
    expect(listTrash(ctx.deps, actorOf(owner), team.team.id).items).toMatchObject([
      { type: 'project', id: project.id, title: 'API', ref: 'API' },
    ]);
    expect(events.map((event) => event.type)).toContain('project.deleted');

    // Restoring through the Trash registry brings it all back.
    restoreItem(ctx.deps, actorOf(owner), { type: 'project', id: project.id });
    expect(resolveTask(ctx.deps, actorOf(owner), 'acme/API-1').project.id).toBe(project.id);
    expect(activityOf(project.id).map((row) => row.action)).toEqual([
      'project.deleted',
      'project.restored',
    ]);
    expect(events.map((event) => event.type)).toContain('project.restored');
  });

  it('restores over REST with a new key when the old one was taken', async () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'API' });
    deleteProject(ctx.deps, actorOf(owner), project.id);
    createProjectRow(ctx.db, { teamId: team.team.id, key: 'API' });

    const clash = await post(`/api/projects/${project.id}/restore`, {});
    expect(clash.status).toBe(409);
    expect(apiErrorSchema.parse(await clash.json()).error).toMatchObject({
      code: 'conflict',
      details: { key: 'API', suggestion: 'API2' },
    });

    // A body is optional: without one the project keeps its key (here: still taken).
    const bare = await ctx.app.request(`/api/projects/${project.id}/restore`, {
      method: 'POST',
      headers: bearer(ownerKey),
    });
    expect(bare.status).toBe(409);

    const res = await post(`/api/projects/${project.id}/restore`, { key: 'API2' });
    expect(res.status).toBe(200);
    expect(projectSchema.parse(await res.json())).toMatchObject({
      key: 'API2',
      keyAliases: ['API'],
    });
  });

  it('checks permissions for delete and restore', () => {
    const { project } = createProjectRow(ctx.db, { teamId: team.team.id, key: 'API' });
    expect(() => deleteProject(ctx.deps, actorOf(member), project.id)).toThrow(/permission/);
    expect(() => deleteProject(ctx.deps, actorOf(outsider), project.id)).toThrow(/not found/);
    deleteProject(ctx.deps, actorOf(owner), project.id);
    expect(() => restoreProject(ctx.deps, actorOf(member), project.id)).toThrow(/permission/);
    expect(() => restoreProject(ctx.deps, actorOf(outsider), project.id)).toThrow(/not found/);

    const janitors = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_TRASH'] });
    ctx.db.orm
      .insert(s.memberRole)
      .values({ teamId: team.team.id, userId: member.id, roleId: janitors.id })
      .run();
    expect(restoreProject(ctx.deps, actorOf(member), project.id).key).toBe('API');
    expect(() => restoreProject(ctx.deps, actorOf(owner), project.id)).toThrow(/not found/);
    const live = ctx.db.orm
      .select({ deletedAt: s.project.deletedAt })
      .from(s.project)
      .where(and(eq(s.project.id, project.id)))
      .get();
    expect(live?.deletedAt).toBeNull();
  });
});
