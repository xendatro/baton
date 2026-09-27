import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_LABEL_COLOR } from '@shared/constants';
import {
  PROJECT_LIMITS,
  type CreateLabelInput,
  type DeleteLabelResponse,
  type Label,
  type LabelListResponse,
  type UpdateLabelInput,
} from '@shared/schemas/projects';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { diffFields, hasChanges } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { appPaths } from '../lib/urls';
import { requirePermission, requireProjectAccess } from './access';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { requireProject, type ProjectRow } from './projects';
import { requireSignoff } from './signoff';

/**
 * Labels (SPEC §1.6): per project, shared by its issues and tasks. Names are unique within a
 * project, ignoring case. Every change needs `MANAGE_LABELS`; deleting a label removes it from
 * every issue and task that carried it.
 */

export type LabelRow = typeof s.label.$inferSelect;

/** Usage of each label on live issues and tasks, keyed by label id. */
function labelUsage(
  db: DbExecutor,
  projectId: string,
): Map<string, { issueCount: number; taskCount: number }> {
  const usage = new Map<string, { issueCount: number; taskCount: number }>();
  const entry = (labelId: string) => {
    let value = usage.get(labelId);
    if (!value) {
      value = { issueCount: 0, taskCount: 0 };
      usage.set(labelId, value);
    }
    return value;
  };
  for (const row of db
    .select({ labelId: s.issueLabel.labelId, n: count() })
    .from(s.issueLabel)
    .innerJoin(s.issue, eq(s.issue.id, s.issueLabel.issueId))
    .where(and(eq(s.issue.projectId, projectId), isNull(s.issue.deletedAt)))
    .groupBy(s.issueLabel.labelId)
    .all()) {
    entry(row.labelId).issueCount = row.n;
  }
  for (const row of db
    .select({ labelId: s.taskLabel.labelId, n: count() })
    .from(s.taskLabel)
    .innerJoin(s.task, eq(s.task.id, s.taskLabel.taskId))
    .where(and(eq(s.task.projectId, projectId), isNull(s.task.deletedAt)))
    .groupBy(s.taskLabel.labelId)
    .all()) {
    entry(row.labelId).taskCount = row.n;
  }
  return usage;
}

/** Labels of a project, alphabetical (ignoring case), with their usage counts. */
export function labelsOf(db: DbExecutor, projectId: string): Label[] {
  const rows = db
    .select()
    .from(s.label)
    .where(eq(s.label.projectId, projectId))
    .orderBy(asc(sql`lower(${s.label.name})`), asc(s.label.id))
    .all();
  const usage = labelUsage(db, projectId);
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    color: row.color,
    description: row.description,
    issueCount: usage.get(row.id)?.issueCount ?? 0,
    taskCount: usage.get(row.id)?.taskCount ?? 0,
  }));
}

function labelById(db: DbExecutor, projectId: string, labelId: string): Label {
  const label = labelsOf(db, projectId).find((candidate) => candidate.id === labelId);
  if (!label) throw errors.notFound('Label');
  return label;
}

/** The labels of a project with usage counts (any member). */
export function listLabels(deps: AppDeps, actor: Actor, projectId: string): LabelListResponse {
  const { orm } = deps.db;
  requireProject(orm, actor, projectId);
  return { items: labelsOf(orm, projectId) };
}

/** A label of a live project the actor may manage labels in. */
function requireManageableLabel(deps: AppDeps, actor: Actor, labelId: string) {
  const { orm } = deps.db;
  const row = orm
    .select({ label: s.label, project: s.project, teamSlug: s.team.slug })
    .from(s.label)
    .innerJoin(s.project, eq(s.project.id, s.label.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.label.id, labelId), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (!row) throw errors.notFound('Label');
  const membership = requireProjectAccess(orm, actor, row.project.id, 'Label');
  requirePermission(membership, 'MANAGE_LABELS', "You don't have permission to manage labels");
  return row;
}

/** Throws `conflict` when another label of the project has this name (case-insensitive). */
function requireUniqueName(db: DbExecutor, projectId: string, name: string, exceptId?: string) {
  const clash = db
    .select({ id: s.label.id, name: s.label.name })
    .from(s.label)
    .where(and(eq(s.label.projectId, projectId), sql`lower(${s.label.name}) = lower(${name})`))
    .all()
    .find((row) => row.id !== exceptId);
  if (clash) throw errors.conflict(`There is already a label named "${clash.name}"`);
}

function labelEvent(project: ProjectRow, actor: Actor, labelId: string) {
  return {
    type: 'label.changed' as const,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'label' as const,
    entityId: labelId,
    actorId: actor.userId,
  };
}

/** Creates a label (`MANAGE_LABELS`). */
export function createLabel(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: CreateLabelInput,
): Label {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_LABELS', "You don't have permission to manage labels");

  const id = deps.db.write((tx) => {
    const existing = tx
      .select({ n: count() })
      .from(s.label)
      .where(eq(s.label.projectId, projectId))
      .get();
    if ((existing?.n ?? 0) >= PROJECT_LIMITS.labels) {
      throw errors.validation(`A project can have at most ${PROJECT_LIMITS.labels} labels`);
    }
    requireUniqueName(tx, projectId, input.name);
    const now = new Date();
    const row = tx
      .insert(s.label)
      .values({
        id: newId(),
        projectId,
        name: input.name,
        color: input.color ?? DEFAULT_LABEL_COLOR,
        description: input.description ?? '',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId,
      entityType: 'label',
      entityId: row.id,
      action: 'label.created',
      meta: { name: row.name, color: row.color },
    });
    emitAfterCommit(tx, labelEvent(project, actor, row.id));
    return row.id;
  });
  return labelById(orm, projectId, id);
}

/** Renames, recolors or re-describes a label (`MANAGE_LABELS`). */
export function updateLabel(
  deps: AppDeps,
  actor: Actor,
  labelId: string,
  input: UpdateLabelInput,
): Label {
  const { orm } = deps.db;
  const { label, project } = requireManageableLabel(deps, actor, labelId);
  const changes = diffFields(label, input);
  if (!hasChanges(changes)) return labelById(orm, project.id, labelId);

  deps.db.write((tx) => {
    if (input.name !== undefined) requireUniqueName(tx, project.id, input.name, labelId);
    tx.update(s.label)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(s.label.id, labelId))
      .run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'label',
      entityId: labelId,
      action: 'label.updated',
      changes,
      meta: { name: input.name ?? label.name },
    });
    emitAfterCommit(tx, labelEvent(project, actor, labelId));
  });
  return labelById(orm, project.id, labelId);
}

/**
 * Deletes a label (`MANAGE_LABELS`) and removes it from every issue and task of the project.
 * Audited with the number of items it was removed from.
 */
export function deleteLabel(deps: AppDeps, actor: Actor, labelId: string): DeleteLabelResponse {
  const { label, project, teamSlug } = requireManageableLabel(deps, actor, labelId);
  requireSignoff(deps, actor, {
    action: 'delete_label',
    teamId: project.teamId,
    projectId: project.id,
    input: { labelId },
    summary: `delete the label “${label.name}” in ${project.key}, removing it from every issue and task`,
    url: appPaths.projectSettings(teamSlug, project.key, 'labels'),
  });
  const removedFrom = deps.db.write((tx) => {
    const usage = labelUsage(tx, project.id).get(labelId);
    const removed = { issues: usage?.issueCount ?? 0, tasks: usage?.taskCount ?? 0 };
    // issue_label and task_label rows go with the label (ON DELETE CASCADE).
    tx.delete(s.label).where(eq(s.label.id, labelId)).run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'label',
      entityId: labelId,
      action: 'label.deleted',
      meta: {
        name: label.name,
        color: label.color,
        removedFromIssues: removed.issues,
        removedFromTasks: removed.tasks,
      },
    });
    emitAfterCommit(tx, labelEvent(project, actor, labelId));
    return removed;
  });
  return { ok: true, removedFrom };
}
