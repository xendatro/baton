import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { LIMITS } from '@shared/constants';
import type {
  MeResponse,
  MentionablesQuery,
  MentionablesResponse,
  RoleSummary,
  UserSummary,
  ViaKey,
} from '@shared/schemas/core';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
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
import { unreadNotificationCount } from './notifications';

type UserRow = typeof s.user.$inferSelect;

export function toUserSummary(
  user: Pick<UserRow, 'id' | 'username' | 'name' | 'image'>,
): UserSummary {
  return { id: user.id, username: user.username ?? '', name: user.name, image: user.image };
}

/** Summaries of the given users, keyed by id (missing ids are deleted accounts). */
export function getUserSummaries(
  db: DbExecutor,
  ids: Iterable<string | null | undefined>,
): Map<string, UserSummary> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = db
    .select({ id: s.user.id, username: s.user.username, name: s.user.name, image: s.user.image })
    .from(s.user)
    .where(inArray(s.user.id, unique))
    .all();
  return new Map(rows.map((row) => [row.id, toUserSummary(row)]));
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
  const teams =
    teamIds.length === 0
      ? []
      : orm
          .select()
          .from(s.team)
          .where(inArray(s.team.id, teamIds))
          .orderBy(asc(s.team.name))
          .all();
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
  const q = (query.q ?? '').trim().toLowerCase().slice(0, LIMITS.username.max);

  const users = orm
    .select({ id: s.user.id, username: s.user.username, name: s.user.name, image: s.user.image })
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

  return { users: users.map(toUserSummary), roles };
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
        .select({
          id: s.user.id,
          username: s.user.username,
          name: s.user.name,
          image: s.user.image,
        })
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
  return { users: users.map(toUserSummary), roles };
}
