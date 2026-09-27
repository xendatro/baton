import { and, eq, inArray } from 'drizzle-orm';
import type { Principal, PrincipalRule, PrincipalScope } from '@shared/principals';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';

/**
 * "Who" rules (docs/design/agents-and-pipelines.md §2): the resolver behind assignee pools, move
 * permissions, approvers, hand-offs and notify lists. A rule matches the current members of the
 * team who match any `allow` principal and no `deny` principal:
 *
 *   - `user`: that person or agent;
 *   - `role` (team role; `@everyone` = every member) and `project_role` (a role of `projectId`):
 *     `people` = people holding it, `agents` = agents holding it plus the agents of people holding
 *     it, `both` = either;
 *   - `everyone`: every member of the scope.
 *
 * Only current members of the team ever match: people who left or were removed, deleted accounts,
 * roles of other teams and project roles of other projects match nobody.
 */

export interface PrincipalContext {
  teamId: string;
  /** Needed by `project_role` principals; without it they match nobody. */
  projectId?: string | null;
}

interface MemberInfo {
  id: string;
  isAgent: boolean;
  /** The agent's owner (agents only). */
  ownerId: string | null;
}

/** The team's current members, keyed by id. */
function teamMembers(db: DbExecutor, teamId: string): Map<string, MemberInfo> {
  const rows = db
    .select({ id: s.user.id, kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(eq(s.teamMember.teamId, teamId))
    .all();
  return new Map(
    rows.map((row) => [
      row.id,
      { id: row.id, isAgent: row.kind === 'agent', ownerId: row.ownerId ?? null },
    ]),
  );
}

/** Members holding a team role (`@everyone`: everyone), or null if it isn't a role of the team. */
function teamRoleHolders(
  db: DbExecutor,
  ctx: PrincipalContext,
  roleId: string,
  members: ReadonlyMap<string, MemberInfo>,
): Set<string> {
  const role = db
    .select({ isEveryone: s.role.isEveryone })
    .from(s.role)
    .where(and(eq(s.role.id, roleId), eq(s.role.teamId, ctx.teamId)))
    .get();
  if (!role) return new Set();
  if (role.isEveryone) return new Set(members.keys());
  return new Set(
    db
      .select({ userId: s.memberRole.userId })
      .from(s.memberRole)
      .where(and(eq(s.memberRole.roleId, roleId), eq(s.memberRole.teamId, ctx.teamId)))
      .all()
      .map((row) => row.userId)
      .filter((id) => members.has(id)),
  );
}

/** Members holding a role of the context's project. */
function projectRoleHolders(
  db: DbExecutor,
  ctx: PrincipalContext,
  roleId: string,
  members: ReadonlyMap<string, MemberInfo>,
): Set<string> {
  if (!ctx.projectId) return new Set();
  const role = db
    .select({ id: s.projectRole.id })
    .from(s.projectRole)
    .innerJoin(s.project, eq(s.project.id, s.projectRole.projectId))
    .where(
      and(
        eq(s.projectRole.id, roleId),
        eq(s.projectRole.projectId, ctx.projectId),
        eq(s.project.teamId, ctx.teamId),
      ),
    )
    .get();
  if (!role) return new Set();
  return new Set(
    db
      .select({ userId: s.projectRoleMember.userId })
      .from(s.projectRoleMember)
      .where(eq(s.projectRoleMember.projectRoleId, roleId))
      .all()
      .map((row) => row.userId)
      .filter((id) => members.has(id)),
  );
}

/** Applies a scope to the holders of a role: people, agents (own or through their owner), both. */
function scoped(
  holders: ReadonlySet<string>,
  scope: PrincipalScope,
  members: ReadonlyMap<string, MemberInfo>,
): Set<string> {
  const result = new Set<string>();
  for (const member of members.values()) {
    const holds = holders.has(member.id);
    if (!member.isAgent) {
      if (scope !== 'agents' && holds) result.add(member.id);
      continue;
    }
    if (scope === 'people') continue;
    if (holds || (member.ownerId !== null && holders.has(member.ownerId))) result.add(member.id);
  }
  return result;
}

function principalMembers(
  db: DbExecutor,
  ctx: PrincipalContext,
  principal: Principal,
  members: ReadonlyMap<string, MemberInfo>,
): Set<string> {
  switch (principal.type) {
    case 'user':
      return members.has(principal.userId) ? new Set([principal.userId]) : new Set();
    case 'role':
      return scoped(teamRoleHolders(db, ctx, principal.roleId, members), principal.scope, members);
    case 'project_role':
      return scoped(
        projectRoleHolders(db, ctx, principal.roleId, members),
        principal.scope,
        members,
      );
    case 'everyone':
      return scoped(new Set(members.keys()), principal.scope, members);
  }
}

/** Ids of the team members `rule` matches (allow any, minus deny), in no particular order. */
export function expandRule(db: DbExecutor, ctx: PrincipalContext, rule: PrincipalRule): string[] {
  if (rule.allow.length === 0) return [];
  const members = teamMembers(db, ctx.teamId);
  const allowed = new Set<string>();
  for (const principal of rule.allow) {
    for (const id of principalMembers(db, ctx, principal, members)) allowed.add(id);
  }
  for (const principal of rule.deny) {
    for (const id of principalMembers(db, ctx, principal, members)) allowed.delete(id);
  }
  return [...allowed];
}

/** Does `rule` match `userId` (a current member of the team)? */
export function matchesRule(
  db: DbExecutor,
  ctx: PrincipalContext,
  userId: string,
  rule: PrincipalRule,
): boolean {
  if (rule.allow.length === 0) return false;
  const member = db
    .select({ id: s.user.id, kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.teamMember)
    .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
    .where(and(eq(s.teamMember.teamId, ctx.teamId), eq(s.teamMember.userId, userId)))
    .get();
  if (!member) return false;
  // Only the user and (for agents) their owner matter: load just those two.
  const ids = [userId, ...(member.kind === 'agent' && member.ownerId ? [member.ownerId] : [])];
  const members = new Map(
    db
      .select({ id: s.user.id, kind: s.user.kind, ownerId: s.user.agentOwnerId })
      .from(s.teamMember)
      .innerJoin(s.user, eq(s.user.id, s.teamMember.userId))
      .where(and(eq(s.teamMember.teamId, ctx.teamId), inArray(s.teamMember.userId, ids)))
      .all()
      .map((row): [string, MemberInfo] => [
        row.id,
        { id: row.id, isAgent: row.kind === 'agent', ownerId: row.ownerId ?? null },
      ]),
  );
  const hits = (principal: Principal) => principalMembers(db, ctx, principal, members).has(userId);
  return rule.allow.some(hits) && !rule.deny.some(hits);
}
