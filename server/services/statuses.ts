import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { DEFAULT_STATUS_ICON } from '@shared/constants';
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
import { requireProjectAccess, type Membership } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { queueLinkedIssueEvents } from './linkEvents';
import { enterStage, mergeRules, ruleChanges, ruleColumns, rulesOf } from './pipelines';
import {
  defaultPipeline,
  hiddenStatusIds,
  pipelinePermissions,
  pipelineRow,
  requireManageStages,
  resolvePipeline,
} from './projectPipelines';
import { requireProject, type ProjectRow } from './projects';
import { requireSignoff } from './signoff';
import { setStageAssignees, stageRoleIds, stageUserIds } from './taskAssignees';
import { applyStatusTransition, taskMeta, type TaskRow } from './tasks';

/**
 * Task statuses (SPEC §1.5): per project, ordered, exactly one default for new tasks. They are
 * stages with no hidden category: what entering one does, whether its tasks block their
 * dependents or can be claimed, and who is assigned there are its stage rules (pipelines). Every
 * change needs `MANAGE_STATUSES`. Changing `blocksDependents` sets or clears `task.completedAt` of
 * its tasks; deleting a status moves its tasks to another one.
 */

export type StatusRow = typeof s.status.$inferSelect;

const DEFAULT_STATUS_COLOR = '#6b7280';

/**
 * Statuses of a project with their (non-deleted) task counts: pipeline by pipeline (BAT-25), each
 * in column order.
 */
export function statusesOf(db: DbExecutor, projectId: string): Status[] {
  const rows = db
    .select({ status: s.status })
    .from(s.status)
    .innerJoin(s.pipeline, eq(s.pipeline.id, s.status.pipelineId))
    .where(eq(s.status.projectId, projectId))
    .orderBy(
      asc(s.pipeline.position),
      asc(s.pipeline.createdAt),
      asc(s.status.position),
      asc(s.status.createdAt),
    )
    .all()
    .map((row) => row.status);
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
    pipelineId: row.pipelineId,
    name: row.name,
    color: row.color,
    icon: row.icon,
    position: row.position,
    isDefault: row.isDefault,
    taskCount,
    rules: rulesOf(row),
  };
}

function statusById(db: DbExecutor, projectId: string, statusId: string): Status {
  const status = statusesOf(db, projectId).find((candidate) => candidate.id === statusId);
  if (!status) throw errors.notFound('Status');
  return status;
}

/**
 * The statuses of a project the actor can see, pipeline by pipeline in column order, or those of
 * one pipeline (id, slug or name).
 */
export function listStatuses(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  pipelineRef?: string,
): StatusListResponse {
  const { orm } = deps.db;
  const { membership } = requireProject(orm, actor, projectId);
  const pipeline = pipelineRef ? resolvePipeline(orm, projectId, pipelineRef) : null;
  const hidden = hiddenStatusIds(orm, actor.userId, [projectId]);
  if (pipeline && !pipelinePermissions(orm, membership, pipeline).view) {
    throw errors.notFound('Pipeline');
  }
  return {
    items: statusesOf(orm, projectId).filter(
      (status) => !hidden.has(status.id) && (!pipeline || status.pipelineId === pipeline.id),
    ),
  };
}

interface StatusAccess {
  status: StatusRow;
  project: ProjectRow;
  teamSlug: string;
  membership: Membership;
}

/** A status of a live project, when the actor may edit its pipeline's stages. */
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
  requireManageStages(orm, membership, row.status.pipelineId);
  return { ...row, membership };
}

/** Throws `conflict` when another stage of the pipeline has this name (case-insensitive). */
function requireUniqueName(db: DbExecutor, pipelineId: string, name: string, exceptId?: string) {
  const clash = db
    .select({ id: s.status.id, name: s.status.name })
    .from(s.status)
    .where(and(eq(s.status.pipelineId, pipelineId), sql`lower(${s.status.name}) = lower(${name})`))
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

/** Makes `statusId` its pipeline's only default status (inside a write). */
function setDefault(tx: Tx, pipelineId: string, statusId: string): void {
  tx.update(s.status)
    .set({ isDefault: false })
    .where(and(eq(s.status.pipelineId, pipelineId), eq(s.status.isDefault, true)))
    .run();
  tx.update(s.status).set({ isDefault: true }).where(eq(s.status.id, statusId)).run();
}

/**
 * Sets (the stage no longer blocks its dependents) or clears (it does) the completion time of every
 * task in the status, deleted ones included so a restored task is consistent. Returns how many
 * live tasks changed state.
 */
export function syncCompletion(tx: Tx, statusId: string, blocksDependents: boolean): number {
  const live = tx
    .select({ n: count() })
    .from(s.task)
    .where(and(eq(s.task.statusId, statusId), isNull(s.task.deletedAt)))
    .get();
  if (!blocksDependents) {
    tx.update(s.task)
      .set({ completedAt: new Date() })
      .where(and(eq(s.task.statusId, statusId), isNull(s.task.completedAt)))
      .run();
  } else {
    tx.update(s.task).set({ completedAt: null }).where(eq(s.task.statusId, statusId)).run();
  }
  return live?.n ?? 0;
}

/**
 * Adds a status at the end of a pipeline's columns (the default pipeline unless `pipelineId`
 * says), for whoever may edit that pipeline's stages.
 */
export function createStatus(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateStatusInput,
): Status {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  const pipeline = input.pipelineId
    ? pipelineRow(orm, input.pipelineId)
    : defaultPipeline(orm, projectId);
  if (!pipeline || pipeline.projectId !== projectId || pipeline.deletedAt) {
    throw errors.notFound('Pipeline');
  }
  requireManageStages(orm, membership, pipeline.id);

  const id = deps.db.write((tx) => {
    const all = tx
      .select({ n: count() })
      .from(s.status)
      .where(eq(s.status.projectId, projectId))
      .get();
    if ((all?.n ?? 0) >= PROJECT_LIMITS.statuses) {
      throw errors.validation(`A project can have at most ${PROJECT_LIMITS.statuses} statuses`);
    }
    const existing = tx
      .select({ position: s.status.position })
      .from(s.status)
      .where(eq(s.status.pipelineId, pipeline.id))
      .orderBy(desc(s.status.position))
      .all();
    requireUniqueName(tx, pipeline.id, input.name);
    const now = new Date();
    const row = tx
      .insert(s.status)
      .values({
        id: newId(),
        projectId,
        pipelineId: pipeline.id,
        name: input.name,
        color: input.color ?? DEFAULT_STATUS_COLOR,
        icon: input.icon ?? DEFAULT_STATUS_ICON,
        position: (existing[0]?.position ?? -1) + 1,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (input.isDefault) setDefault(tx, pipeline.id, row.id);
    if (input.rules) {
      const rules = mergeRules(
        tx,
        { teamId: project.teamId, projectId },
        row.id,
        rulesOf(row),
        input.rules,
      );
      tx.update(s.status).set(ruleColumns(rules)).where(eq(s.status.id, row.id)).run();
    }
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'status',
      entityId: row.id,
      action: 'status.created',
      meta: {
        name: row.name,
        color: row.color,
        icon: row.icon,
        ...(input.isDefault ? { isDefault: true } : {}),
        ...(pipeline.isDefault ? {} : { pipeline: pipeline.name }),
      },
    });
    emitAfterCommit(tx, statusEvent(project, actor, row.id));
    return row.id;
  });
  return statusById(orm, projectId, id);
}

/**
 * Renames a status, changes its color, icon or rules, or makes it the default
 * (`MANAGE_STATUSES`). `category` (legacy) is ignored. Changing `blocksDependents` marks its tasks
 * completed or not and is audited once, with the number of tasks affected.
 */
export function updateStatus(
  deps: AppDeps,
  actor: Actor,
  statusId: string,
  input: UpdateStatusInput,
): Status {
  const { orm } = deps.db;
  const { status, project } = requireManageableStatus(deps, actor, statusId);
  const { rules: rulesPatch, category: _legacy, ...fields } = input;
  const changes = diffFields(status, fields);
  const scope = { teamId: project.teamId, projectId: project.id };
  // Pipeline rules (design §5): validated against the project, audited in words.
  const rules = rulesPatch ? mergeRules(orm, scope, statusId, rulesOf(status), rulesPatch) : null;
  if (rules) Object.assign(changes, ruleChanges(orm, rulesOf(status), rules));
  if (Object.keys(changes).length === 0) return statusById(orm, project.id, statusId);

  deps.db.write((tx) => {
    if (input.name !== undefined && changes.name) {
      requireUniqueName(tx, status.pipelineId, input.name, statusId);
    }
    const previousDefault = changes.isDefault
      ? tx
          .select({ name: s.status.name })
          .from(s.status)
          .where(and(eq(s.status.pipelineId, status.pipelineId), eq(s.status.isDefault, true)))
          .get()
      : undefined;
    if (changes.isDefault) setDefault(tx, status.pipelineId, statusId);
    tx.update(s.status)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(rules ? ruleColumns(rules) : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.status.id, statusId))
      .run();
    const tasksAffected =
      rules && changes.blocksDependents
        ? syncCompletion(tx, statusId, rules.blocksDependents)
        : null;
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

/**
 * Puts a pipeline's stages in the given order (whoever may edit its stages): every stage of that
 * pipeline once. The pipeline is the first status's.
 */
export function reorderStatuses(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ReorderStatusesInput,
): StatusListResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  const first = orm
    .select({ pipelineId: s.status.pipelineId })
    .from(s.status)
    .where(and(eq(s.status.id, input.statusIds[0] ?? ''), eq(s.status.projectId, projectId)))
    .get();
  if (!first) throw errors.validation("List every one of the pipeline's statuses exactly once");
  requireManageStages(orm, membership, first.pipelineId);

  deps.db.write((tx) => {
    const current = tx
      .select({ id: s.status.id, name: s.status.name, position: s.status.position })
      .from(s.status)
      .where(eq(s.status.pipelineId, first.pipelineId))
      .orderBy(asc(s.status.position), asc(s.status.createdAt))
      .all();
    const byId = new Map(current.map((row) => [row.id, row]));
    const unique = new Set(input.statusIds);
    if (
      unique.size !== input.statusIds.length ||
      unique.size !== current.length ||
      input.statusIds.some((id) => !byId.has(id))
    ) {
      throw errors.validation("List every one of the pipeline's statuses exactly once");
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
 * on the status (with the number of tasks moved), and each moved live task enters `moveTo` like
 * any other move: a `task.moved` row (`meta.reason: 'status_deleted'`), `moveTo`'s on-enter
 * effects and hand-off (no exit rules are checked). Tasks in Trash just follow the status, taking
 * their assignees along. The deleted stage's assignment history goes with it.
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
      .where(eq(s.status.pipelineId, status.pipelineId))
      .orderBy(asc(s.status.position), asc(s.status.createdAt))
      .all();
    if (statuses.length <= 1) throw errors.conflict("A pipeline's last status can't be deleted");
    // Its tasks may go to a stage of another pipeline too (BAT-25).
    const target = tx
      .select()
      .from(s.status)
      .where(and(eq(s.status.id, query.moveTo), eq(s.status.projectId, project.id)))
      .get();
    if (!target) throw errors.notFound('Status to move the tasks to');
    // Re-read under the write lock: the rules may have changed since the access check.
    const source = statuses.find((row) => row.id === statusId) ?? status;

    const movedCount = moveTasksOfStatus(tx, actor, { project, teamSlug }, source, target, {
      reason: 'status_deleted',
    });

    tx.delete(s.status).where(eq(s.status.id, statusId)).run();
    const remaining = statuses.filter((row) => row.id !== statusId);
    const newDefault = source.isDefault
      ? target.pipelineId === source.pipelineId
        ? target
        : remaining[0]
      : undefined;
    if (newDefault) setDefault(tx, source.pipelineId, newDefault.id);
    remaining.forEach((row, position) => {
      if (row.position !== position) {
        tx.update(s.status).set({ position }).where(eq(s.status.id, row.id)).run();
      }
    });

    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'status',
      entityId: statusId,
      action: 'status.deleted',
      meta: {
        name: source.name,
        movedTo: target.name,
        movedTasks: movedCount,
        ...(newDefault ? { newDefault: newDefault.name } : {}),
      },
    });
    // The project's boards and lists refresh on `status.changed`.
    emitAfterCommit(tx, statusEvent(project, actor, statusId));
    return movedCount;
  });
  return { ok: true, movedTasks };
}

/**
 * Moves every task of `source` to the end of `target`'s column (inside a write) when `source` is
 * about to go (its status or pipeline is deleted). Each live task enters `target` like any other
 * move: a `task.moved` row (`meta.reason`), `target`'s on-enter effects and hand-off (no exit
 * rules are checked). Tasks in Trash just follow, taking their assignees along. Returns how many
 * live tasks moved; linked issues of other projects are told.
 */
export function moveTasksOfStatus(
  tx: Tx,
  actor: Actor,
  context: { project: ProjectRow; teamSlug: string },
  source: StatusRow,
  target: StatusRow,
  options: { reason: string },
): number {
  const { project, teamSlug } = context;
  const statusId = source.id;
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
      completedAt: target.blocksDependents ? null : (task.completedAt ?? now),
    };
    if (task.deletedAt) {
      tx.update(s.task).set(patch).where(eq(s.task.id, task.id)).run();
      // Its assignees go with it (unless it already has some in `moveTo`).
      if (
        stageUserIds(tx, task.id, target.id).length === 0 &&
        stageRoleIds(tx, task.id, target.id).length === 0
      ) {
        setStageAssignees(
          tx,
          task.id,
          target.id,
          stageUserIds(tx, task.id, source.id),
          stageRoleIds(tx, task.id, source.id),
        );
      }
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
      meta: { ...taskMeta(task, project.key), status: target.name, reason: options.reason },
    });
    transition.recordRelease();
    // The tasks enter `target`: its hand-off and notify rules apply (no exit rules are checked).
    const moved = tx.select().from(s.task).where(eq(s.task.id, task.id)).get();
    if (moved) {
      enterStage(
        tx,
        actor,
        { task: moved, projectKey: project.key, teamSlug },
        source,
        target,
        now,
      );
    }
  }

  const moved = tasks.filter((task) => task.deletedAt === null);
  queueLinkedIssueEvents(
    tx,
    actor,
    moved.map((task) => task.id),
  );
  return moved.length;
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
