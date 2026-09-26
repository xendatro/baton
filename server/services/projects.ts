import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { DEFAULT_PROJECT_COLOR, DEFAULT_STATUSES } from '@shared/constants';
import { formatProjectRef, parseRef } from '@shared/refs';
import { projectKeySchema } from '@shared/schemas/common';
import {
  deriveProjectKey,
  projectKeyCandidates,
  type CreateProjectInput,
  type Project,
  type ProjectCounts,
  type ProjectKeyCheckQuery,
  type ProjectKeyCheckResponse,
  type ProjectListResponse,
  type ProjectSummary,
  type RestoreProjectInput,
  type UpdateProjectInput,
} from '@shared/schemas/projects';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { change, diffFields, hasChanges, type Changes } from '../lib/diff';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { excerpt } from '../lib/markdown';
import { appPaths } from '../lib/urls';
import {
  hasPermission,
  memberTeamIds,
  requireMember,
  requirePermission,
  type Membership,
} from './access';
import { recordActivity } from './activity';
import { attachToParent, referencedPendingUploads } from './attachments';
import { emitAfterCommit } from './events';
import { labelsOf } from './labels';
import { notifyMentions, refreshNotificationText } from './notifications';
import { statusesOf } from './statuses';
import { getUserSummaries } from './users';

/**
 * Projects (SPEC §1.4): a team's projects with their key, description, README, icon and color.
 * Keys are unique among a team's live projects; a changed key is kept as an alias
 * (`project_key_alias`), so old refs (`OLD-12`) and links keep resolving. Deleting moves the
 * project to Trash, which hides everything in it until it is restored.
 */

export type ProjectRow = typeof s.project.$inferSelect;
type TeamRow = typeof s.team.$inferSelect;

/** A live project, its team and the actor's membership there. */
export interface ProjectAccess {
  project: ProjectRow;
  team: TeamRow;
  membership: Membership;
}

/**
 * The live project `projectId` (its team live too) and the actor's membership. Missing, deleted
 * and other teams' projects are all `not_found` (named after `what`).
 */
export function requireProject(
  db: DbExecutor,
  actor: Actor,
  projectId: string,
  what = 'Project',
): ProjectAccess {
  const row = db
    .select({ project: s.project, team: s.team })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.project.id, projectId), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (!row) throw errors.notFound(what);
  return { ...row, membership: requireMember(db, actor, row.team.id, what) };
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

const README_EXCERPT_LENGTH = 140;

const EMPTY_COUNTS: ProjectCounts = {
  openTasks: 0,
  doneTasks: 0,
  openIssues: 0,
  resolvedIssues: 0,
};

/** Task and issue counts of several projects (deleted items excluded), keyed by project id. */
function projectCounts(db: DbExecutor, projectIds: readonly string[]): Map<string, ProjectCounts> {
  const counts = new Map<string, ProjectCounts>(projectIds.map((id) => [id, { ...EMPTY_COUNTS }]));
  if (projectIds.length === 0) return counts;
  const tasks = db
    .select({ projectId: s.task.projectId, category: s.status.category, n: count() })
    .from(s.task)
    .innerJoin(s.status, eq(s.status.id, s.task.statusId))
    .where(and(inArray(s.task.projectId, [...projectIds]), isNull(s.task.deletedAt)))
    .groupBy(s.task.projectId, s.status.category)
    .all();
  for (const row of tasks) {
    const entry = counts.get(row.projectId);
    if (!entry) continue;
    if (row.category === 'done') entry.doneTasks = row.n;
    else entry.openTasks = row.n;
  }
  const issues = db
    .select({ projectId: s.issue.projectId, resolved: s.issue.resolved, n: count() })
    .from(s.issue)
    .where(and(inArray(s.issue.projectId, [...projectIds]), isNull(s.issue.deletedAt)))
    .groupBy(s.issue.projectId, s.issue.resolved)
    .all();
  for (const row of issues) {
    const entry = counts.get(row.projectId);
    if (!entry) continue;
    if (row.resolved) entry.resolvedIssues = row.n;
    else entry.openIssues = row.n;
  }
  return counts;
}

function summaryOf(project: ProjectRow, teamSlug: string, counts: ProjectCounts): ProjectSummary {
  return {
    id: project.id,
    teamId: project.teamId,
    teamSlug,
    name: project.name,
    key: project.key,
    ref: formatProjectRef(project.key, teamSlug),
    description: project.description,
    icon: project.icon,
    color: project.color,
    counts,
    path: appPaths.project(teamSlug, project.key),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

/** Summaries of projects of one team, in the given order. */
function toSummaries(db: DbExecutor, rows: readonly ProjectRow[], teamSlug: string) {
  const counts = projectCounts(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => summaryOf(row, teamSlug, counts.get(row.id) ?? { ...EMPTY_COUNTS }));
}

function keyAliasesOf(db: DbExecutor, projectId: string): string[] {
  return db
    .select({ key: s.projectKeyAlias.key })
    .from(s.projectKeyAlias)
    .where(eq(s.projectKeyAlias.projectId, projectId))
    .orderBy(desc(s.projectKeyAlias.createdAt))
    .all()
    .map((row) => row.key);
}

/** The full project: summary plus README, creator, key aliases, statuses and labels. */
export function toProject(db: DbExecutor, project: ProjectRow, teamSlug: string): Project {
  const [summary] = toSummaries(db, [project], teamSlug);
  if (!summary) throw errors.internal();
  const creator = project.createdById
    ? (getUserSummaries(db, [project.createdById]).get(project.createdById) ?? null)
    : null;
  return {
    ...summary,
    readme: project.readme,
    createdBy: creator,
    keyAliases: keyAliasesOf(db, project.id),
    statuses: statusesOf(db, project.id),
    labels: labelsOf(db, project.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/** A project with everything in it the actor may see (any member of its team). */
export function getProject(deps: AppDeps, actor: Actor, projectId: string): Project {
  const { orm } = deps.db;
  const { project, team } = requireProject(orm, actor, projectId);
  return toProject(orm, project, team.slug);
}

/** Live projects of a team, alphabetical (any member). */
export function listTeamProjects(deps: AppDeps, actor: Actor, teamId: string): ProjectListResponse {
  const { orm } = deps.db;
  requireMember(orm, actor, teamId);
  const team = orm.select({ slug: s.team.slug }).from(s.team).where(eq(s.team.id, teamId)).get();
  if (!team) throw errors.notFound('Team');
  const rows = orm
    .select()
    .from(s.project)
    .where(and(eq(s.project.teamId, teamId), isNull(s.project.deletedAt)))
    .orderBy(asc(s.project.name), asc(s.project.key))
    .all();
  return { items: toSummaries(orm, rows, team.slug) };
}

/** Live projects in every team the actor belongs to, grouped by team name, then by name. */
export function listAllProjects(deps: AppDeps, actor: Actor): ProjectListResponse {
  const { orm } = deps.db;
  const teamIds = memberTeamIds(orm, actor.userId);
  if (teamIds.length === 0) return { items: [] };
  const rows = orm
    .select({ project: s.project, slug: s.team.slug })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(inArray(s.project.teamId, teamIds), isNull(s.project.deletedAt)))
    .orderBy(asc(s.team.name), asc(s.project.name), asc(s.project.key))
    .all();
  const counts = projectCounts(
    orm,
    rows.map((row) => row.project.id),
  );
  return {
    items: rows.map((row) =>
      summaryOf(row.project, row.slug, counts.get(row.project.id) ?? { ...EMPTY_COUNTS }),
    ),
  };
}

/**
 * Resolves a project ref (`team-slug/KEY`, `KEY` when unambiguous, or an id) the way links do:
 * previous keys resolve to the project, so the web app can redirect old URLs.
 */
export function resolveProjectRef(deps: AppDeps, actor: Actor, ref: string): ProjectSummary {
  const { orm } = deps.db;
  const value = ref.trim();
  const byId = orm
    .select({ project: s.project, team: s.team })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.project.id, value), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (byId) {
    requireMember(orm, actor, byId.team.id, 'Project');
    const [summary] = toSummaries(orm, [byId.project], byId.team.slug);
    if (!summary) throw errors.internal();
    return summary;
  }
  const parsed = parseRef(value);
  if (parsed?.kind !== 'project') throw errors.notFound('Project');
  let teamIds = memberTeamIds(orm, actor.userId);
  if (parsed.teamSlug) {
    const team = orm
      .select({ id: s.team.id })
      .from(s.team)
      .where(and(eq(s.team.slug, parsed.teamSlug), isNull(s.team.deletedAt)))
      .get();
    teamIds = team ? teamIds.filter((id) => id === team.id) : [];
  }
  const matches = findLiveProjectsByKey(orm, teamIds, parsed.projectKey);
  if (matches.length === 0) throw errors.notFound('Project');
  if (matches.length > 1) {
    const candidates = matches.map((row) => formatProjectRef(row.project.key, row.team.slug));
    throw errors.validation(
      `Project "${value}" is ambiguous. Use one of: ${candidates.join(', ')}`,
      { candidates },
    );
  }
  const [match] = matches as [(typeof matches)[number]];
  const [summary] = toSummaries(orm, [match.project], match.team.slug);
  if (!summary) throw errors.internal();
  return summary;
}

/** Live projects whose current key (or, failing that in a team, a previous key) is `key`. */
function findLiveProjectsByKey(db: DbExecutor, teamIds: readonly string[], key: string) {
  if (teamIds.length === 0) return [];
  const current = db
    .select({ project: s.project, team: s.team })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(
      and(
        inArray(s.project.teamId, [...teamIds]),
        eq(s.project.key, key),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .all();
  const aliased = db
    .select({ project: s.project, team: s.team })
    .from(s.projectKeyAlias)
    .innerJoin(s.project, eq(s.project.id, s.projectKeyAlias.projectId))
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(
      and(
        inArray(s.projectKeyAlias.teamId, [...teamIds]),
        eq(s.projectKeyAlias.key, key),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .all()
    .filter((row) => !current.some((hit) => hit.team.id === row.team.id));
  const seen = new Set<string>();
  return [...current, ...aliased].filter((row) =>
    seen.has(row.project.id) ? false : (seen.add(row.project.id), true),
  );
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** Current keys of the team's live projects, except `exceptProjectId`'s. */
function takenKeys(db: DbExecutor, teamId: string, exceptProjectId?: string): Set<string> {
  return new Set(
    db
      .select({ key: s.project.key })
      .from(s.project)
      .where(
        and(
          eq(s.project.teamId, teamId),
          isNull(s.project.deletedAt),
          exceptProjectId ? ne(s.project.id, exceptProjectId) : undefined,
        ),
      )
      .all()
      .map((row) => row.key),
  );
}

/** Previous keys of the team's other live projects (old links still point at them). */
function aliasKeys(db: DbExecutor, teamId: string, exceptProjectId?: string): Set<string> {
  return new Set(
    db
      .select({ key: s.projectKeyAlias.key })
      .from(s.projectKeyAlias)
      .innerJoin(s.project, eq(s.project.id, s.projectKeyAlias.projectId))
      .where(
        and(
          eq(s.projectKeyAlias.teamId, teamId),
          isNull(s.project.deletedAt),
          exceptProjectId ? ne(s.projectKeyAlias.projectId, exceptProjectId) : undefined,
        ),
      )
      .all()
      .map((row) => row.key),
  );
}

/**
 * The first free key among `base`, `base2`, `base3`, …: not used by a live project, preferring
 * keys that are not a previous key of another project either (so old links keep working).
 */
function freeKey(db: DbExecutor, teamId: string, base: string, exceptProjectId?: string): string {
  const taken = takenKeys(db, teamId, exceptProjectId);
  const aliases = aliasKeys(db, teamId, exceptProjectId);
  const candidates = projectKeyCandidates(base, 200);
  return (
    candidates.find((key) => !taken.has(key) && !aliases.has(key)) ??
    candidates.find((key) => !taken.has(key)) ??
    base
  );
}

function keyTakenError(key: string) {
  return errors.conflict(`Another project in this team already uses the key ${key}`, { key });
}

/**
 * Makes `key` the current key of `projectId` inside a write: fails if a live project of the team
 * uses it, drops it from other projects' previous keys (the key now means this project) and from
 * this project's own aliases.
 */
function claimKey(tx: Tx, teamId: string, projectId: string, key: string): void {
  if (takenKeys(tx, teamId, projectId).has(key)) throw keyTakenError(key);
  tx.delete(s.projectKeyAlias)
    .where(and(eq(s.projectKeyAlias.teamId, teamId), eq(s.projectKeyAlias.key, key)))
    .run();
}

/**
 * Is `key` usable for a new project (or for `projectId`) in the team? Invalid keys and keys of
 * other live projects are not; a suggestion is always included.
 */
export function checkProjectKey(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  query: ProjectKeyCheckQuery,
): ProjectKeyCheckResponse {
  const { orm } = deps.db;
  requireMember(orm, actor, teamId);
  const parsed = projectKeySchema.safeParse(query.key);
  const key = query.key.trim().toUpperCase();
  if (!parsed.success) {
    const base = deriveProjectKey(key);
    return {
      key,
      valid: false,
      available: false,
      message: parsed.error.issues[0]?.message ?? 'Invalid key',
      suggestion: freeKey(orm, teamId, base, query.projectId),
    };
  }
  const taken = takenKeys(orm, teamId, query.projectId).has(parsed.data);
  return {
    key: parsed.data,
    valid: true,
    available: !taken,
    message: taken ? `Another project in this team already uses ${parsed.data}` : null,
    suggestion: taken ? freeKey(orm, teamId, parsed.data, query.projectId) : parsed.data,
  };
}

// ---------------------------------------------------------------------------------------------
// README attachments
// ---------------------------------------------------------------------------------------------

function readmeTarget(project: ProjectRow, teamSlug: string) {
  return {
    teamId: project.teamId,
    entityType: 'project',
    entityId: project.id,
    title: `${project.name} README`,
    snippet: project.readme,
    url: appPaths.project(teamSlug, project.key),
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

function projectEvent(
  type: 'project.created' | 'project.updated' | 'project.deleted' | 'project.restored',
  project: ProjectRow,
  actor: Actor,
) {
  return {
    type,
    teamId: project.teamId,
    projectId: project.id,
    entityType: 'project' as const,
    entityId: project.id,
    actorId: actor.userId,
  };
}

/**
 * Creates a project (`MANAGE_PROJECTS`) with the default statuses Open (open, default) and Done.
 * Without a key, one is derived from the name and made unique within the team.
 */
export function createProject(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: CreateProjectInput,
): Project {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, teamId);
  requirePermission(membership, 'MANAGE_PROJECTS', "You don't have permission to create projects");
  const team = orm.select().from(s.team).where(eq(s.team.id, teamId)).get();
  if (!team) throw errors.notFound('Team');
  const readme = input.readme ?? '';

  const project = deps.db.write((tx) => {
    const id = newId();
    const key = input.key ?? freeKey(tx, teamId, deriveProjectKey(input.name));
    claimKey(tx, teamId, id, key);
    const now = new Date();
    const row = tx
      .insert(s.project)
      .values({
        id,
        teamId,
        name: input.name,
        key,
        description: input.description ?? '',
        readme,
        icon: input.icon ?? null,
        color: input.color ?? DEFAULT_PROJECT_COLOR,
        createdById: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    DEFAULT_STATUSES.forEach((seed, position) => {
      tx.insert(s.status)
        .values({ projectId: id, ...seed, position, createdAt: now, updatedAt: now })
        .run();
    });
    if (readme) {
      attachToParent(tx, actor, referencedPendingUploads(tx, actor, teamId, readme), {
        type: 'project',
        id,
        teamId,
        projectId: id,
      });
      notifyMentions(tx, actor, readmeTarget(row, team.slug), readme);
    }
    recordActivity(tx, actor, {
      teamId,
      projectId: id,
      entityType: 'project',
      entityId: id,
      action: 'project.created',
      meta: { name: row.name, key: row.key },
    });
    emitAfterCommit(tx, projectEvent('project.created', row, actor));
    return row;
  });
  return toProject(orm, project, team.slug);
}

/**
 * Updates a project (`MANAGE_PROJECTS`). A new key keeps the old one as an alias, so refs and
 * links using it still resolve. Pending uploads linked from a new README (and `attachmentIds`)
 * are attached to the project; new mentions in the README notify.
 */
export function updateProject(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: UpdateProjectInput,
): Project {
  const { orm } = deps.db;
  const { project, team, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_PROJECTS', "You don't have permission to edit projects");

  const { readme, attachmentIds, ...fields } = input;
  const changes: Changes = diffFields(project, fields);
  const readmeChanged = readme !== undefined && readme !== project.readme;
  if (readmeChanged) {
    changes.readme = change(
      excerpt(project.readme, README_EXCERPT_LENGTH),
      excerpt(readme, README_EXCERPT_LENGTH),
    );
  }
  if (!hasChanges(changes) && !attachmentIds?.length) return toProject(orm, project, team.slug);

  const updated = deps.db.write((tx) => {
    const keyChanged = fields.key !== undefined && fields.key !== project.key;
    if (keyChanged && fields.key) {
      claimKey(tx, project.teamId, project.id, fields.key);
      tx.insert(s.projectKeyAlias)
        .values({ projectId: project.id, teamId: project.teamId, key: project.key })
        .onConflictDoNothing()
        .run();
    }
    const row = hasChanges(changes)
      ? tx
          .update(s.project)
          .set({
            ...(fields.name !== undefined ? { name: fields.name } : {}),
            ...(fields.key !== undefined ? { key: fields.key } : {}),
            ...(fields.description !== undefined ? { description: fields.description } : {}),
            ...(fields.icon !== undefined ? { icon: fields.icon } : {}),
            ...(fields.color !== undefined ? { color: fields.color } : {}),
            ...(readmeChanged ? { readme } : {}),
            updatedAt: new Date(),
          })
          .where(eq(s.project.id, project.id))
          .returning()
          .get()
      : project;
    const uploads = [
      ...(attachmentIds ?? []),
      ...(readmeChanged ? referencedPendingUploads(tx, actor, project.teamId, readme) : []),
    ];
    attachToParent(tx, actor, uploads, {
      type: 'project',
      id: project.id,
      teamId: project.teamId,
      projectId: project.id,
    });
    if (readmeChanged) {
      refreshNotificationText(tx, readmeTarget(row, team.slug));
      notifyMentions(tx, actor, readmeTarget(row, team.slug), readme, {
        previousBody: project.readme,
      });
    }
    if (hasChanges(changes)) {
      recordActivity(tx, actor, {
        teamId: project.teamId,
        projectId: project.id,
        entityType: 'project',
        entityId: project.id,
        action: 'project.updated',
        changes,
        meta: {
          name: row.name,
          key: row.key,
          ...(keyChanged ? { previousKey: project.key } : {}),
        },
      });
      emitAfterCommit(tx, projectEvent('project.updated', row, actor));
    }
    return row;
  });
  return toProject(orm, updated, team.slug);
}

/**
 * Moves a project to Trash (`MANAGE_PROJECTS`). Its issues, tasks and replies disappear from
 * lists, boards, search and MCP results until it is restored; the daily purge removes it after
 * 30 days.
 */
export function deleteProject(deps: AppDeps, actor: Actor, projectId: string): { ok: true } {
  const { orm } = deps.db;
  const { project, membership } = requireProject(orm, actor, projectId);
  requirePermission(membership, 'MANAGE_PROJECTS', "You don't have permission to delete projects");
  deps.db.write((tx) => {
    tx.update(s.project)
      .set({
        deletedAt: new Date(),
        deletedById: actor.userId,
        deletedViaKeyId: actor.key?.id ?? null,
      })
      .where(eq(s.project.id, project.id))
      .run();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      action: 'project.deleted',
      meta: { name: project.name, key: project.key },
    });
    emitAfterCommit(tx, projectEvent('project.deleted', project, actor));
  });
  return { ok: true };
}

/** A deleted project of a team the actor belongs to, by id or `team-slug/KEY` (latest deleted). */
export function findDeletedProject(deps: AppDeps, actor: Actor, ref: string): ProjectRow {
  const { orm } = deps.db;
  const value = ref.trim();
  const teamIds = memberTeamIds(orm, actor.userId);
  if (teamIds.length === 0) throw errors.notFound('Deleted project');
  const byId = orm
    .select()
    .from(s.project)
    .where(
      and(
        eq(s.project.id, value),
        inArray(s.project.teamId, teamIds),
        isNotNull(s.project.deletedAt),
      ),
    )
    .get();
  if (byId) return byId;
  const parsed = parseRef(value);
  if (parsed?.kind !== 'project') throw errors.notFound('Deleted project');
  const rows = orm
    .select({ project: s.project, slug: s.team.slug })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(
      and(
        inArray(s.project.teamId, teamIds),
        eq(s.project.key, parsed.projectKey),
        isNotNull(s.project.deletedAt),
        parsed.teamSlug ? eq(s.team.slug, parsed.teamSlug) : undefined,
      ),
    )
    .orderBy(desc(s.project.deletedAt))
    .all();
  const teams = new Set(rows.map((row) => row.slug));
  if (teams.size > 1) {
    const candidates = [...teams].map((slug) => formatProjectRef(parsed.projectKey, slug));
    throw errors.validation(
      `Deleted project "${value}" is ambiguous. Use one of: ${candidates.join(', ')}`,
      { candidates },
    );
  }
  const [first] = rows;
  if (!first) throw errors.notFound('Deleted project');
  return first.project;
}

/**
 * Restores a project from Trash (`MANAGE_PROJECTS` or `MANAGE_TRASH`), and with it the visibility
 * of everything inside. When another project took its key meanwhile, pass a new `key`.
 */
export function restoreProject(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: RestoreProjectInput = {},
): Project {
  const { orm } = deps.db;
  const project = orm.select().from(s.project).where(eq(s.project.id, projectId)).get();
  if (!project?.deletedAt) throw errors.notFound('Deleted project');
  const membership = requireMember(orm, actor, project.teamId, 'Deleted project');
  if (!hasPermission(membership, 'MANAGE_PROJECTS') && !hasPermission(membership, 'MANAGE_TRASH')) {
    throw errors.forbidden("You don't have permission to restore projects");
  }
  const team = orm.select().from(s.team).where(eq(s.team.id, project.teamId)).get();
  if (!team) throw errors.notFound('Deleted project');

  const restored = deps.db.write((tx) => {
    const key = input.key ?? project.key;
    if (takenKeys(tx, project.teamId, project.id).has(key)) {
      const suggestion = freeKey(tx, project.teamId, key, project.id);
      throw errors.conflict(
        input.key
          ? `Another project in this team already uses the key ${key}. Try ${suggestion}.`
          : `Another project now uses the key ${key}. Restore it with a different key, such as ${suggestion}.`,
        { key, suggestion },
      );
    }
    claimKey(tx, project.teamId, project.id, key);
    if (key !== project.key) {
      tx.insert(s.projectKeyAlias)
        .values({ projectId: project.id, teamId: project.teamId, key: project.key })
        .onConflictDoNothing()
        .run();
    }
    const row = tx
      .update(s.project)
      .set({ key, deletedAt: null, deletedById: null, deletedViaKeyId: null })
      .where(eq(s.project.id, project.id))
      .returning()
      .get();
    recordActivity(tx, actor, {
      teamId: project.teamId,
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      action: 'project.restored',
      changes: key === project.key ? {} : { key: change(project.key, key) },
      meta: { name: row.name, key: row.key },
    });
    emitAfterCommit(tx, projectEvent('project.restored', row, actor));
    return row;
  });
  return toProject(orm, restored, team.slug);
}
