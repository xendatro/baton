import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import {
  PROJECT_LIMITS,
  type CreateStatusInput,
  type DeleteStatusQuery,
  type DeleteStatusResponse,
  type ReorderStatusesInput,
  type Status,
  type StatusListResponse,
  type UpdateStatusInput,
} from '@shared/schemas/projects';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, diffFields } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { appPaths } from '../lib/urls';
import { requirePermission, requireProjectAccess, type Membership } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { queueLinkedIssueEvents } from './linkEvents';
import { requireProject, type ProjectRow } from './projects';
import { requireSignoff } from './signoff';
import { applyStatusTransition, taskMeta, type TaskRow } from './tasks';

/**
 * Task statuses (SPEC §1.5): per project, ordered, each `open` or `done`, exactly one default for
 * new tasks. Every change needs `MANAGE_STATUSES`. A status's category decides whether its tasks
 * count as completed, so recategorizing sets or clears `task.completedAt`; deleting a status moves
 * its tasks to another one.
 */

export type StatusRow = typeof s.status.$inferSelect;

const DEFAULT_STATUS_COLOR = '#6b7280';

/** Statuses of a project in column order, with their (non-deleted) task counts. */
export function statusesOf(db: DbExecutor, projectId: string): Status[] {
  const rows = db
    .select()
    .from(s.status)
    .where(eq(s.status.projectId, projectId))
    .orderBy(asc(s.status.position), asc(s.status.createdAt))
    .all();
  const counts = new Map(
    db
      .select({ statusId: s.task.statusId, n: count() })
      .from(s.task)
      .where(and(eq(s.task.projectId, projectId), isNull(s.task.deletedAt)))
      .groupBy(s.task.statusId)
      .all()
      .map((row) => [row.statusId, row.n]),
  );
  return rows.map((row) => toStatus(row, counts.get(row.id) ?? 0));
}

function toStatus(row: StatusRow, taskCount: number): Status {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    category: row.category,
    position: row.position,
    isDefault: row.isDefault,
    taskCount,
  };
}

function statusById(db: DbExecutor, projectId: string, statusId: string): Status {
  const status = statusesOf(db, projectId).find((candidate) => candidate.id === statusId);
  if (!status) throw errors.notFound('Status');
  return status;
}

/** The statuses of a project, in column order (any member). */
export function listStatuses(deps: AppDeps, actor: Actor, projectId: string): StatusListResponse {
  const { orm } = deps.db;
  requireProject(orm, actor, projectId);
  return { items: statusesOf(orm, projectId) };
}

interface StatusAccess {
  status: StatusRow;
  project: ProjectRow;
  teamSlug: string;
  membership: Membership;
}

/** A status of a live project the actor may manage statuses in. */
function requireManageableStatus(deps: AppDeps, actor: Actor, statusId: string): StatusAccess {
  const { orm } = deps.db;
  const row = orm
    .select({ status: s.status, project: s.project, teamSlug: s.team.slug })
    .from(s.status)
    .innerJoin(s.project, eq(s.project.id, s.status.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.status.id, statusId), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Status');
  const membership = requireProjectAccess(orm, actor, row.project.id, 'Status');
  requirePermission(membership, 'MANAGE_STATUSES', "You don't have permission to manage statuses");
  return { ...row, membership };
}

/** Throws `conflict` when another status of the project has this name (case-insensitive). */
function requireUniqueName(db: DbExecutor, projectId: string, name: string, exceptId?: string) {
  const clash = db
    .select({ id: s.status.id, name: s.status.name })
    .from(s.status)
    .where(and(eq(s.status.projectId, projectId), sql`lower(${s.status.name}) = lower(${name})`))
    .all()
    .find((row) => row.id !== exceptId);
  if (clash) throw errors.conflict(`There is already a status named "${clash.name}"`);
}

function statusEvent(project: ProjectRow, actor: Actor, statusId: string) {
  return {
    type: 'status.changed' as const,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'status' as const,
    entityId: statusId,
    actorId: actor.userId,
  };
}

/** Makes `statusId` the project's only default status (inside a write). */
function setDefault(tx: Tx, projectId: string, statusId: string): void {
  tx.update(s.status)
    .set({ isDefault: false })
    .where(and(eq(s.status.projectId, projectId), eq(s.status.isDefault, true)))
    .run();
  tx.update(s.status).set({ isDefault: true }).where(eq(s.status.id, statusId)).run();
}

/**
 * Sets (`done`) or clears (`open`) the completion time of every task in the status, deleted ones
 * included so a restored task is consistent. Returns how many live tasks changed state.
 */
function syncCompletion(tx: Tx, statusId: string, category: 'open' | 'done'): number {
  const live = tx
    .select({ n: count() })
    .from(s.task)
    .where(and(eq(s.task.statusId, statusId), isNull(s.task.deletedAt)))
    .get();
  if (category === 'done') {
    tx.update(s.task)
      .set({ completedAt: new Date() })
      .where(and(eq(s.task.statusId, statusId), isNull(s.task.completedAt)))
      .run();
  } else {
    tx.update(s.task).set({ completedAt: null }).where(eq(s.task.statusId, statusId)).run();
  }
  return live?.n ?? 0;
}

/** Adds a status at the end of the column order (`MANAGE_STATUSES`). */
export function createStatus(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateStatusInput,
): Status {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_STATUSES', "You don't have permission to manage statuses");

  const id = deps.db.write((tx) => {
    const existing = tx
      .select({ position: s.status.position })
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(desc(s.status.position))
      .all();
    if (existing.length >= PROJECT_LIMITS.statuses) {
      throw errors.validation(`A project can have at most ${PROJECT_LIMITS.statuses} statuses`);
    }
    requireUniqueName(tx, projectId, input.name);
    const now = new Date();
    const row = tx
      .insert(s.status)
      .values({
        id: newId(),
        projectId,
        name: input.name,
        color: input.color ?? DEFAULT_STATUS_COLOR,
        category: input.category,
        position: (existing[0]?.position ?? -1) + 1,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (input.isDefault) setDefault(tx, projectId, row.id);
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'status',
      entityId: row.id,
      action: 'status.created',
      meta: {
        name: row.name,
        category: row.category,
        color: row.color,
        ...(input.isDefault ? { isDefault: true } : {}),
      },
    });
    emitAfterCommit(tx, statusEvent(project, actor, row.id));
    return row.id;
  });
  return statusById(orm, projectId, id);
}

/**
 * Renames, recolors or recategorizes a status, or makes it the default (`MANAGE_STATUSES`).
 * A category change marks its tasks completed (`done`) or not (`open`) and is audited once, with
 * the number of tasks affected.
 */
export function updateStatus(
  deps: AppDeps,
  actor: Actor,
  statusId: string,
  input: UpdateStatusInput,
): Status {
  const { orm } = deps.db;
  const { status, project } = requireManageableStatus(deps, actor, statusId);
  const changes = diffFields(status, input);
  if (Object.keys(changes).length === 0) return statusById(orm, project.id, statusId);

  deps.db.write((tx) => {
    if (input.name !== undefined && changes.name) {
      requireUniqueName(tx, project.id, input.name, statusId);
    }
    const previousDefault = changes.isDefault
      ? tx
          .select({ name: s.status.name })
          .from(s.status)
          .where(and(eq(s.status.projectId, project.id), eq(s.status.isDefault, true)))
          .get()
      : undefined;
    if (changes.isDefault) setDefault(tx, project.id, statusId);
    tx.update(s.status)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.status.id, statusId))
      .run();
    const tasksAffected =
      changes.category && input.category ? syncCompletion(tx, statusId, input.category) : null;
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'status',
      entityId: statusId,
      action: 'status.updated',
      changes,
      meta: {
        name: input.name ?? status.name,
        ...(previousDefault ? { previousDefault: previousDefault.name } : {}),
        ...(tasksAffected !== null ? { tasksAffected } : {}),
      },
    });
    emitAfterCommit(tx, statusEvent(project, actor, statusId));
    // Linked issues of other projects show their tasks' statuses.
    queueLinkedIssueEvents(tx, actor, liveTaskIds(tx, statusId));
  });
  return statusById(orm, project.id, statusId);
}

/** Live tasks of a status. */
function liveTaskIds(tx: Tx, statusId: string): string[] {
  return tx
    .select({ id: s.task.id })
    .from(s.task)
    .where(and(eq(s.task.statusId, statusId), isNull(s.task.deletedAt)))
    .all()
    .map((row) => row.id);
}

/** Puts the project's statuses in the given order (`MANAGE_STATUSES`); every status once. */
export function reorderStatuses(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ReorderStatusesInput,
): StatusListResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_STATUSES', "You don't have permission to manage statuses");

  deps.db.write((tx) => {
    const current = tx
      .select({ id: s.status.id, name: s.status.name, position: s.status.position })
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .orderBy(asc(s.status.position), asc(s.status.createdAt))
      .all();
    const byId = new Map(current.map((row) => [row.id, row]));
    const unique = new Set(input.statusIds);
    if (
      unique.size !== input.statusIds.length ||
      unique.size !== current.length ||
      input.statusIds.some((id) => !byId.has(id))
    ) {
      throw errors.validation("List every one of the project's statuses exactly once");
    }
    const before = current.map((row) => row.name);
    const after = input.statusIds.map((id) => byId.get(id)?.name ?? id);
    if (before.every((name, index) => name === after[index])) return;
    input.statusIds.forEach((id, position) => {
      if (byId.get(id)?.position !== position) {
        tx.update(s.status).set({ position }).where(eq(s.status.id, id)).run();
      }
    });
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'project.statuses_reordered',
      changes: { statusOrder: change(before.join(' → '), after.join(' → ')) },
      meta: { name: project.name, key: project.key },
    });
    emitAfterCommit(tx, statusEvent(project, actor, projectId));
  });
  return { items: statusesOf(orm, projectId) };
}

/**
 * Deletes a status (`MANAGE_STATUSES`), moving its tasks to the end of `moveTo`'s column. The last
 * status can't be deleted; deleting the default makes `moveTo` the default. The deletion is audited
 * on the status (with the number of tasks moved), and each moved live task like any other move:
 * a `task.moved` row (`meta.reason: 'status_deleted'`) and, when the category changes, the
 * transition's side effects (entering done resolves its `fixes` issues, notifies `task_done` and
 * releases its claim; leaving done clears `completedAt`). Tasks in Trash just follow the status.
 */
export function deleteStatus(
  deps: AppDeps,
  actor: Actor,
  statusId: string,
  query: DeleteStatusQuery,
): DeleteStatusResponse {
  const { status, project, teamSlug } = requireManageableStatus(deps, actor, statusId);
  if (query.moveTo === statusId) {
    throw errors.validation('Choose another status to move its tasks to');
  }
  if (actor.ownerId) {
    // An agent's request is only worth its owner's time when it could run (design §6).
    const moveTo = deps.db.orm
      .select({ name: s.status.name })
      .from(s.status)
      .where(and(eq(s.status.id, query.moveTo), eq(s.status.projectId, project.id)))
      .get();
    if (!moveTo) throw errors.notFound('Status to move the tasks to');
    requireSignoff(deps, actor, {
      action: 'delete_status',
      teamId: project.teamId,
      projectId: project.id,
      input: { statusId, moveTo: query.moveTo },
      summary: `delete the status “${status.name}” in ${project.key}, moving its tasks to “${moveTo.name}”`,
      url: appPaths.projectSettings(teamSlug, project.key, 'statuses'),
    });
  }

  const movedTasks = deps.db.write((tx) => {
    const statuses = tx
      .select()
      .from(s.status)
      .where(eq(s.status.projectId, project.id))
      .orderBy(asc(s.status.position), asc(s.status.createdAt))
      .all();
    if (statuses.length <= 1) throw errors.conflict("A project's last status can't be deleted");
    const target = statuses.find((row) => row.id === query.moveTo);
    if (!target) throw errors.notFound('Status to move the tasks to');
    // Re-read under the write lock: the category may have changed since the access check.
    const source = statuses.find((row) => row.id === statusId) ?? status;

    const tasks = tx
      .select()
      .from(s.task)
      .where(eq(s.task.statusId, statusId))
      .orderBy(asc(s.task.position), asc(s.task.number))
      .all();
    const last = tx
      .select({ position: s.task.position })
      .from(s.task)
      .where(eq(s.task.statusId, target.id))
      .orderBy(desc(s.task.position))
      .get();
    const positions = appendPositions(last?.position ?? null, tasks.length);
    const now = new Date();
    for (const [index, task] of tasks.entries()) {
      const patch: Partial<TaskRow> = {
        statusId: target.id,
        ...(positions[index] ? { position: positions[index] } : {}),
        completedAt: target.category === 'done' ? (task.completedAt ?? now) : null,
      };
      if (task.deletedAt) {
        tx.update(s.task).set(patch).where(eq(s.task.id, task.id)).run();
        continue;
      }
      const transition = applyStatusTransition(
        tx,
        actor,
        { task, projectKey: project.key, teamSlug },
        source,
        target,
        now,
        new Set<string>(),
      );
      tx.update(s.task)
        .set({ ...patch, ...transition.patch, updatedAt: now })
        .where(eq(s.task.id, task.id))
        .run();
      recordActivity(tx, actor, {
        teamId: task.teamId,
        projectId: task.projectId,
        entityType: 'task',
        entityId: task.id,
        action: 'task.moved',
        changes: { status: change(source.name, target.name) },
        meta: { ...taskMeta(task, project.key), status: target.name, reason: 'status_deleted' },
      });
      transition.recordRelease();
    }

    tx.delete(s.status).where(eq(s.status.id, statusId)).run();
    if (source.isDefault) setDefault(tx, project.id, target.id);
    statuses
      .filter((row) => row.id !== statusId)
      .forEach((row, position) => {
        if (row.position !== position) {
          tx.update(s.status).set({ position }).where(eq(s.status.id, row.id)).run();
        }
      });

    const moved = tasks.filter((task) => task.deletedAt === null);
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'status',
      entityId: statusId,
      action: 'status.deleted',
      meta: {
        name: source.name,
        category: source.category,
        movedTo: target.name,
        movedTasks: moved.length,
        ...(source.isDefault ? { newDefault: target.name } : {}),
      },
    });
    // The project's boards and lists refresh on `status.changed`; linked issues of other
    // projects show the moved tasks' statuses.
    emitAfterCommit(tx, statusEvent(project, actor, statusId));
    queueLinkedIssueEvents(
      tx,
      actor,
      moved.map((task) => task.id),
    );
    return moved.length;
  });
  return { ok: true, movedTasks };
}

/**
 * `count` fractional-index keys after `after` (the end of a board column). Falls back to a fresh
 * sequence when `after` is not a valid key (rows written by hand).
 */
function appendPositions(after: string | null, n: number): string[] {
  if (n === 0) return [];
  try {
    return generateNKeysBetween(after, null, n);
  } catch {
    return generateNKeysBetween(null, null, n);
  }
}
