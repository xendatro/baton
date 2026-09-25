import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { parseRef, type ProjectRef } from '@shared/refs';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { memberTeamIds, requireMember, type Membership } from './access';

/**
 * Resolves the human references accepted everywhere by MCP tools (SPEC §5.1), always within the
 * caller's teams: team = slug or id; project = `KEY` (if unambiguous), `team-slug/KEY` or id;
 * task = `KEY-12` / `team-slug/KEY-12` / id; issue = `KEY#51` / `team-slug/KEY#51` / id;
 * user = username or id; role = slug, name or id; status and label = name or id.
 * Unknown refs are `not_found`; ambiguous ones are `validation_failed` listing the candidates.
 */

export type TeamRow = typeof s.team.$inferSelect;
export type ProjectRow = typeof s.project.$inferSelect;
export type TaskRow = typeof s.task.$inferSelect;
export type IssueRow = typeof s.issue.$inferSelect;
export type UserRow = typeof s.user.$inferSelect;
export type RoleRow = typeof s.role.$inferSelect;
export type StatusRow = typeof s.status.$inferSelect;
export type LabelRow = typeof s.label.$inferSelect;

function ambiguous(what: string, ref: string, candidates: string[]) {
  return errors.validation(`${what} "${ref}" is ambiguous. Use one of: ${candidates.join(', ')}`, {
    candidates,
  });
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

export interface ResolvedTeam {
  team: TeamRow;
  membership: Membership;
}

/** A team the caller belongs to, by slug or id. */
export function resolveTeam(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ResolvedTeam {
  const { orm } = deps.db;
  const value = ref.trim();
  const team = orm
    .select()
    .from(s.team)
    .where(
      and(or(eq(s.team.id, value), eq(s.team.slug, value.toLowerCase())), isNull(s.team.deletedAt)),
    )
    .get();
  if (!team) throw errors.notFound('Team');
  return { team, membership: requireMember(orm, actor, team.id) };
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export interface ResolvedProject {
  project: ProjectRow;
  team: TeamRow;
  membership: Membership;
}

/** Live projects (in the given teams) whose current key or a previous key (alias) is `key`. */
function projectsByKey(db: DbExecutor, teamIds: readonly string[], key: string) {
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
  // Old keys keep resolving, unless a live project took the key over in that team.
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

function resolveParsedProject(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  parsed: Pick<ProjectRef, 'teamSlug' | 'projectKey'>,
  original: string,
): ResolvedProject {
  const { orm } = deps.db;
  let teamIds = memberTeamIds(orm, actor.userId);
  if (parsed.teamSlug) {
    const team = orm
      .select({ id: s.team.id })
      .from(s.team)
      .where(and(eq(s.team.slug, parsed.teamSlug), isNull(s.team.deletedAt)))
      .get();
    teamIds = team ? teamIds.filter((id) => id === team.id) : [];
  }
  const matches = projectsByKey(orm, teamIds, parsed.projectKey);
  if (matches.length === 0) throw errors.notFound('Project');
  if (matches.length > 1) {
    throw ambiguous(
      'Project',
      original,
      matches.map((row) => `${row.team.slug}/${row.project.key}`),
    );
  }
  const [{ project, team }] = matches as [(typeof matches)[number]];
  return { project, team, membership: requireMember(orm, actor, team.id, 'Project') };
}

/** A live project in one of the caller's teams, by `KEY`, `team-slug/KEY` or id. */
export function resolveProject(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  ref: string,
): ResolvedProject {
  const { orm } = deps.db;
  const value = ref.trim();
  const byId = orm
    .select({ project: s.project, team: s.team })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(and(eq(s.project.id, value), isNull(s.project.deletedAt), isNull(s.team.deletedAt)))
    .get();
  if (byId) {
    return { ...byId, membership: requireMember(orm, actor, byId.team.id, 'Project') };
  }
  const parsed = parseRef(value);
  if (!parsed || parsed.kind !== 'project') throw errors.notFound('Project');
  return resolveParsedProject(deps, actor, parsed, value);
}

// ---------------------------------------------------------------------------------------------
// Tasks & issues
// ---------------------------------------------------------------------------------------------

export interface ResolvedTask extends ResolvedProject {
  task: TaskRow;
}

export interface ResolvedIssue extends ResolvedProject {
  issue: IssueRow;
}

function resolveNumbered<K extends 'task' | 'issue'>(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  kind: K,
  ref: string,
): ResolvedProject & { row: K extends 'task' ? TaskRow : IssueRow } {
  const { orm } = deps.db;
  const table = kind === 'task' ? s.task : s.issue;
  const what = kind === 'task' ? 'Task' : 'Issue';
  const value = ref.trim();

  const byId = orm
    .select({ row: table, project: s.project, team: s.team })
    .from(table)
    .innerJoin(s.project, eq(s.project.id, table.projectId))
    .innerJoin(s.team, eq(s.team.id, table.teamId))
    .where(
      and(
        eq(table.id, value),
        isNull(table.deletedAt),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .get();
  if (byId) {
    return {
      row: byId.row as K extends 'task' ? TaskRow : IssueRow,
      project: byId.project,
      team: byId.team,
      membership: requireMember(orm, actor, byId.team.id, what),
    };
  }

  const parsed = parseRef(value);
  if (!parsed || parsed.kind !== kind) throw errors.notFound(what);
  const { project, team, membership } = resolveParsedProject(deps, actor, parsed, value);
  const row = orm
    .select()
    .from(table)
    .where(
      and(
        eq(table.projectId, project.id),
        eq(table.number, parsed.number),
        isNull(table.deletedAt),
      ),
    )
    .get();
  if (!row) throw errors.notFound(what);
  return { row: row as K extends 'task' ? TaskRow : IssueRow, project, team, membership };
}

/** A live task by `KEY-12`, `team-slug/KEY-12` or id. */
export function resolveTask(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ResolvedTask {
  const { row, ...rest } = resolveNumbered(deps, actor, 'task', ref);
  return { ...rest, task: row };
}

/** A live issue by `KEY#51`, `team-slug/KEY#51` or id. */
export function resolveIssue(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ResolvedIssue {
  const { row, ...rest } = resolveNumbered(deps, actor, 'issue', ref);
  return { ...rest, issue: row };
}

// ---------------------------------------------------------------------------------------------
// Users, roles, statuses, labels
// ---------------------------------------------------------------------------------------------

/**
 * A user who shares a team with the caller (or the caller), by username or id. With `teamId`,
 * the user must be a member of that team.
 */
export function resolveUser(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  ref: string,
  options: { teamId?: string } = {},
): UserRow {
  const { orm } = deps.db;
  const value = ref.trim().replace(/^@/, '');
  const user = orm
    .select()
    .from(s.user)
    .where(or(eq(s.user.id, value), eq(s.user.username, value.toLowerCase())))
    .get();
  if (!user) throw errors.notFound('User');
  const teamIds = options.teamId ? [options.teamId] : memberTeamIds(orm, actor.userId);
  if (options.teamId) requireMember(orm, actor, options.teamId);
  if (user.id === actor.userId && !options.teamId) return user;
  if (teamIds.length === 0) throw errors.notFound('User');
  const shared = orm
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .where(and(eq(s.teamMember.userId, user.id), inArray(s.teamMember.teamId, teamIds)))
    .get();
  if (!shared) throw errors.notFound('User');
  return user;
}

/** A role of the team by id, slug or name (case-insensitive). `@everyone` resolves too. */
export function resolveRole(db: DbExecutor, teamId: string, ref: string): RoleRow {
  const value = ref.trim().replace(/^@&?/, '');
  const roles = db.select().from(s.role).where(eq(s.role.teamId, teamId)).all();
  const bySlug = roles.find((role) => role.slug === value.toLowerCase());
  return bySlug ?? pickByIdOrName(roles, value, 'Role');
}

/**
 * Picks the row whose id is `ref`, else whose name is exactly `ref`, else the single row whose name
 * matches case-insensitively. Several case-insensitive matches are ambiguous.
 */
function pickByIdOrName<T extends { id: string; name: string }>(
  rows: readonly T[],
  ref: string,
  what: string,
): T {
  const value = ref.trim();
  const exact = rows.find((row) => row.id === value) ?? rows.find((row) => row.name === value);
  if (exact) return exact;
  const lower = value.toLowerCase();
  const loose = rows.filter((row) => row.name.toLowerCase() === lower);
  if (loose.length > 1) {
    throw ambiguous(
      what,
      ref,
      loose.map((row) => row.name),
    );
  }
  const [only] = loose;
  if (!only) throw errors.notFound(what);
  return only;
}

/** A status of the project by id or name (case-insensitive). */
export function resolveStatus(db: DbExecutor, projectId: string, ref: string): StatusRow {
  const rows = db.select().from(s.status).where(eq(s.status.projectId, projectId)).all();
  return pickByIdOrName(rows, ref, 'Status');
}

/** A label of the project by id or name (case-insensitive). */
export function resolveLabel(db: DbExecutor, projectId: string, ref: string): LabelRow {
  const rows = db.select().from(s.label).where(eq(s.label.projectId, projectId)).all();
  return pickByIdOrName(rows, ref, 'Label');
}
