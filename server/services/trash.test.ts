import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trashListResponseSchema } from '@shared/schemas/core';
import type { Actor } from '../context';
import * as s from '../db/schema';
import { claimSweepJob, CLAIM_SWEEP_JOB } from '../jobs/claims';
import { allJobs } from '../jobs';
import {
  purgeJobs,
  removeOrphanedFiles,
  runPendingUploadPurge,
  runTrashPurge,
} from '../jobs/purge';
import { dataPaths } from '../lib/paths';
import {
  addMember,
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
import { attachmentFilePath, uploadAttachmentContent } from './attachments';
import { createReply, deleteReply } from './replies';
import { indexSearch } from './search';
import { listTrash, purgeExpiredAuthRows, restoreItem, trashItem } from './trash';

let ctx: TestContext;
let owner: UserRow;
let member: UserRow;
let team: CreatedTeam;
let project: CreatedProject;

const actorOf = (u: { id: string }): Actor => ({ userId: u.id, source: 'web', key: null });
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  ctx = createTestContext();
  owner = createUser(ctx.db, { username: 'owner' });
  member = createUser(ctx.db, { username: 'mia' });
  team = createTeam(ctx.db, { ownerId: owner.id, slug: 'acme' });
  addMember(ctx.db, { teamId: team.team.id, userId: member.id });
  project = createProject(ctx.db, { teamId: team.team.id, key: 'API' });
});

afterEach(() => {
  ctx.close();
});

function softDelete(
  table: typeof s.task | typeof s.issue,
  id: string,
  by: string,
  at = new Date(),
) {
  ctx.db.orm.update(table).set({ deletedAt: at, deletedById: by }).where(eq(table.id, id)).run();
}

describe('listTrash', () => {
  it('shows authors their own items and MANAGE_TRASH everything, with snapshots and days left', async () => {
    const task = createTask(ctx.db, {
      project: project.project,
      authorId: member.id,
      title: 'Mine',
    });
    const issue = createIssue(ctx.db, {
      project: project.project,
      authorId: owner.id,
      title: 'Theirs',
    });
    const now = new Date('2026-03-10T12:00:00Z');
    softDelete(s.task, task.id, owner.id, new Date(now.getTime() - 5 * DAY));
    softDelete(s.issue, issue.id, owner.id, new Date(now.getTime() - 1 * DAY));
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'issue',
      parentId: createIssue(ctx.db, { project: project.project }).id,
      body: 'A reply that was **removed**',
    });
    deleteReply(ctx.deps, actorOf(member), reply.id);
    const file = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'notes.txt',
      text: 'x',
    });
    trashItem(ctx.deps, actorOf(member), { type: 'attachment', id: file.id });

    const mine = listTrash(ctx.deps, actorOf(member), team.team.id, now);
    expect(mine.items.map((item) => [item.type, item.title])).toEqual(
      expect.arrayContaining([
        ['task', 'Mine'],
        ['reply', 'A reply that was removed'],
        ['attachment', 'notes.txt'],
      ]),
    );
    expect(mine.items.some((item) => item.type === 'issue')).toBe(false);
    const taskItem = mine.items.find((item) => item.type === 'task');
    expect(taskItem).toMatchObject({
      ref: 'API-1',
      author: { username: 'mia' },
      deletedBy: { username: 'owner' },
      daysLeft: 25,
    });
    expect(mine.items.find((item) => item.type === 'reply')?.ref).toBe('API#2');

    const all = listTrash(ctx.deps, actorOf(owner), team.team.id, now);
    expect(all.items.map((item) => item.type).sort()).toEqual([
      'attachment',
      'issue',
      'reply',
      'task',
    ]);
    expect(trashListResponseSchema.parse(all)).toEqual(all);

    const moderator = createUser(ctx.db);
    const role = createRole(ctx.db, { teamId: team.team.id, permissions: ['MANAGE_TRASH'] });
    addMember(ctx.db, { teamId: team.team.id, userId: moderator.id, roleIds: [role.id] });
    expect(listTrash(ctx.deps, actorOf(moderator), team.team.id, now).items).toHaveLength(4);

    const outsider = createUser(ctx.db);
    expect(() => listTrash(ctx.deps, actorOf(outsider), team.team.id)).toThrow(/not found/);
  });

  it('restores through the registered handler and refuses unknown types', () => {
    const task = createTask(ctx.db, { project: project.project });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: task.id,
      body: 'x',
    });
    trashItem(ctx.deps, actorOf(member), { type: 'reply', id: reply.id });
    expect(restoreItem(ctx.deps, actorOf(member), { type: 'reply', id: reply.id })).toEqual({
      ok: true,
    });
    expect(
      ctx.db.orm.select().from(s.reply).where(eq(s.reply.id, reply.id)).get()?.deletedAt,
    ).toBeNull();
    expect(() => restoreItem(ctx.deps, actorOf(owner), { type: 'team', id: team.team.id })).toThrow(
      /can't be restored/,
    );
  });
});

describe('purge jobs', () => {
  it('hard-deletes items after 30 days with their replies, files, index rows and audit rows', async () => {
    const now = new Date('2026-06-01T03:15:00Z');
    const old = new Date(now.getTime() - 31 * DAY);
    const recent = new Date(now.getTime() - 29 * DAY);

    const oldTask = createTask(ctx.db, { project: project.project, authorId: member.id });
    const keptTask = createTask(ctx.db, { project: project.project, authorId: member.id });
    const reply = createReply(ctx.deps, actorOf(member), {
      parentType: 'task',
      parentId: oldTask.id,
      body: 'orphan soon',
    });
    const file = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'task',
      parentId: oldTask.id,
      filename: 'a.txt',
      text: 'bytes',
    });
    ctx.db.write((tx) =>
      indexSearch(tx, {
        entityType: 'task',
        entityId: oldTask.id,
        teamId: team.team.id,
        projectId: project.project.id,
        title: oldTask.title,
        text: '',
      }),
    );
    ctx.db.orm
      .insert(s.subscription)
      .values({ userId: owner.id, entityType: 'task', entityId: oldTask.id, subscribed: true })
      .onConflictDoNothing()
      .run();
    const storagePath =
      ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, file.id)).get()
        ?.storagePath ?? '';
    softDelete(s.task, oldTask.id, member.id, old);
    softDelete(s.task, keptTask.id, member.id, recent);

    const result = runTrashPurge(ctx.deps, now);
    expect(result.purged).toMatchObject({ task: 1, reply: 1, attachment: 1 });
    expect(
      ctx.db.orm
        .select()
        .from(s.task)
        .all()
        .map((t) => t.id),
    ).toEqual([keptTask.id]);
    expect(ctx.db.orm.select().from(s.reply).where(eq(s.reply.id, reply.id)).all()).toEqual([]);
    expect(ctx.db.orm.select().from(s.attachment).all()).toEqual([]);
    expect(fs.existsSync(attachmentFilePath(ctx.dataDir, storagePath))).toBe(false);
    expect(ctx.db.orm.select().from(s.subscription).all()).toEqual([]);
    const indexed = ctx.db.orm.all<{ n: number }>(sql`select count(*) as n from search_index`);
    expect(indexed[0]?.n).toBe(0);
    const purgedRow = ctx.db.orm
      .select()
      .from(s.activity)
      .where(eq(s.activity.action, 'task.purged'))
      .get();
    expect(purgedRow).toMatchObject({ entityId: oldTask.id, source: 'system', actorId: null });
  });

  it('purges whole teams through the cascade, files included', async () => {
    const now = new Date('2026-06-01T03:15:00Z');
    const file = await uploadAttachmentContent(ctx.deps, actorOf(owner), {
      teamId: team.team.id,
      parentType: 'project',
      parentId: project.project.id,
      filename: 'readme.txt',
      text: 'x',
    });
    const storagePath =
      ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, file.id)).get()
        ?.storagePath ?? '';
    ctx.db.orm
      .update(s.team)
      .set({ deletedAt: new Date(now.getTime() - 40 * DAY) })
      .where(eq(s.team.id, team.team.id))
      .run();
    runTrashPurge(ctx.deps, now);
    expect(ctx.db.orm.select().from(s.team).all()).toEqual([]);
    expect(ctx.db.orm.select().from(s.project).all()).toEqual([]);
    expect(fs.existsSync(attachmentFilePath(ctx.dataDir, storagePath))).toBe(false);
  });

  it('purges pending uploads after 24 hours', async () => {
    const pending = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'draft.txt',
      text: 'x',
    });
    expect(runPendingUploadPurge(ctx.deps, new Date(Date.now() + 23 * 60 * 60 * 1000)).count).toBe(
      0,
    );
    expect(runPendingUploadPurge(ctx.deps, new Date(Date.now() + 25 * 60 * 60 * 1000)).count).toBe(
      1,
    );
    expect(
      ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, pending.id)).all(),
    ).toEqual([]);
  });

  it('removes upload files nothing references, after a grace period', async () => {
    const kept = await uploadAttachmentContent(ctx.deps, actorOf(member), {
      teamId: team.team.id,
      parentType: 'pending',
      filename: 'kept.txt',
      text: 'x',
    });
    const stray = path.join(dataPaths(ctx.dataDir).uploads, '2020', '01', 'stray');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, 'orphan');
    expect(removeOrphanedFiles(ctx.deps)).toBe(0); // too young
    expect(removeOrphanedFiles(ctx.deps, new Date(Date.now() + 2 * 60 * 60 * 1000))).toBe(1);
    expect(fs.existsSync(stray)).toBe(false);
    const keptPath =
      ctx.db.orm.select().from(s.attachment).where(eq(s.attachment.id, kept.id)).get()
        ?.storagePath ?? '';
    expect(fs.existsSync(attachmentFilePath(ctx.dataDir, keptPath))).toBe(true);
  });

  it('purges expired sessions and verification codes', () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    for (const [id, expiresAt] of [
      ['old', past],
      ['live', future],
    ] as const) {
      ctx.db.orm
        .insert(s.session)
        .values({ id, token: id, userId: member.id, expiresAt, updatedAt: new Date() })
        .run();
      ctx.db.orm.insert(s.verification).values({ id, identifier: id, value: 'v', expiresAt }).run();
    }
    expect(purgeExpiredAuthRows(ctx.deps)).toEqual({ sessions: 1, verifications: 1 });
    expect(
      ctx.db.orm
        .select()
        .from(s.session)
        .all()
        .map((row) => row.id),
    ).toEqual(['live']);
  });

  it('registers every purge job and the claim sweeper hook', () => {
    expect(purgeJobs.map((job) => job.name)).toEqual([
      'purge-trash',
      'purge-pending-uploads',
      'purge-expired-auth',
    ]);
    expect(allJobs.map((job) => job.name)).toEqual(
      expect.arrayContaining(purgeJobs.map((j) => j.name)),
    );
    for (const job of purgeJobs) expect(() => job.run(ctx.deps)).not.toThrow();

    const sweep = vi.fn(() => 2);
    const job = claimSweepJob(sweep);
    expect(job).toMatchObject(CLAIM_SWEEP_JOB);
    void job.run(ctx.deps);
    expect(sweep).toHaveBeenCalledWith(ctx.deps, expect.any(Date));
  });
});
