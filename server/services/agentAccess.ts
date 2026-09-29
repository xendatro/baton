import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Principal, PrincipalRule } from '@shared/principals';
import {
  agentAccessRulesSchema,
  DEFAULT_AGENT_ACCESS,
  type AgentAccess,
  type AgentAccessLevel,
  type AgentAccessRules,
  type ProjectAgentAccess,
  type SetProjectAgentAccessInput,
} from '@shared/schemas/agentAccess';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { memberTeamIds, requireMember } from './access';
import { findAgentId, personActor } from './agents';
import { emitEvent } from './events';
import { matchesRule } from './principals';
import { requireProject } from './projects';

/**
 * Agent access (who can start your agent): per team a default, per project an optional override
 * that replaces it there, else the built-in default (only you start it; every person and agent
 * may ask). For whoever caused a job:
 *
 *   1. you (the owner) and your own agent: `auto`, always (they can't be demoted);
 *   2. a person or agent named directly in a list: that list (a direct entry beats roles);
 *   3. matched by `auto` (its include minus its exclude): `auto`;
 *   4. matched by `ask`: `ask`;
 *   5. anyone else: `none` (their jobs aren't queued).
 *
 * Jobs nobody caused (system sources: a sign-off's result, a job's own bookkeeping) are `auto`:
 * they follow from something the owner or the team already allowed.
 */

type Rules = AgentAccessRules;

/** Stored rules, read defensively (a row from before a schema change falls back to defaults). */
function parseRules(value: unknown): Rules | null {
  const parsed = agentAccessRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function teamDefaultRow(db: DbExecutor, ownerId: string, teamId: string): Rules | null {
  const row = db
    .select({ rules: s.agentAccess.rules })
    .from(s.agentAccess)
    .where(
      and(
        eq(s.agentAccess.ownerId, ownerId),
        eq(s.agentAccess.teamId, teamId),
        isNull(s.agentAccess.projectId),
      ),
    )
    .get();
  return row ? parseRules(row.rules) : null;
}

function projectRow(db: DbExecutor, ownerId: string, projectId: string): Rules | null {
  const row = db
    .select({ rules: s.agentAccess.rules })
    .from(s.agentAccess)
    .where(and(eq(s.agentAccess.ownerId, ownerId), eq(s.agentAccess.projectId, projectId)))
    .get();
  return row ? parseRules(row.rules) : null;
}

export type AccessSource = 'project' | 'team' | 'default';

/** The rules in force for the owner's agent in a project: override → team default → built-in. */
export function accessRulesFor(
  db: DbExecutor,
  ownerId: string,
  place: { teamId: string; projectId?: string | null },
): { rules: Rules; source: AccessSource } {
  const project = place.projectId ? projectRow(db, ownerId, place.projectId) : null;
  if (project) return { rules: project, source: 'project' };
  const team = teamDefaultRow(db, ownerId, place.teamId);
  if (team) return { rules: team, source: 'team' };
  return { rules: DEFAULT_AGENT_ACCESS, source: 'default' };
}

function namesUser(rule: PrincipalRule, userId: string): boolean {
  return rule.allow.some((principal) => principal.type === 'user' && principal.userId === userId);
}

function excludesUser(rule: PrincipalRule, userId: string): boolean {
  return rule.deny.some((principal) => principal.type === 'user' && principal.userId === userId);
}

/** How `userId` (null: a system source) may start the owner's agent in the project. */
export function agentAccessLevel(
  db: DbExecutor,
  agent: { id: string; ownerId: string },
  place: { teamId: string; projectId?: string | null },
  userId: string | null,
): AgentAccessLevel {
  if (userId === null || userId === agent.ownerId || userId === agent.id) return 'auto';
  const { rules } = accessRulesFor(db, agent.ownerId, place);
  if (namesUser(rules.auto, userId) && !excludesUser(rules.auto, userId)) return 'auto';
  if (namesUser(rules.ask, userId) && !excludesUser(rules.ask, userId)) return 'ask';
  const ctx = { teamId: place.teamId, projectId: place.projectId ?? null };
  if (matchesRule(db, ctx, userId, rules.auto)) return 'auto';
  if (matchesRule(db, ctx, userId, rules.ask)) return 'ask';
  return 'none';
}

// ---------------------------------------------------------------------------------------------
// Settings: GET /api/me/agent/access, PUT /api/me/agent/access/teams/:teamId,
// GET|PUT /api/projects/:projectId/me/agent-access
// ---------------------------------------------------------------------------------------------

/**
 * Leaves out the owner and their own agent (they always start it) and keeps each principal in one
 * list (`agentAccessRulesSchema` rejects both; this is for rules read back).
 */
function sanitize(rules: Rules, ownerId: string, agentId: string | null): Rules {
  const self = (principal: Principal) =>
    principal.type === 'user' && (principal.userId === ownerId || principal.userId === agentId);
  const clean = (rule: PrincipalRule): PrincipalRule => ({
    allow: rule.allow.filter((principal) => !self(principal)),
    deny: rule.deny.filter((principal) => !self(principal)),
  });
  return { auto: clean(rules.auto), ask: clean(rules.ask) };
}

function validRules(input: unknown): Rules {
  const parsed = agentAccessRulesSchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation(parsed.error.issues[0]?.message ?? 'Invalid agent access', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** The person behind the actor (a key acts for its owner). */
function ownerOf(deps: AppDeps, actor: Actor): { ownerId: string; agentId: string | null } {
  const person = personActor(actor);
  const user = deps.db.orm
    .select({ kind: s.user.kind })
    .from(s.user)
    .where(eq(s.user.id, person.userId))
    .get();
  if (user?.kind !== 'human') throw errors.forbidden('Only people have agent settings');
  return { ownerId: person.userId, agentId: findAgentId(deps.db.orm, person.userId) };
}

function accessChanged(deps: AppDeps, ownerId: string, teamId: string | null) {
  emitEvent(deps, {
    type: 'agent_job.changed',
    teamId,
    entityType: 'agent_job',
    entityId: ownerId,
    actorId: ownerId,
    userId: ownerId,
  });
}

/** Your team defaults, one per team you belong to (the built-in default where nothing is set). */
export function getAgentAccess(deps: AppDeps, actor: Actor): AgentAccess {
  const owner = ownerOf(deps, actor);
  const { orm } = deps.db;
  const teamIds = memberTeamIds(orm, owner.ownerId);
  if (teamIds.length === 0) return { teams: [] };
  const teams = orm
    .select({ id: s.team.id, name: s.team.name, slug: s.team.slug })
    .from(s.team)
    .where(inArray(s.team.id, teamIds))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    teams: teams.map((team) => {
      const saved = teamDefaultRow(orm, owner.ownerId, team.id);
      return {
        teamId: team.id,
        teamName: team.name,
        teamSlug: team.slug,
        rules: sanitize(saved ?? DEFAULT_AGENT_ACCESS, owner.ownerId, owner.agentId),
        isDefault: saved === null,
      };
    }),
  };
}

/** Replaces your team default for one team. */
export function setTeamAgentAccess(
  deps: AppDeps,
  actor: Actor,
  teamId: string,
  input: { rules: unknown },
): AgentAccess['teams'][number] {
  const owner = ownerOf(deps, actor);
  requireMember(deps.db.orm, personActor(actor), teamId);
  const rules = sanitize(validRules(input.rules), owner.ownerId, owner.agentId);
  const now = new Date();
  deps.db.write((tx) => {
    tx.delete(s.agentAccess)
      .where(
        and(
          eq(s.agentAccess.ownerId, owner.ownerId),
          eq(s.agentAccess.teamId, teamId),
          isNull(s.agentAccess.projectId),
        ),
      )
      .run();
    tx.insert(s.agentAccess)
      .values({ ownerId: owner.ownerId, teamId, projectId: null, rules, updatedAt: now })
      .run();
  });
  accessChanged(deps, owner.ownerId, teamId);
  const team = getAgentAccess(deps, actor).teams.find((entry) => entry.teamId === teamId);
  if (!team) throw errors.notFound('Team');
  return team;
}

export function getProjectAgentAccess(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
): ProjectAgentAccess {
  const owner = ownerOf(deps, actor);
  const { project } = requireProject(deps.db.orm, personActor(actor), projectId);
  const override = projectRow(deps.db.orm, owner.ownerId, project.id);
  return {
    projectId: project.id,
    teamId: project.teamId,
    override: override ? sanitize(override, owner.ownerId, owner.agentId) : null,
    teamDefault: sanitize(
      teamDefaultRow(deps.db.orm, owner.ownerId, project.teamId) ?? DEFAULT_AGENT_ACCESS,
      owner.ownerId,
      owner.agentId,
    ),
  };
}

/** Sets (or, with `override: null`, removes: "Use team default") your override in a project. */
export function setProjectAgentAccess(
  deps: AppDeps,
  actor: Actor,
  projectId: string,
  input: SetProjectAgentAccessInput,
): ProjectAgentAccess {
  const owner = ownerOf(deps, actor);
  const { project } = requireProject(deps.db.orm, personActor(actor), projectId);
  const rules =
    input.override === null
      ? null
      : sanitize(validRules(input.override), owner.ownerId, owner.agentId);
  deps.db.write((tx) => {
    tx.delete(s.agentAccess)
      .where(and(eq(s.agentAccess.ownerId, owner.ownerId), eq(s.agentAccess.projectId, project.id)))
      .run();
    if (rules) {
      tx.insert(s.agentAccess)
        .values({
          ownerId: owner.ownerId,
          teamId: project.teamId,
          projectId: project.id,
          rules,
          updatedAt: new Date(),
        })
        .run();
    }
  });
  accessChanged(deps, owner.ownerId, project.teamId);
  return getProjectAgentAccess(deps, actor, project.id);
}
