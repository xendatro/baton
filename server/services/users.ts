import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { MAX_ANY_USERNAME_LENGTH } from '@shared/constants';
import {
  reorderMyTeamsInputSchema,
  updateMyTeamInputSchema,
  type MeResponse,
  type MentionablesQuery,
  type MentionablesResponse,
  type ReorderMyTeamsInput,
  type RoleSummary,
  type UpdateMyTeamInput,
  type UserSummary,
  type ViaKey,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { likeContains } from '../lib/sql';
import {
  canViewProject,
  hasPermission,
  listMemberships,
  listProjectMemberships,
  requireMember,
} from './access';
import { emitAfterCommit } from './events';
import { unreadNotificationCount } from './notifications';

type UserRow = typeof s.user.$inferSelect;

/** The user columns a `UserSummary` needs (agents also name their owner). */
export const userSummaryColumns = {
  id: s.user.id,
  username: s.user.username,
  name: s.user.name,
  image: s.user.image,
  kind: s.user.kind,
  agentOwnerId: s.user.agentOwnerId,
};

type SummaryRow = Pick<UserRow, 'id' | 'username' | 'name' | 'image'> &
  Partial<Pick<UserRow, 'kind' | 'agentOwnerId'>>;

function basicSummary(user: Pick<UserRow, 'id' | 'username' | 'name' | 'image'>): UserSummary {
  return { id: user.id, username: user.username ?? '', name: user.name, image: user.image };
}

/**
 * A user's summary. Agent members (agents A) carry `kind: 'agent'` and their owner (pass it, or
 * use `toUserSummaries`/`getUserSummaries`, which look owners up); people have no `kind`.
 */
export function toUserSummary(user: SummaryRow, owner?: SummaryRow | null): UserSummary {
  const summary = basicSummary(user);
  if (user.kind !== 'agent') return summary;
  return { ...summary, kind: 'agent', agentOwner: owner ? basicSummary(owner) : null };
}

/** Summaries of `rows` (selected with `userSummaryColumns`), agents with their owners. */
export function toUserSummaries(db: DbExecutor, rows: readonly SummaryRow[]): UserSummary[] {
  const ownerIds = [
    ...new Set(
      rows.flatMap((row) => (row.kind === 'agent' && row.agentOwnerId ? [row.agentOwnerId] : [])),
    ),
  ];
  const owners = new Map(
    ownerIds.length === 0
      ? []
      : db
          .select(userSummaryColumns)
          .from(s.user)
          .where(inArray(s.user.id, ownerIds))
          .all()
          .map((row) => [row.id, row]),
  );
  return rows.map((row) =>
    toUserSummary(row, row.agentOwnerId ? (owners.get(row.agentOwnerId) ?? null) : null),
  );
}

/** Summaries of the given users, keyed by id (missing ids are deleted accounts). */
export function getUserSummaries(
  db: DbExecutor,
  ids: Iterable<string | null | undefined>,
): Map<string, UserSummary> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = db.select(userSummaryColumns).from(s.user).where(inArray(s.user.id, unique)).all();
  return new Map(toUserSummaries(db, rows).map((summary) => [summary.id, summary]));
}

/** Current names of the given API keys, keyed by id ("ethan via Claude on laptop"). */
export function getViaKeys(
  db: DbExecutor,
  ids: Iterable<string | null | undefined>,
): Map<string, ViaKey> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = db
    .select({ id: s.apiKey.id, name: s.apiKey.name, agentName: s.apiKey.agentName })
    .from(s.apiKey)
    .where(inArray(s.apiKey.id, unique))
    .all();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        keyId: row.id,
        keyName: row.name,
        ...(row.agentName ? { agentName: row.agentName } : {}),
      },
    ]),
  );
}

/** `GET /api/me`: the signed-in user, their teams (with effective permissions) and projects. */
export function getMe(deps: AppDeps, actor: Actor): MeResponse {
  const { orm } = deps.db;
  const user = orm.select().from(s.user).where(eq(s.user.id, actor.userId)).get();
  if (!user) throw errors.unauthorized();

  const memberships = listMemberships(orm, actor.userId);
  const teamIds = memberships.map((membership) => membership.teamId);
  // Only projects the user can see (VIEW_PROJECT), each with the user's permissions there.
  const access = new Map(
    listProjectMemberships(orm, actor.userId, { teamIds })
      .filter(canViewProject)
      .map((project) => [project.projectId, project.permissions]),
  );
  const sidebar = new Map(
    teamIds.length === 0
      ? []
      : orm
          .select({
            teamId: s.teamMember.teamId,
            position: s.teamMember.sidebarPosition,
            pinned: s.teamMember.pinned,
            collapsed: s.teamMember.sidebarCollapsed,
          })
          .from(s.teamMember)
          .where(eq(s.teamMember.userId, actor.userId))
          .all()
          .map((row) => [row.teamId, row]),
  );
  // Your sidebar order (BAT-36): pinned first, then the order you arranged, then by name.
  const teams = (
    teamIds.length === 0
      ? []
      : orm.select().from(s.team).where(inArray(s.team.id, teamIds)).orderBy(asc(s.team.name)).all()
  ).sort((a, b) => compareSidebar(sidebar.get(a.id), sidebar.get(b.id)));
  const projects =
    teamIds.length === 0
      ? []
      : orm
          .select({
            id: s.project.id,
            teamId: s.project.teamId,
            key: s.project.key,
            name: s.project.name,
            icon: s.project.icon,
            color: s.project.color,
          })
          .from(s.project)
          .where(and(inArray(s.project.teamId, teamIds), isNull(s.project.deletedAt)))
          .orderBy(asc(s.project.name))
          .all();

  return {
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      username: user.username,
      displayUsername: user.displayUsername,
      name: user.name,
      image: user.image,
      theme: user.theme,
    },
    teams: teams.map((team) => {
      const membership = memberships.find((m) => m.teamId === team.id);
      return {
        id: team.id,
        slug: team.slug,
        name: team.name,
        icon: team.icon,
        color: team.color,
        isOwner: membership?.isOwner ?? false,
        permissions: membership?.permissions ?? [],
        pinned: sidebar.get(team.id)?.pinned ?? false,
        collapsed: sidebar.get(team.id)?.collapsed ?? false,
        projects: projects
          .filter((project) => project.teamId === team.id && access.has(project.id))
          .map(({ teamId: _teamId, ...project }) => ({
            ...project,
            permissions: access.get(project.id) ?? [],
          })),
      };
    }),
    unreadNotifications: unreadNotificationCount(deps, actor),
  };
}

interface SidebarPlace {
  position: number | null;
  pinned: boolean;
}

/** Pinned before unpinned, arranged before never arranged (stable: those keep the name order). */
function compareSidebar(a: SidebarPlace | undefined, b: SidebarPlace | undefined): number {
  const pinned = Number(b?.pinned ?? false) - Number(a?.pinned ?? false);
  if (pinned !== 0) return pinned;
  const left = a?.position ?? Number.POSITIVE_INFINITY;
  const right = b?.position ?? Number.POSITIVE_INFINITY;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Your other tabs and the desktop app refresh `me` (a personal event). */
function emitSidebarChanged(tx: Tx, userId: string): void {
  emitAfterCommit(tx, {
    type: 'me.updated',
    teamId: null,
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    userId,
  });
}

/**
 * `PUT /api/me/teams/order`: arranges your sidebar (BAT-36). `teamIds` lists every team you are in
 * exactly once, top first; pinned teams stay above the others whatever their place here. Personal,
 * so no team activity is recorded.
 */
export function reorderMyTeams(
  deps: AppDeps,
  actor: Actor,
  rawInput: ReorderMyTeamsInput,
): MeResponse {
  const input = reorderMyTeamsInputSchema.parse(rawInput);
  const { orm } = deps.db;
  const ids = input.teamIds;
  const known = new Set(listMemberships(orm, actor.userId).map((m) => m.teamId));
  if (
    ids.length !== known.size ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id))
  ) {
    throw errors.validation('List every one of your teams exactly once, top first');
  }
  deps.db.write((tx) => {
    ids.forEach((teamId, index) => {
      tx.update(s.teamMember)
        .set({ sidebarPosition: index })
        .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, actor.userId)))
        .run();
    });
    emitSidebarChanged(tx, actor.userId);
  });
  return getMe(deps, actor);
}

/** `PATCH /api/me/teams/:teamId`: pins a team to the top of your sidebar, or folds its projects. */
export function updateMyTeam(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  rawInput: UpdateMyTeamInput,
): MeResponse {
  const input = updateMyTeamInputSchema.parse(rawInput);
  requireMember(deps.db.orm, actor, teamId);
  deps.db.write((tx) => {
    tx.update(s.teamMember)
      .set({
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.collapsed !== undefined ? { sidebarCollapsed: input.collapsed } : {}),
      })
      .where(and(eq(s.teamMember.teamId, teamId), eq(s.teamMember.userId, actor.userId)))
      .run();
    emitSidebarChanged(tx, actor.userId);
  });
  return getMe(deps, actor);
}

const MENTIONABLE_LIMIT = 20;

/**
 * `@`-mention candidates in a team: members matching `q` (username or display name prefix/word)
 * and the roles the caller may mention — mentionable roles, or every role (and `@everyone`) with
 * `MENTION_EVERYONE`.
 */
export function listMentionables(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  query: MentionablesQuery,
): MentionablesResponse {
  const { orm } = deps.db;
  const membership = requireMember(orm, actor, teamId);
  if (query.usernames !== undefined || query.roles !== undefined) {
    return lookupMentionables(orm, teamId, query.usernames ?? [], query.roles ?? []);
  }
  const q = (query.q ?? '').trim().toLowerCase().slice(0, MAX_ANY_USERNAME_LENGTH);

  const users = orm
    .select(userSummaryColumns)
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(
      and(
        eq(s.teamMember.teamId, teamId),
        q ? or(likeContains(s.user.username, q), likeContains(s.user.name, q)) : undefined,
      ),
    )
    .orderBy(asc(s.user.username))
    .limit(MENTIONABLE_LIMIT)
    .all();

  const mentionAll = hasPermission(membership, 'MENTION_EVERYONE');
  const roles = orm
    .select()
    .from(s.role)
    .where(eq(s.role.teamId, teamId))
    .all()
    .filter((role) => (role.isEveryone || !role.mentionable ? mentionAll : true))
    .filter((role) => !q || role.slug.includes(q) || role.name.toLowerCase().includes(q))
    .sort((a, b) => b.position - a.position)
    .slice(0, MENTIONABLE_LIMIT)
    .map(toRoleSummary);

  return { users: toUserSummaries(orm, users), roles };
}

function toRoleSummary(role: typeof s.role.$inferSelect): RoleSummary {
  return { id: role.id, slug: role.slug, name: role.name, color: role.color };
}

/**
 * The members and roles named in a body, so mention chips can show names, hover cards and role
 * colors however large the team is. Every member can see every role, so roles are not filtered
 * by mentionability here.
 */
function lookupMentionables(
  db: DbExecutor,
  teamId: string,
  usernames: readonly string[],
  roleSlugs: readonly string[],
): MentionablesResponse {
  const users = usernames.length
    ? db
        .select(userSummaryColumns)
        .from(s.teamMember)
        .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
        .where(and(eq(s.teamMember.teamId, teamId), inArray(s.user.username, [...usernames])))
        .orderBy(asc(s.user.username))
        .all()
    : [];
  const roles = roleSlugs.length
    ? db
        .select()
        .from(s.role)
        .where(and(eq(s.role.teamId, teamId), inArray(s.role.slug, [...roleSlugs])))
        .all()
        .sort((a, b) => b.position - a.position)
        .map(toRoleSummary)
    : [];
  return { users: toUserSummaries(db, users), roles };
}
