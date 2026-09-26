import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  formatIssueRef,
  formatProjectRef,
  formatTaskRef,
  parseRef,
  type ParsedRef,
} from '@shared/refs';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { memberTeamIds, requireMember, type Membership } from './access';

/**
 * Resolves the human references accepted everywhere by MCP tools (SPEC §5.1), always within the
 * caller's teams: team = slug or id; project = `KEY` (if unambiguous), `team-slug/KEY` or id;
 * task = `KEY-12` / `team-slug/KEY-12` / id; issue = `KEY#51` / `team-slug/KEY#51` / id;
 * user = username or id; role = slug, name or id; status and label = name or id. Projects, tasks
 * and issues are also accepted as their app URLs (`…/t/team/p/KEY/tasks/12`).
 *
 * Unknown refs are `not_found` with a message naming the ref and, where it helps, the valid
 * values (`details: { ref, candidates }`); a ref of the wrong kind (an issue ref for a task) and
 * ambiguous refs are `validation_failed`, the latter listing the fully qualified candidates. Only
 * values inside the caller's teams are ever listed.
 */

export type TeamRow = typeof s.team.$inferSelect;
export type ProjectRow = typeof s.project.$inferSelect;
export type TaskRow = typeof s.task.$inferSelect;
export type IssueRow = typeof s.issue.$inferSelect;
export type UserRow = typeof s.user.$inferSelect;
export type RoleRow = typeof s.role.$inferSelect;
export type StatusRow = typeof s.status.$inferSelect;
export type LabelRow = typeof s.label.$inferSelect;

/** Most candidates a message lists (details carry the same list). */
const CANDIDATES_SHOWN = 30;

function listed(values: readonly string[]): string {
  const shown = values.slice(0, CANDIDATES_SHOWN).join(', ');
  const more = values.length - CANDIDATES_SHOWN;
  return more > 0 ? `${shown} … (${more} more)` : shown || 'none';
}

function ambiguous(what: string, ref: string, candidates: string[]) {
  return errors.validation(`${what} "${ref}" is ambiguous. Use one of: ${candidates.join(', ')}`, {
    candidates,
  });
}

/** `What not found: "ref"<context>. <Label>: a, b, c` with the candidates in details. */
function notFound(
  what: string,
  ref: string,
  options: { context?: string; label?: string; candidates?: string[]; hint?: string } = {},
) {
  const { context = '', label, candidates, hint } = options;
  let message = `${what} not found: "${ref.trim()}"${context}`;
  if (hint) message += `. ${hint}`;
  if (label && candidates) message += `. ${label}: ${listed(candidates)}`;
  return errors.notFoundWith(message, {
    ref: ref.trim(),
    ...(candidates ? { candidates: candidates.slice(0, CANDIDATES_SHOWN) } : {}),
  });
}

/**
 * The ref inside an app URL (absolute or a path): `/t/team/p/KEY` → `team/KEY`,
 * `/t/team/p/KEY/tasks/12` → `team/KEY-12`, `/t/team/p/KEY/issues/51` → `team/KEY#51`. Anything
 * else is returned trimmed.
 */
export function refFromAppUrl(ref: string): string {
  const value = ref.trim();
  const match =
    /^(?:https?:\/\/[^/]+)?\/t\/([a-z0-9-]+)\/p\/([a-z][a-z0-9]{1,5})(?:\/(tasks|issues)\/(\d{1,9}))?(?:[/?#].*)?$/i.exec(
      value,
    );
  if (!match) return value;
  const [, team, key, kind, number] = match;
  if (!kind || !number) return `${team}/${key}`;
  return `${team}/${key}${kind === 'tasks' ? '-' : '#'}${number}`;
}

/** The caller's live teams (slug order). */
function callerTeams(db: DbExecutor, actor: Actor) {
  const ids = memberTeamIds(db, actor.userId);
  if (ids.length === 0) return [];
  return db
    .select({ id: s.team.id, slug: s.team.slug })
    .from(s.team)
    .where(inArray(s.team.id, ids))
    .orderBy(asc(s.team.slug))
    .all();
}

function teamSlug(db: DbExecutor, teamId: string): string {
  return (
    db.select({ slug: s.team.slug }).from(s.team).where(eq(s.team.id, teamId)).get()?.slug ??
    'this team'
  );
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
  const mine = team && memberTeamIds(orm, actor.userId).includes(team.id);
  if (!team || !mine) {
    throw notFound('Team', ref, {
      label: 'Your teams',
      candidates: callerTeams(orm, actor).map((row) => row.slug),
    });
  }
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

/** `team/KEY (Name)` for the live projects of the given teams, to list in a not-found message. */
function projectCandidates(db: DbExecutor, teamIds: readonly string[]): string[] {
  if (teamIds.length === 0) return [];
  return db
    .select({ key: s.project.key, name: s.project.name, slug: s.team.slug })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(
      and(
        inArray(s.project.teamId, [...teamIds]),
        isNull(s.project.deletedAt),
        isNull(s.team.deletedAt),
      ),
    )
    .orderBy(asc(s.team.slug), asc(s.project.key))
    .all()
    .map((row) => `${row.slug}/${row.key} (${row.name})`);
}

/** The same ref qualified with another team, for ambiguity candidates. */
function qualified(parsed: ParsedRef, teamSlugValue: string, projectKey: string): string {
  switch (parsed.kind) {
    case 'task':
      return formatTaskRef(projectKey, parsed.number, teamSlugValue);
    case 'issue':
      return formatIssueRef(projectKey, parsed.number, teamSlugValue);
    default:
      return formatProjectRef(projectKey, teamSlugValue);
  }
}

const KIND_NAMES = { project: 'Project', task: 'Task', issue: 'Issue' } as const;

function resolveParsedProject(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  parsed: ParsedRef,
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
    const mine = team ? teamIds.filter((id) => id === team.id) : [];
    if (mine.length === 0) {
      throw notFound(KIND_NAMES[parsed.kind], original, {
        context: ` (you are not in a team "${parsed.teamSlug}")`,
        label: 'Your teams',
        candidates: callerTeams(orm, actor).map((row) => row.slug),
      });
    }
    teamIds = mine;
  }
  const matches = projectsByKey(orm, teamIds, parsed.projectKey);
  if (matches.length === 0) {
    throw notFound(KIND_NAMES[parsed.kind], original, {
      context: ` (no project with the key ${parsed.projectKey})`,
      label: 'Your projects',
      candidates: projectCandidates(orm, teamIds),
    });
  }
  if (matches.length > 1) {
    throw ambiguous(
      KIND_NAMES[parsed.kind],
      original,
      matches.map((row) => qualified(parsed, row.team.slug, row.project.key)),
    );
  }
  const [{ project, team }] = matches as [(typeof matches)[number]];
  return { project, team, membership: requireMember(orm, actor, team.id, 'Project') };
}

/** A live project in one of the caller's teams, by `KEY`, `team-slug/KEY`, id or app URL. */
export function resolveProject(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  ref: string,
): ResolvedProject {
  const { orm } = deps.db;
  const value = refFromAppUrl(ref);
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
  if (parsed && parsed.kind !== 'project') {
    throw errors.validation(
      `"${value}" is a ${parsed.kind} ref; a project is KEY or team-slug/KEY (e.g. ${formatProjectRef(parsed.projectKey, parsed.teamSlug)})`,
    );
  }
  if (!parsed) {
    throw notFound('Project', ref, {
      hint: 'Use the project KEY, team-slug/KEY or its id',
      label: 'Your projects',
      candidates: projectCandidates(orm, memberTeamIds(orm, actor.userId)),
    });
  }
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

const REF_SHAPES = { task: 'KEY-12', issue: 'KEY#51' } as const;
const ARTICLE = { task: 'a task', issue: 'an issue' } as const;

/** Whether `id` is a live item of the other kind in one of the caller's teams. */
function isOtherKindId(db: DbExecutor, actor: Actor, kind: 'task' | 'issue', id: string) {
  const table = kind === 'task' ? s.issue : s.task;
  const row = db
    .select({ teamId: table.teamId })
    .from(table)
    .where(and(eq(table.id, id), isNull(table.deletedAt)))
    .get();
  return row !== undefined && memberTeamIds(db, actor.userId).includes(row.teamId);
}

function resolveNumbered<K extends 'task' | 'issue'>(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  kind: K,
  ref: string,
): ResolvedProject & { row: K extends 'task' ? TaskRow : IssueRow } {
  const { orm } = deps.db;
  const table = kind === 'task' ? s.task : s.issue;
  const what = KIND_NAMES[kind];
  const other = kind === 'task' ? 'issue' : 'task';
  const value = refFromAppUrl(ref);

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
  if (parsed && parsed.kind !== kind) {
    const separator = kind === 'task' ? '-' : '#';
    throw errors.validation(
      parsed.kind === 'project'
        ? `"${value}" is a project ref; ${ARTICLE[kind]} ref looks like ${REF_SHAPES[kind]} (e.g. ${parsed.projectKey}${separator}12)`
        : `"${value}" is ${ARTICLE[other]} ref (${REF_SHAPES[other]}), not ${ARTICLE[kind]} ref (${REF_SHAPES[kind]}); use the ${other} tools for it`,
    );
  }
  if (!parsed) {
    if (isOtherKindId(orm, actor, kind, value)) {
      throw errors.validation(
        `"${value}" is the id of ${ARTICLE[other]}, not ${ARTICLE[kind]}; use the ${other} tools for it`,
      );
    }
    throw notFound(what, ref, {
      hint: `Use ${REF_SHAPES[kind]}, team-slug/${REF_SHAPES[kind]} or its id`,
    });
  }
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
  if (!row) {
    throw notFound(what, ref, { context: ` in ${formatProjectRef(project.key, team.slug)}` });
  }
  return { row: row as K extends 'task' ? TaskRow : IssueRow, project, team, membership };
}

/** A live task by `KEY-12`, `team-slug/KEY-12`, id or app URL. */
export function resolveTask(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ResolvedTask {
  const { row, ...rest } = resolveNumbered(deps, actor, 'task', ref);
  return { ...rest, task: row };
}

/** A live issue by `KEY#51`, `team-slug/KEY#51`, id or app URL. */
export function resolveIssue(deps: Pick<AppDeps, 'db'>, actor: Actor, ref: string): ResolvedIssue {
  const { row, ...rest } = resolveNumbered(deps, actor, 'issue', ref);
  return { ...rest, issue: row };
}

// ---------------------------------------------------------------------------------------------
// Users, roles, statuses, labels
// ---------------------------------------------------------------------------------------------

/** Usernames of a team's members, to list in a not-found message. */
function memberUsernames(db: DbExecutor, teamId: string): string[] {
  return db
    .select({ username: s.user.username })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(eq(s.teamMember.teamId, teamId))
    .orderBy(asc(s.user.username))
    .all()
    .flatMap((row) => (row.username ? [row.username] : []));
}

/**
 * A user who shares a team with the caller (or the caller), by username or id. With `teamId`,
 * the user must be a member of that team. The message is the same whether or not the account
 * exists outside the caller's teams.
 */
export function resolveUser(
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  ref: string,
  options: { teamId?: string } = {},
): UserRow {
  const { orm } = deps.db;
  const value = ref.trim().replace(/^@/, '');
  if (options.teamId) requireMember(orm, actor, options.teamId);
  const missing = () =>
    options.teamId
      ? notFound('User', ref, {
          context: ` is not a member of ${teamSlug(orm, options.teamId)}`,
          label: 'Members',
          candidates: memberUsernames(orm, options.teamId),
        })
      : notFound('User', ref, { context: ' in your teams' });
  const user = orm
    .select()
    .from(s.user)
    .where(or(eq(s.user.id, value), eq(s.user.username, value.toLowerCase())))
    .get();
  if (!user) throw missing();
  const teamIds = options.teamId ? [options.teamId] : memberTeamIds(orm, actor.userId);
  if (user.id === actor.userId && !options.teamId) return user;
  if (teamIds.length === 0) throw missing();
  const shared = orm
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .where(and(eq(s.teamMember.userId, user.id), inArray(s.teamMember.teamId, teamIds)))
    .get();
  if (!shared) throw missing();
  return user;
}

/** A role of the team by id, slug or name (case-insensitive). `@everyone` resolves too. */
export function resolveRole(db: DbExecutor, teamId: string, ref: string): RoleRow {
  const value = ref.trim().replace(/^@&?/, '');
  const roles = db
    .select()
    .from(s.role)
    .where(eq(s.role.teamId, teamId))
    .orderBy(desc(s.role.position))
    .all();
  const bySlug = roles.find((role) => role.slug === value.toLowerCase());
  return (
    bySlug ??
    pickByIdOrName(roles, value, 'Role', () => ({
      context: ` in ${teamSlug(db, teamId)}`,
      label: 'Roles',
    }))
  );
}

/**
 * Picks the row whose id is `ref`, else whose name is exactly `ref`, else the single row whose name
 * matches case-insensitively. Several case-insensitive matches are ambiguous; no match is
 * `not_found` listing the names.
 */
function pickByIdOrName<T extends { id: string; name: string }>(
  rows: readonly T[],
  ref: string,
  what: string,
  scope: () => { context: string; label: string },
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
  if (!only) throw notFound(what, ref, { ...scope(), candidates: rows.map((row) => row.name) });
  return only;
}

/** `team/KEY` of a project, for messages. */
function projectLabel(db: DbExecutor, projectId: string): string {
  const row = db
    .select({ key: s.project.key, slug: s.team.slug })
    .from(s.project)
    .innerJoin(s.team, eq(s.team.id, s.project.teamId))
    .where(eq(s.project.id, projectId))
    .get();
  return row ? formatProjectRef(row.key, row.slug) : 'this project';
}

/** A status of the project by id or name (case-insensitive). */
export function resolveStatus(db: DbExecutor, projectId: string, ref: string): StatusRow {
  const rows = db
    .select()
    .from(s.status)
    .where(eq(s.status.projectId, projectId))
    .orderBy(asc(s.status.position))
    .all();
  return pickByIdOrName(rows, ref, 'Status', () => ({
    context: ` in ${projectLabel(db, projectId)}`,
    label: 'Statuses',
  }));
}

/** A label of the project by id or name (case-insensitive). */
export function resolveLabel(db: DbExecutor, projectId: string, ref: string): LabelRow {
  const rows = db
    .select()
    .from(s.label)
    .where(eq(s.label.projectId, projectId))
    .orderBy(asc(s.label.name))
    .all();
  return pickByIdOrName(rows, ref, 'Label', () => ({
    context: ` in ${projectLabel(db, projectId)}`,
    label: 'Labels',
  }));
}
