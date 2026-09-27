import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_DIFFICULTIES, DEFAULT_LABEL_COLOR } from '@shared/constants';
import {
  PROJECT_LIMITS,
  type CreateDifficultyInput,
  type DeleteDifficultyResponse,
  type Difficulty,
  type DifficultyListResponse,
  type ReorderDifficultiesInput,
  type UpdateDifficultyInput,
} from '@shared/schemas/projects';
import type { TaskDifficultySummary } from '@shared/schemas/tasks';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { diffFields, hasChanges } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { requirePermission, requireProjectAccess } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { requireProject, type ProjectRow } from './projects';

/**
 * Difficulty levels (BAT-24): per project, ordered easiest first and managed like labels
 * (`MANAGE_LABELS`). A task has one level or none; each person maps levels to the models their
 * agent runs (the desktop app). Every new project starts with Easy / Normal / Hard.
 */

export type DifficultyRow = typeof s.difficulty.$inferSelect;

/** The seeded levels of a new project, inside the caller's write. */
export function seedDifficulties(tx: Tx, projectId: string): void {
  const now = new Date();
  tx.insert(s.difficulty)
    .values(
      DEFAULT_DIFFICULTIES.map((level, position) => ({
        id: newId(),
        projectId,
        name: level.name,
        color: level.color,
        position,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run();
}

/** The project's levels, easiest first, with how many live tasks have each. */
export function difficultiesOf(db: DbExecutor, projectId: string): Difficulty[] {
  const rows = db
    .select()
    .from(s.difficulty)
    .where(eq(s.difficulty.projectId, projectId))
    .orderBy(asc(s.difficulty.position), asc(s.difficulty.id))
    .all();
  const counts = new Map(
    db
      .select({ id: s.task.difficultyId, n: count() })
      .from(s.task)
      .where(and(eq(s.task.projectId, projectId), isNull(s.task.deletedAt)))
      .groupBy(s.task.difficultyId)
      .all()
      .map((row) => [row.id, row.n]),
  );
  return rows.map((row, position) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    position,
    taskCount: counts.get(row.id) ?? 0,
  }));
}

/** Levels by id, as tasks show them (positions renumbered from 0). */
export function difficultySummaries(
  db: DbExecutor,
  projectIds: readonly string[],
): Map<string, TaskDifficultySummary> {
  const summaries = new Map<string, TaskDifficultySummary>();
  for (const projectId of new Set(projectIds)) {
    db.select()
      .from(s.difficulty)
      .where(eq(s.difficulty.projectId, projectId))
      .orderBy(asc(s.difficulty.position), asc(s.difficulty.id))
      .all()
      .forEach((row, position) =>
        summaries.set(row.id, { id: row.id, name: row.name, color: row.color, position }),
      );
  }
  return summaries;
}

/**
 * The level `idOrName` of the project (an id, or a name ignoring case), for task writes and MCP
 * tools; throws `validation_failed` naming the levels there are.
 */
export function resolveDifficulty(
  db: DbExecutor,
  projectId: string,
  idOrName: string,
): DifficultyRow {
  const rows = db.select().from(s.difficulty).where(eq(s.difficulty.projectId, projectId)).all();
  const found =
    rows.find((row) => row.id === idOrName) ??
    rows.find((row) => row.name.toLowerCase() === idOrName.trim().toLowerCase());
  if (!found) {
    const names = rows
      .sort((a, b) => a.position - b.position)
      .map((row) => row.name)
      .join(', ');
    throw errors.validation(
      names
        ? `Difficulty must be one of this project's levels: ${names}`
        : 'This project has no difficulty levels',
    );
  }
  return found;
}

function byId(db: DbExecutor, projectId: string, id: string): Difficulty {
  const level = difficultiesOf(db, projectId).find((candidate) => candidate.id === id);
  if (!level) throw errors.notFound('Difficulty level');
  return level;
}

function difficultyEvent(project: ProjectRow, actor: Actor, id: string) {
  return {
    type: 'difficulty.changed' as const,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'difficulty' as const,
    entityId: id,
    actorId: actor.userId,
  };
}

function requireManage(deps: AppDeps, actor: Actor, projectId: string) {
  const access = requireProject(deps.db.orm, actor, projectId);
  requirePermission(
    access.membership,
    'MANAGE_LABELS',
    "You don't have permission to manage difficulty levels",
  );
  return access;
}

/** A level of a live project the actor may manage levels in. */
function requireManageable(deps: AppDeps, actor: Actor, id: string) {
  const { orm } = deps.db;
  const row = orm
    .select({ difficulty: s.difficulty, project: s.project })
    .from(s.difficulty)
    .innerJoin(s.project, eq(s.project.id, s.difficulty.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.difficulty.id, id), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Difficulty level');
  const membership = requireProjectAccess(orm, actor, row.project.id, 'Difficulty level');
  requirePermission(
    membership,
    'MANAGE_LABELS',
    "You don't have permission to manage difficulty levels",
  );
  return row;
}

function requireUniqueName(db: DbExecutor, projectId: string, name: string, exceptId?: string) {
  const clash = db
    .select({ id: s.difficulty.id, name: s.difficulty.name })
    .from(s.difficulty)
    .where(
      and(eq(s.difficulty.projectId, projectId), sql`lower(${s.difficulty.name}) = lower(${name})`),
    )
    .all()
    .find((row) => row.id !== exceptId);
  if (clash) throw errors.conflict(`There is already a level named "${clash.name}"`);
}

/** The project's levels (any member). */
export function listDifficulties(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): DifficultyListResponse {
  const { orm } = deps.db;
  requireProject(orm, actor, projectId);
  return { items: difficultiesOf(orm, projectId) };
}

/** Adds a level after the hardest one (`MANAGE_LABELS`). */
export function createDifficulty(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateDifficultyInput,
): Difficulty {
  const { project } = requireManage(deps, actor, projectId);
  const id = deps.db.write((tx) => {
    const existing = tx
      .select({ n: count(), last: sql<number | null>`max(${s.difficulty.position})` })
      .from(s.difficulty)
      .where(eq(s.difficulty.projectId, projectId))
      .get();
    if ((existing?.n ?? 0) >= PROJECT_LIMITS.difficulties) {
      throw errors.validation(
        `A project can have at most ${PROJECT_LIMITS.difficulties} difficulty levels`,
      );
    }
    requireUniqueName(tx, projectId, input.name);
    const now = new Date();
    const row = tx
      .insert(s.difficulty)
      .values({
        id: newId(),
        projectId,
        name: input.name,
        color: input.color ?? DEFAULT_LABEL_COLOR,
        position: (existing?.last ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'difficulty',
      entityId: row.id,
      action: 'difficulty.created',
      meta: { name: row.name, color: row.color },
    });
    emitAfterCommit(tx, difficultyEvent(project, actor, row.id));
    return row.id;
  });
  return byId(deps.db.orm, projectId, id);
}

/** Renames or recolors a level (`MANAGE_LABELS`). */
export function updateDifficulty(
  deps: AppDeps,
  actor: Actor,
  id: string,
  input: UpdateDifficultyInput,
): Difficulty {
  const { difficulty, project } = requireManageable(deps, actor, id);
  const changes = diffFields(difficulty, input);
  if (!hasChanges(changes)) return byId(deps.db.orm, project.id, id);
  deps.db.write((tx) => {
    if (input.name !== undefined) requireUniqueName(tx, project.id, input.name, id);
    tx.update(s.difficulty)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.difficulty.id, id))
      .run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'difficulty',
      entityId: id,
      action: 'difficulty.updated',
      changes,
      meta: { name: input.name ?? difficulty.name },
    });
    emitAfterCommit(tx, difficultyEvent(project, actor, id));
  });
  return byId(deps.db.orm, project.id, id);
}

/** Puts the levels in a new order, easiest first (`MANAGE_LABELS`). */
export function reorderDifficulties(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ReorderDifficultiesInput,
): DifficultyListResponse {
  const { project } = requireManage(deps, actor, projectId);
  deps.db.write((tx) => {
    const current = difficultiesOf(tx, projectId);
    const ids = new Set(input.difficultyIds);
    if (ids.size !== current.length || current.some((level) => !ids.has(level.id))) {
      throw errors.validation('List every difficulty level of the project exactly once');
    }
    input.difficultyIds.forEach((levelId, position) =>
      tx
        .update(s.difficulty)
        .set({ position, updatedAt: new Date() })
        .where(eq(s.difficulty.id, levelId))
        .run(),
    );
    const names = (list: readonly string[]) =>
      list.map((levelId) => current.find((level) => level.id === levelId)?.name ?? '');
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'difficulty.reordered',
      changes: {
        difficulties: {
          from: names(current.map((level) => level.id)),
          to: names(input.difficultyIds),
        },
      },
      meta: { name: project.name, key: project.key },
    });
    emitAfterCommit(tx, difficultyEvent(project, actor, projectId));
  });
  return { items: difficultiesOf(deps.db.orm, projectId) };
}

/** Deletes a level (`MANAGE_LABELS`); its tasks are left without one. */
export function deleteDifficulty(
  deps: AppDeps,
  actor: Actor,
  id: string,
): DeleteDifficultyResponse {
  const { difficulty, project } = requireManageable(deps, actor, id);
  const clearedTasks = deps.db.write((tx) => {
    const cleared = tx
      .update(s.task)
      .set({ difficultyId: null })
      .where(eq(s.task.difficultyId, id))
      .returning({ id: s.task.id })
      .all().length;
    tx.delete(s.difficulty).where(eq(s.difficulty.id, id)).run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'difficulty',
      entityId: id,
      action: 'difficulty.deleted',
      meta: { name: difficulty.name, color: difficulty.color, clearedTasks: cleared },
    });
    emitAfterCommit(tx, difficultyEvent(project, actor, id));
    return cleared;
  });
  return { ok: true, clearedTasks };
}
