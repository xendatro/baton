import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { TRASH_RETENTION_DAYS, type TrashableType } from '@shared/constants';
import { formatIssueRef, formatTaskRef } from '@shared/refs';
import type { TrashItem, TrashItemRef, TrashListResponse } from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { excerpt } from '../lib/markdown';
import { hasPermission, requireMember } from './access';
import { recordActivity } from './activity';
import { trashHandlers } from './trashHandlers';
import { getUserSummaries, getViaKeys } from './users';

/**
 * Trash (SPEC §1.12). Deleting teams, projects, issues, tasks, replies and attachments is a soft
 * delete; each module registers how to delete and restore its type in ./trashHandlers.ts. This
 * file lists a team's trash (generic over the soft-delete columns every trashable table shares)
 * and purges items after 30 days.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A soft-deleted row, before hydration. */
interface DeletedRow {
  type: TrashableType;
  id: string;
  teamId: string;
  projectId: string | null;
  title: string;
  ref: string | null;
  authorId: string | null;
  deletedAt: Date;
  deletedById: string | null;
  deletedViaKeyId: string | null;
}

/** Soft-deleted items of a team, every type except the team itself (listed per owner). */
function deletedRows(db: DbExecutor, teamId: string): DeletedRow[] {
  const deletedCols = <
    T extends
      typeof s.project | typeof s.issue | typeof s.task | typeof s.reply | typeof s.attachment,
  >(
    table: T,
  ) => ({
    deletedAt: table.deletedAt,
    deletedById: table.deletedById,
    deletedViaKeyId: table.deletedViaKeyId,
  });
  const rows: DeletedRow[] = [];
  const push = (row: Omit<DeletedRow, 'deletedAt'> & { deletedAt: Date | null }) => {
    if (row.deletedAt) rows.push({ ...row, deletedAt: row.deletedAt });
  };

  for (const project of db
    .select({
      id: s.project.id,
      name: s.project.name,
      key: s.project.key,
      authorId: s.project.createdById,
      ...deletedCols(s.project),
    })
    .from(s.project)
    .where(and(eq(s.project.teamId, teamId), isNotNull(s.project.deletedAt)))
    .all()) {
    push({
      type: 'project',
      teamId,
      projectId: project.id,
      title: project.name,
      ref: project.key,
      ...project,
    });
  }

  for (const type of ['issue', 'task'] as const) {
    const table = type === 'issue' ? s.issue : s.task;
    const format = type === 'issue' ? formatIssueRef : formatTaskRef;
    for (const item of db
      .select({
        id: table.id,
        projectId: table.projectId,
        number: table.number,
        title: table.title,
        authorId: table.authorId,
        key: s.project.key,
        ...deletedCols(table),
      })
      .from(table)
      .innerJoin(s.project, eq(s.project.id, table.projectId))
      .where(and(eq(table.teamId, teamId), isNotNull(table.deletedAt)))
      .all()) {
      push({ type, teamId, ref: format(item.key, item.number), ...item });
    }
  }

  const replies = db
    .select({
      id: s.reply.id,
      projectId: s.reply.projectId,
      parentType: s.reply.parentType,
      parentId: s.reply.parentId,
      body: s.reply.body,
      authorId: s.reply.authorId,
      key: s.project.key,
      ...deletedCols(s.reply),
    })
    .from(s.reply)
    .innerJoin(s.project, eq(s.project.id, s.reply.projectId))
    .where(and(eq(s.reply.teamId, teamId), isNotNull(s.reply.deletedAt)))
    .all();
  const parentNumbers = new Map<string, number>();
  for (const type of ['issue', 'task'] as const) {
    const ids = replies.filter((reply) => reply.parentType === type).map((reply) => reply.parentId);
    if (ids.length === 0) continue;
    const table = type === 'issue' ? s.issue : s.task;
    for (const parent of db
      .select({ id: table.id, number: table.number })
      .from(table)
      .where(inArray(table.id, ids))
      .all()) {
      parentNumbers.set(parent.id, parent.number);
    }
  }
  for (const reply of replies) {
    const number = parentNumbers.get(reply.parentId);
    push({
      type: 'reply',
      teamId,
      title: excerpt(reply.body, 80),
      ref:
        number === undefined
          ? null
          : reply.parentType === 'issue'
            ? formatIssueRef(reply.key, number)
            : formatTaskRef(reply.key, number),
      ...reply,
    });
  }

  for (const attachment of db
    .select({
      id: s.attachment.id,
      filename: s.attachment.filename,
      authorId: s.attachment.uploaderId,
      ...deletedCols(s.attachment),
    })
    .from(s.attachment)
    .where(and(eq(s.attachment.teamId, teamId), isNotNull(s.attachment.deletedAt)))
    .all()) {
    push({
      type: 'attachment',
      teamId,
      projectId: null,
      title: attachment.filename,
      ref: null,
      ...attachment,
    });
  }

  return rows.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
}

/**
 * A team's trash, most recently deleted first. Members see the items they authored;
 * `MANAGE_TRASH` sees everything.
 */
export function listTrash(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  now: Date = new Date(),
): TrashListResponse {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, teamId);
  const seeAll = hasPermission(membership, 'MANAGE_TRASH');
  const rows = deletedRows(orm, teamId).filter((row) => seeAll || row.authorId === actor.userId);
  const users = getUserSummaries(
    orm,
    rows.flatMap((row) => [row.authorId, row.deletedById]),
  );
  const keys = getViaKeys(
    orm,
    rows.map((row) => row.deletedViaKeyId),
  );
  return {
    items: rows.map((row): TrashItem => ({
      type: row.type,
      id: row.id,
      teamId: row.teamId,
      projectId: row.projectId,
      title: row.title,
      ref: row.ref,
      author: row.authorId ? (users.get(row.authorId) ?? null) : null,
      deletedBy: row.deletedById ? (users.get(row.deletedById) ?? null) : null,
      via: row.deletedViaKeyId ? (keys.get(row.deletedViaKeyId) ?? null) : null,
      deletedAt: row.deletedAt.toISOString(),
      daysLeft: Math.max(
        0,
        Math.ceil(
          (row.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS - now.getTime()) / DAY_MS,
        ),
      ),
    })),
  };
}

function handlerFor(type: TrashableType) {
  const handler = trashHandlers[type];
  if (!handler) throw errors.validation(`Items of type ${type} can't be restored yet`);
  return handler;
}

/** Restores an item from Trash through its module's handler (which checks permissions). */
export function restoreItem(deps: AppDeps, actor: Actor, ref: TrashItemRef): { ok: true } {
  handlerFor(ref.type).restore(deps, actor, ref.id);
  return { ok: true };
}

/** Moves an item to Trash through its module's handler (which checks permissions). */
export function trashItem(deps: AppDeps, actor: Actor, ref: TrashItemRef): { ok: true } {
  handlerFor(ref.type).softDelete(deps, actor, ref.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Purge (jobs/purge.ts)
// ---------------------------------------------------------------------------------------------

export interface PurgeResult {
  /** Expired items purged per type, plus orphaned replies and attachments of purged parents. */
  purged: Record<TrashableType, number>;
  /** Stored files whose rows are gone; the caller deletes them after the commit. */
  storagePaths: string[];
}

/** An expired item and where it lived (for its `<type>.purged` audit row). */
interface ExpiredItem {
  id: string;
  teamId: string | null;
  projectId: string | null;
}

/** Items of each type deleted before `cutoff`. */
function expiredItems(tx: Tx, type: TrashableType, cutoff: Date): ExpiredItem[] {
  switch (type) {
    case 'attachment':
      return tx
        .select({ id: s.attachment.id, teamId: s.attachment.teamId, projectId: sql<null>`null` })
        .from(s.attachment)
        .where(lt(s.attachment.deletedAt, cutoff))
        .all();
    case 'reply':
    case 'task':
    case 'issue': {
      const table = type === 'reply' ? s.reply : type === 'task' ? s.task : s.issue;
      return tx
        .select({ id: table.id, teamId: table.teamId, projectId: table.projectId })
        .from(table)
        .where(lt(table.deletedAt, cutoff))
        .all();
    }
    case 'project':
      return tx
        .select({ id: s.project.id, teamId: s.project.teamId, projectId: s.project.id })
        .from(s.project)
        .where(lt(s.project.deletedAt, cutoff))
        .all();
    case 'team':
      return tx
        .select({ id: s.team.id, teamId: s.team.id, projectId: sql<null>`null` })
        .from(s.team)
        .where(lt(s.team.deletedAt, cutoff))
        .all();
  }
}

const TRASH_TABLES = {
  attachment: s.attachment,
  reply: s.reply,
  task: s.task,
  issue: s.issue,
  project: s.project,
  team: s.team,
} as const;

/** Children first, so a parent's purge never hides a child's audit row. */
const PURGE_ORDER = ['attachment', 'reply', 'task', 'issue', 'project', 'team'] as const;

/**
 * Hard-deletes items that have been in Trash longer than 30 days (writing a system
 * `<type>.purged` audit row for each), then everything that hung off them: replies and
 * attachments of purged items, subscriptions, notifications and search-index rows. Returns the
 * stored files to remove, which the caller deletes after the commit.
 */
export function purgeTrash(deps: Pick<AppDeps, 'db'>, now: Date = new Date()): PurgeResult {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const cutoffMs = cutoff.getTime();
  return deps.db.write((tx) => {
    const purged: Record<TrashableType, number> = {
      team: 0,
      project: 0,
      issue: 0,
      task: 0,
      reply: 0,
      attachment: 0,
    };
    for (const type of PURGE_ORDER) {
      const expired = expiredItems(tx, type, cutoff);
      for (const item of expired) {
        recordActivity(tx, null, {
          teamId: item.teamId,
          projectId: item.projectId,
          entityType: type,
          entityId: item.id,
          action: `${type}.purged`,
        });
      }
      purged[type] = expired.length;
    }

    // Files of attachments removed directly or through a purged team's cascade.
    const storagePaths = tx
      .select({ storagePath: s.attachment.storagePath })
      .from(s.attachment)
      .where(
        sql`${s.attachment.deletedAt} < ${cutoffMs}
          or ${s.attachment.teamId} in (select id from team where deleted_at < ${cutoffMs})`,
      )
      .all()
      .map((row) => row.storagePath);

    for (const type of PURGE_ORDER) {
      const table = TRASH_TABLES[type];
      tx.delete(table).where(lt(table.deletedAt, cutoff)).run();
    }

    // Orphans: replies of purged items, attachments of purged parents.
    purged.reply += tx.run(sql`delete from reply where
      (parent_type = 'issue' and parent_id not in (select id from issue))
      or (parent_type = 'task' and parent_id not in (select id from task))`).changes;
    const orphans = tx
      .select({ id: s.attachment.id, storagePath: s.attachment.storagePath })
      .from(s.attachment)
      .where(
        sql`(${s.attachment.parentType} = 'issue' and ${s.attachment.parentId} not in (select id from issue))
          or (${s.attachment.parentType} = 'task' and ${s.attachment.parentId} not in (select id from task))
          or (${s.attachment.parentType} = 'reply' and ${s.attachment.parentId} not in (select id from reply))
          or (${s.attachment.parentType} = 'project' and ${s.attachment.parentId} not in (select id from project))`,
      )
      .all();
    for (let i = 0; i < orphans.length; i += 500) {
      const chunk = orphans.slice(i, i + 500);
      tx.delete(s.attachment)
        .where(
          inArray(
            s.attachment.id,
            chunk.map((row) => row.id),
          ),
        )
        .run();
    }
    purged.attachment += orphans.length;
    storagePaths.push(...orphans.map((row) => row.storagePath));

    // Rows that point at purged items by id, without a foreign key.
    tx.run(sql`delete from search_index where
      (entity_type = 'task' and entity_id not in (select id from task))
      or (entity_type = 'issue' and entity_id not in (select id from issue))
      or (entity_type = 'reply' and entity_id not in (select id from reply))`);
    tx.delete(s.subscription)
      .where(
        sql`(${s.subscription.entityType} = 'issue' and ${s.subscription.entityId} not in (select id from issue))
          or (${s.subscription.entityType} = 'task' and ${s.subscription.entityId} not in (select id from task))`,
      )
      .run();
    tx.delete(s.notification)
      .where(
        sql`(${s.notification.entityType} = 'issue' and ${s.notification.entityId} not in (select id from issue))
          or (${s.notification.entityType} = 'task' and ${s.notification.entityId} not in (select id from task))
          or (${s.notification.entityType} = 'reply' and ${s.notification.entityId} not in (select id from reply))
          or (${s.notification.entityType} = 'project' and ${s.notification.entityId} not in (select id from project))`,
      )
      .run();

    return { purged, storagePaths: [...new Set(storagePaths)] };
  });
}

/** Pending uploads nobody attached within 24 hours: rows to delete and files to remove. */
export function purgePendingUploads(
  deps: Pick<AppDeps, 'db'>,
  olderThan: Date,
): { count: number; storagePaths: string[] } {
  return deps.db.write((tx) => {
    const rows = tx
      .select({ id: s.attachment.id, storagePath: s.attachment.storagePath })
      .from(s.attachment)
      .where(and(eq(s.attachment.parentType, 'pending'), lt(s.attachment.createdAt, olderThan)))
      .all();
    if (rows.length > 0) {
      tx.delete(s.attachment)
        .where(
          inArray(
            s.attachment.id,
            rows.map((row) => row.id),
          ),
        )
        .run();
    }
    return { count: rows.length, storagePaths: rows.map((row) => row.storagePath) };
  });
}

/** Every stored file path still referenced by an attachment row (for the orphaned-file sweep). */
export function referencedStoragePaths(db: DbExecutor, among: readonly string[]): Set<string> {
  if (among.length === 0) return new Set();
  const found = new Set<string>();
  // Chunked to stay under SQLite's bound-parameter limit.
  for (let i = 0; i < among.length; i += 500) {
    const chunk = among.slice(i, i + 500);
    for (const row of db
      .select({ storagePath: s.attachment.storagePath })
      .from(s.attachment)
      .where(inArray(s.attachment.storagePath, chunk))
      .all()) {
      found.add(row.storagePath);
    }
  }
  return found;
}

/** Deletes expired sessions and verification codes (Better Auth leaves them in place). */
export function purgeExpiredAuthRows(
  deps: Pick<AppDeps, 'db'>,
  now: Date = new Date(),
): { sessions: number; verifications: number } {
  return deps.db.write((tx) => ({
    sessions: tx.delete(s.session).where(lt(s.session.expiresAt, now)).run().changes,
    verifications: tx.delete(s.verification).where(lt(s.verification.expiresAt, now)).run().changes,
  }));
}
