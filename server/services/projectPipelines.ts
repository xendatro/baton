import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { DEFAULT_STATUSES } from '@shared/constants';
import type { PrincipalRule } from '@shared/principals';
import {
  PROJECT_LIMITS,
  type CreatePipelineInput,
  type DeletePipelineQuery,
  type DeletePipelineResponse,
  type Pipeline,
  type PipelineListResponse,
  type ReorderPipelinesInput,
  type UpdatePipelineInput,
} from '@shared/schemas/projects';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  hasPermission,
  listProjectMemberships,
  requirePermission,
  type Membership,
} from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import {
  mergeRules,
  ruleColumns,
  rulesOf,
  seedStatusColumns,
  validateRulePrincipals,
} from './pipelines';
import { matchesRule } from './principals';
import { requireProject, type ProjectRow } from './projects';
import { moveTasksOfStatus } from './statuses';

/**
 * Pipelines (BAT-25): a project's sets of stages. Every project has one default pipeline (its
 * statuses before BAT-25, and the one a new project starts with); more can be added, each with its
 * own ordered stages and stage rules. Who-rules narrow the project's permissions per pipeline: who
 * sees it (its tasks and board), who creates tasks in it and who edits its stages. A null view or
 * create rule means everyone in the project; editing stays with `MANAGE_STATUSES` unless a manage
 * rule names more people. `MANAGE_STATUSES` (owners and administrators too) sees and manages
 * every pipeline. Agents match rules like everywhere else (role scopes), and never exceed their
 * owner's project permissions.
 */

export type PipelineRow = typeof s.pipeline.$inferSelect;
type StatusRow = typeof s.status.$inferSelect;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** The project's live pipelines, in order. */
export function pipelineRows(db: DbExecutor, projectId: string): PipelineRow[] {
  return db
    .select()
    .from(s.pipeline)
    .where(and(eq(s.pipeline.projectId, projectId), isNull(s.pipeline.deletedAt)))
    .orderBy(asc(s.pipeline.position), asc(s.pipeline.createdAt))
    .all();
}

/** The project's default pipeline (every project has one). */
export function defaultPipeline(db: DbExecutor, projectId: string): PipelineRow {
  const row = db
    .select()
    .from(s.pipeline)
    .where(and(eq(s.pipeline.projectId, projectId), eq(s.pipeline.isDefault, true)))
    .get();
  if (!row) throw errors.conflict('This project has no default pipeline');
  return row;
}

export function pipelineRow(db: DbExecutor, pipelineId: string): PipelineRow | undefined {
  return db.select().from(s.pipeline).where(eq(s.pipeline.id, pipelineId)).get();
}

/** The pipeline `statusId` is a stage of. */
export function pipelineIdOfStatus(db: DbExecutor, statusId: string): string | undefined {
  return db
    .select({ pipelineId: s.status.pipelineId })
    .from(s.status)
    .where(eq(s.status.id, statusId))
    .get()?.pipelineId;
}

/** A live pipeline of the project by id, slug or name (ignoring case). */
export function resolvePipeline(db: DbExecutor, projectId: string, ref: string): PipelineRow {
  const rows = pipelineRows(db, projectId);
  const value = ref.trim().toLowerCase();
  const found =
    rows.find((row) => row.id === ref) ??
    rows.find((row) => row.slug === value) ??
    rows.find((row) => row.name.toLowerCase() === value);
  if (!found) {
    throw errors.notFoundWith(
      `No pipeline "${ref}" in this project. Pipelines: ${rows.map((row) => row.name).join(', ')}`,
    );
  }
  return found;
}

/** The stages of a pipeline, in column order. */
export function pipelineStatuses(db: DbExecutor, pipelineId: string): StatusRow[] {
  return db
    .select()
    .from(s.status)
    .where(eq(s.status.pipelineId, pipelineId))
    .orderBy(asc(s.status.position), asc(s.status.createdAt))
    .all();
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pipeline'
  );
}

function uniqueSlug(db: DbExecutor, projectId: string, name: string, exceptId?: string): string {
  const taken = new Set(
    pipelineRows(db, projectId)
      .filter((row) => row.id !== exceptId)
      .map((row) => row.slug),
  );
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------

type RuleColumns = Pick<PipelineRow, 'projectId' | 'viewRule' | 'createRule' | 'manageRule'>;

export interface PipelinePermissions {
  view: boolean;
  create: boolean;
  manage: boolean;
}

/** What the member may do in the pipeline, on top of their project permissions. */
export function pipelinePermissions(
  db: DbExecutor,
  membership: Membership,
  row: RuleColumns,
): PipelinePermissions {
  const scope = { teamId: membership.teamId, projectId: row.projectId };
  const matches = (rule: PrincipalRule | null | undefined) =>
    rule ? matchesRule(db, scope, membership.userId, rule) : true;
  const manageAll = hasPermission(membership, 'MANAGE_STATUSES');
  const view = manageAll || matches(row.viewRule);
  return {
    view,
    create:
      view && hasPermission(membership, 'CREATE_TASKS') && (manageAll || matches(row.createRule)),
    manage: manageAll || (view && row.manageRule != null && matches(row.manageRule)),
  };
}

/**
 * Ids of the stages whose tasks `userId` can't see (their pipeline has a view rule that leaves
 * them out), across `projectIds`. Empty (one cheap query) unless some pipeline has a view rule.
 */
export function hiddenStatusIds(
  db: DbExecutor,
  userId: string,
  projectIds: readonly string[],
): Set<string> {
  const hidden = new Set<string>();
  if (projectIds.length === 0) return hidden;
  const guarded = db
    .select()
    .from(s.pipeline)
    .where(
      and(inArray(s.pipeline.projectId, [...new Set(projectIds)]), isNotNull(s.pipeline.viewRule)),
    )
    .all();
  if (guarded.length === 0) return hidden;
  const access = new Map(
    listProjectMemberships(db, userId, {
      projectIds: [...new Set(guarded.map((row) => row.projectId))],
      includeDeleted: true,
    }).map((row) => [row.projectId, row]),
  );
  const unseen = guarded.filter((row) => {
    const membership = access.get(row.projectId);
    return !membership || !pipelinePermissions(db, membership, row).view;
  });
  if (unseen.length === 0) return hidden;
  const rows = db
    .select({ id: s.status.id })
    .from(s.status)
    .where(
      inArray(
        s.status.pipelineId,
        unseen.map((row) => row.id),
      ),
    )
    .all();
  for (const row of rows) hidden.add(row.id);
  return hidden;
}

/** Can the member see tasks in `statusId`'s pipeline? */
export function canSeeStatus(db: DbExecutor, membership: Membership, statusId: string): boolean {
  const row = db
    .select({ pipeline: s.pipeline })
    .from(s.status)
    .innerJoin(s.pipeline, eq(s.pipeline.id, s.status.pipelineId))
    .where(eq(s.status.id, statusId))
    .get();
  return !row || pipelinePermissions(db, membership, row.pipeline).view;
}

/** Throws unless the member may create tasks in the pipeline (403, or 404 when it's hidden). */
export function requireCreateIn(db: DbExecutor, membership: Membership, row: PipelineRow): void {
  const can = pipelinePermissions(db, membership, row);
  if (!can.view) throw errors.notFound('Pipeline');
  if (!can.create) {
    throw errors.forbidden(`You don't have permission to create tasks in ${row.name}`);
  }
}

/** The pipeline, when the member may edit its stages. */
export function requireManageStages(
  db: DbExecutor,
  membership: Membership,
  pipelineId: string,
): PipelineRow {
  const row = pipelineRow(db, pipelineId);
  if (!row || row.deletedAt) throw errors.notFound('Pipeline');
  const can = pipelinePermissions(db, membership, row);
  if (!can.view) throw errors.notFound('Pipeline');
  if (!can.manage) throw errors.forbidden("You don't have permission to manage statuses");
  return row;
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

/** The pipelines the member can see, with their counts and what the member may do. */
export function pipelinesFor(
  db: DbExecutor,
  membership: Membership,
  projectId: string,
): Pipeline[] {
  const rows = pipelineRows(db, projectId);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const statusCounts = new Map(
    db
      .select({ id: s.status.pipelineId, n: count() })
      .from(s.status)
      .where(inArray(s.status.pipelineId, ids))
      .groupBy(s.status.pipelineId)
      .all()
      .map((row) => [row.id, row.n]),
  );
  const taskCounts = new Map(
    db
      .select({ id: s.status.pipelineId, n: count() })
      .from(s.task)
      .innerJoin(s.status, eq(s.status.id, s.task.statusId))
      .where(and(inArray(s.status.pipelineId, ids), isNull(s.task.deletedAt)))
      .groupBy(s.status.pipelineId)
      .all()
      .map((row) => [row.id, row.n]),
  );
  return rows.flatMap((row) => {
    const can = pipelinePermissions(db, membership, row);
    if (!can.view) return [];
    return [
      {
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        slug: row.slug,
        color: row.color,
        icon: row.icon,
        position: row.position,
        isDefault: row.isDefault,
        viewRule: row.viewRule ?? null,
        createRule: row.createRule ?? null,
        manageRule: row.manageRule ?? null,
        statusCount: statusCounts.get(row.id) ?? 0,
        taskCount: taskCounts.get(row.id) ?? 0,
        canCreateTasks: can.create,
        canManage: can.manage,
      },
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

export interface NewPipeline {
  name: string;
  isDefault: boolean;
  position: number;
  color?: string | null | undefined;
  icon?: string | null | undefined;
  viewRule?: PrincipalRule | null | undefined;
  createRule?: PrincipalRule | null | undefined;
  manageRule?: PrincipalRule | null | undefined;
}

/** A pipeline, without stages, inside the caller's write. */
export function insertPipeline(
  tx: Tx,
  projectId: string,
  values: NewPipeline,
  now = new Date(),
): PipelineRow {
  return tx
    .insert(s.pipeline)
    .values({
      id: newId(),
      projectId,
      name: values.name,
      slug: uniqueSlug(tx, projectId, values.name),
      color: values.color ?? null,
      icon: values.icon ?? null,
      position: values.position,
      isDefault: values.isDefault,
      viewRule: values.viewRule ?? null,
      createRule: values.createRule ?? null,
      manageRule: values.manageRule ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** A pipeline with the seeded stages (Open, the default, and Done), inside the caller's write. */
export function insertPipelineWithStages(
  tx: Tx,
  projectId: string,
  values: NewPipeline,
  now = new Date(),
): { pipeline: PipelineRow; statuses: StatusRow[] } {
  const row = insertPipeline(tx, projectId, values, now);
  const statuses = DEFAULT_STATUSES.map((seed, position) =>
    tx
      .insert(s.status)
      .values({
        projectId,
        pipelineId: row.id,
        ...seedStatusColumns(seed),
        position,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get(),
  );
  return { pipeline: row, statuses };
}

/** A new project's default pipeline and its stages. */
export function seedDefaultPipeline(tx: Tx, projectId: string, now = new Date()) {
  return insertPipelineWithStages(
    tx,
    projectId,
    { name: 'Default', isDefault: true, position: 0 },
    now,
  );
}

// ---------------------------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------------------------

function pipelineEvent(project: ProjectRow, actor: Actor, pipelineId: string) {
  // Boards, settings and pickers refresh on `status.changed`: a pipeline is a set of stages.
  return {
    type: 'status.changed' as const,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'status' as const,
    entityId: pipelineId,
    actorId: actor.userId,
  };
}

function validateRules(db: DbExecutor, project: ProjectRow, input: Partial<CreatePipelineInput>) {
  validateRulePrincipals(db, { teamId: project.teamId, projectId: project.id }, [
    input.viewRule,
    input.createRule,
    input.manageRule,
  ]);
}

export function listPipelines(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): PipelineListResponse {
  const { orm } = deps.db;
  const { membership } = requireProject(orm, actor, projectId);
  return { items: pipelinesFor(orm, membership, projectId) };
}

function pipelineById(deps: AppDeps, actor: Actor, projectId: string, id: string): Pipeline {
  const found = listPipelines(deps, actor, projectId).items.find((item) => item.id === id);
  if (!found) throw errors.notFound('Pipeline');
  return found;
}

function requireUniqueName(db: DbExecutor, projectId: string, name: string, exceptId?: string) {
  const clash = pipelineRows(db, projectId).find(
    (row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw errors.conflict(`There is already a pipeline named "${clash.name}"`);
}

/** Adds a pipeline (`MANAGE_STATUSES`) at the end, with an Open and a Done stage to start from. */
export function createPipeline(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreatePipelineInput,
): Pipeline {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_STATUSES', "You don't have permission to add pipelines");
  validateRules(orm, project, input);
  const id = deps.db.write((tx) => {
    const rows = pipelineRows(tx, projectId);
    if (rows.length >= PROJECT_LIMITS.pipelines) {
      throw errors.validation(`A project can have at most ${PROJECT_LIMITS.pipelines} pipelines`);
    }
    requireUniqueName(tx, projectId, input.name);
    const { pipeline } = insertPipelineWithStages(tx, projectId, {
      ...input,
      isDefault: false,
      position: rows.length,
    });
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'pipeline.created',
      meta: { name: project.name, key: project.key, pipeline: pipeline.name },
    });
    emitAfterCommit(tx, pipelineEvent(project, actor, pipeline.id));
    return pipeline.id;
  });
  return pipelineById(deps, actor, projectId, id);
}

/**
 * Renames a pipeline or changes its look (whoever may edit it), or its who-rules
 * (`MANAGE_STATUSES` only, so nobody widens their own access).
 */
export function updatePipeline(
  deps: AppDeps,
  actor: Actor,
  pipelineId: string,
  input: UpdatePipelineInput,
): Pipeline {
  const { orm } = deps.db;
  const existing = pipelineRow(orm, pipelineId);
  if (!existing || existing.deletedAt) throw errors.notFound('Pipeline');
  const { project, membership } = requireProject(orm, actor, existing.projectId, 'Pipeline');
  requireManageStages(orm, membership, pipelineId);
  const rulesChange =
    input.viewRule !== undefined ||
    input.createRule !== undefined ||
    input.manageRule !== undefined;
  if (rulesChange) {
    requirePermission(
      membership,
      'MANAGE_STATUSES',
      'Only people who can manage statuses change who may use a pipeline',
    );
    validateRules(orm, project, input);
  }
  deps.db.write((tx) => {
    const row = pipelineRow(tx, pipelineId) ?? existing;
    if (input.name !== undefined) requireUniqueName(tx, project.id, input.name, pipelineId);
    tx.update(s.pipeline)
      .set({
        ...(input.name !== undefined
          ? { name: input.name, slug: uniqueSlug(tx, project.id, input.name, pipelineId) }
          : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.viewRule !== undefined ? { viewRule: input.viewRule } : {}),
        ...(input.createRule !== undefined ? { createRule: input.createRule } : {}),
        ...(input.manageRule !== undefined ? { manageRule: input.manageRule } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.pipeline.id, pipelineId))
      .run();
    const changed = (field: 'viewRule' | 'createRule' | 'manageRule') =>
      input[field] !== undefined &&
      JSON.stringify(input[field] ?? null) !== JSON.stringify(row[field] ?? null);
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      action: 'pipeline.updated',
      changes: {
        ...(input.name !== undefined && input.name !== row.name
          ? { pipeline: change(row.name, input.name) }
          : {}),
        ...(changed('viewRule') ? { whoSees: change('before', 'changed') } : {}),
        ...(changed('createRule') ? { whoCreates: change('before', 'changed') } : {}),
        ...(changed('manageRule') ? { whoEdits: change('before', 'changed') } : {}),
      },
      meta: { name: project.name, key: project.key, pipeline: input.name ?? row.name },
    });
    emitAfterCommit(tx, pipelineEvent(project, actor, pipelineId));
  });
  return pipelineById(deps, actor, project.id, pipelineId);
}

/** Puts the project's pipelines in a new order (`MANAGE_STATUSES`); every pipeline once. */
export function reorderPipelines(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: ReorderPipelinesInput,
): PipelineListResponse {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(
    membership,
    'MANAGE_STATUSES',
    "You don't have permission to reorder pipelines",
  );
  deps.db.write((tx) => {
    const rows = pipelineRows(tx, projectId);
    const ids = new Set(input.pipelineIds);
    if (
      ids.size !== input.pipelineIds.length ||
      ids.size !== rows.length ||
      rows.some((row) => !ids.has(row.id))
    ) {
      throw errors.validation("List every one of the project's pipelines exactly once");
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const before = rows.map((row) => row.name).join(' → ');
    const after = input.pipelineIds.map((id) => byId.get(id)?.name ?? id).join(' → ');
    if (before === after) return;
    input.pipelineIds.forEach((id, position) => {
      if (byId.get(id)?.position !== position) {
        tx.update(s.pipeline).set({ position }).where(eq(s.pipeline.id, id)).run();
      }
    });
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'project',
      entityId: projectId,
      action: 'project.pipelines_reordered',
      changes: { pipelineOrder: change(before, after) },
      meta: { name: project.name, key: project.key },
    });
    emitAfterCommit(tx, pipelineEvent(project, actor, projectId));
  });
  return listPipelines(deps, actor, projectId);
}

/**
 * Deletes a pipeline that isn't the default (`MANAGE_STATUSES`). Its tasks move to `moveTo`, a
 * stage of another pipeline, each entering it like any move (as when a status is deleted); then
 * its stages go and the pipeline is soft-deleted.
 */
export function deletePipeline(
  deps: AppDeps,
  actor: Actor,
  pipelineId: string,
  query: DeletePipelineQuery,
): DeletePipelineResponse {
  const { orm } = deps.db;
  const existing = pipelineRow(orm, pipelineId);
  if (!existing || existing.deletedAt) throw errors.notFound('Pipeline');
  const { project, team, membership } = requireProject(orm, actor, existing.projectId, 'Pipeline');
  requirePermission(membership, 'MANAGE_STATUSES', "You don't have permission to delete pipelines");
  if (existing.isDefault) {
    throw errors.conflict('The default pipeline can’t be deleted (rename it instead)');
  }
  const movedTasks = deps.db.write((tx) => {
    const target = tx
      .select()
      .from(s.status)
      .where(and(eq(s.status.id, query.moveTo), eq(s.status.projectId, project.id)))
      .get();
    if (!target) throw errors.notFound('Status to move the tasks to');
    if (target.pipelineId === pipelineId) {
      throw errors.validation('Choose a stage of another pipeline for its tasks');
    }
    const stages = pipelineStatuses(tx, pipelineId);
    const stageIds = new Set(stages.map((row) => row.id));
    // Other stages' rules that point into this pipeline (a hand-off from its stage) let go first.
    const scope = { teamId: project.teamId, projectId: project.id };
    for (const row of tx.select().from(s.status).where(eq(s.status.projectId, project.id)).all()) {
      if (stageIds.has(row.id)) continue;
      const rules = rulesOf(row);
      if (rules.handoff.mode !== 'stage_holder' || !stageIds.has(rules.handoff.statusId ?? '')) {
        continue;
      }
      const cleaned = mergeRules(tx, scope, row.id, rules, { handoff: { mode: 'keep' } });
      tx.update(s.status).set(ruleColumns(cleaned)).where(eq(s.status.id, row.id)).run();
    }
    let moved = 0;
    for (const stage of stages) {
      moved += moveTasksOfStatus(tx, actor, { project, teamSlug: team.slug }, stage, target, {
        reason: 'pipeline_deleted',
      });
      tx.delete(s.status).where(eq(s.status.id, stage.id)).run();
    }
    tx.update(s.pipeline)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.pipeline.id, pipelineId))
      .run();
    pipelineRows(tx, project.id).forEach((row, position) => {
      if (row.position !== position) {
        tx.update(s.pipeline).set({ position }).where(eq(s.pipeline.id, row.id)).run();
      }
    });
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      action: 'pipeline.deleted',
      meta: {
        name: project.name,
        key: project.key,
        pipeline: existing.name,
        movedTo: target.name,
        movedTasks: moved,
      },
    });
    emitAfterCommit(tx, pipelineEvent(project, actor, pipelineId));
    return moved;
  });
  return { ok: true, movedTasks };
}
