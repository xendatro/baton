import { and, eq, inArray, isNull, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AgentSettings, UpdateAgentSettingsInput } from '@shared/schemas/account';
import { AGENT_EMAIL_DOMAIN, agentDisplayName, agentUsername } from '@shared/principals';
import type { Actor, AppDeps } from '../context';
import type { Database, DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { recordActivity } from './activity';
import { emitAfterCommit } from './events';
import { getUserSummaries } from './users';

/**
 * Agent members (docs/design/agents-and-pipelines.md §1). Every person has exactly one agent: a
 * `user` row with `kind = 'agent'` and `agent_owner_id = <person>`, named after its owner
 * (`ethan-ai`, "Ethan AI"), with an address that is never mailed and no way to sign in. API keys
 * act as it. Its team memberships mirror its owner's; its permissions are capped by the owner's
 * (`access.ts`); the owner, a team or a project can pause it.
 */

type UserRow = typeof s.user.$inferSelect;

/** The agent member of `ownerId`, or null (none yet, or `ownerId` is itself an agent). */
export function findAgentId(db: DbExecutor, ownerId: string): string | null {
  return (
    db.select({ id: s.user.id }).from(s.user).where(eq(s.user.agentOwnerId, ownerId)).get()?.id ??
    null
  );
}

/** The profile an agent takes from its owner: `<username>-ai`, "<Name> AI". */
function agentProfile(owner: Pick<UserRow, 'name' | 'username' | 'displayUsername'>) {
  return {
    name: agentDisplayName(owner.name),
    username: owner.username ? agentUsername(owner.username) : null,
    displayUsername: owner.username ? agentUsername(owner.displayUsername ?? owner.username) : null,
  };
}

/**
 * Creates the agent member of `ownerId` inside the caller's transaction, unless it exists; returns
 * its id. A new agent joins every team its owner is in (with no roles). Idempotent; the agent of
 * an agent or of a missing user is an error.
 */
export function ensureAgentIn(tx: Tx, ownerId: string): string {
  const existing = findAgentId(tx, ownerId);
  if (existing) return existing;
  const owner = tx.select().from(s.user).where(eq(s.user.id, ownerId)).get();
  if (!owner) throw new Error(`ensureAgent: user ${ownerId} does not exist`);
  if (owner.kind !== 'human') throw new Error(`ensureAgent: ${ownerId} is not a person`);
  const id = newId();
  const now = new Date();
  tx.insert(s.user)
    .values({
      id,
      ...agentProfile(owner),
      email: `${id.toLowerCase()}@${AGENT_EMAIL_DOMAIN}`,
      emailVerified: true,
      image: null,
      kind: 'agent',
      agentOwnerId: ownerId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const teamIds = tx
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .where(eq(s.teamMember.userId, ownerId))
    .all()
    .map((row) => row.teamId);
  if (teamIds.length > 0) {
    tx.insert(s.teamMember)
      .values(teamIds.map((teamId) => ({ teamId, userId: id, joinedAt: now })))
      .onConflictDoNothing()
      .run();
    for (const teamId of teamIds) {
      emitAfterCommit(tx, {
        type: 'member.joined',
        teamId,
        entityType: 'member',
        entityId: id,
        actorId: null,
      });
    }
  }
  return id;
}

/** `ensureAgentIn` in a transaction of its own (a read when the agent exists). */
export function ensureAgent(db: Database, ownerId: string): string {
  return findAgentId(db.orm, ownerId) ?? db.write((tx) => ensureAgentIn(tx, ownerId));
}

/**
 * Creates the missing agent of every person (existing accounts when agents were introduced, or
 * any account created without one). Runs after the migrations at startup and in
 * `npm run db:migrate`; returns how many agents it created. Idempotent.
 */
export function backfillAgents(db: Database): number {
  const agent = alias(s.user, 'agent');
  const missing = db.orm
    .select({ id: s.user.id })
    .from(s.user)
    .where(
      and(
        eq(s.user.kind, 'human'),
        notExists(
          db.orm.select({ id: agent.id }).from(agent).where(eq(agent.agentOwnerId, s.user.id)),
        ),
      ),
    )
    .all();
  if (missing.length === 0) return 0;
  db.write((tx) => {
    for (const { id } of missing) ensureAgentIn(tx, id);
  });
  return missing.length;
}

/**
 * Keeps the agent's name and username in step with its owner's (after a profile change or an
 * OAuth user picking a username). No-op without an agent or when nothing changed.
 */
export function syncAgentProfile(tx: Tx, ownerId: string): void {
  const owner = tx.select().from(s.user).where(eq(s.user.id, ownerId)).get();
  if (!owner || owner.kind !== 'human') return;
  const agent = tx.select().from(s.user).where(eq(s.user.agentOwnerId, ownerId)).get();
  if (!agent) return;
  const next = agentProfile(owner);
  if (
    agent.name === next.name &&
    agent.username === next.username &&
    agent.displayUsername === next.displayUsername
  ) {
    return;
  }
  tx.update(s.user)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(s.user.id, agent.id))
    .run();
  const teamIds = tx
    .select({ teamId: s.teamMember.teamId })
    .from(s.teamMember)
    .where(eq(s.teamMember.userId, agent.id))
    .all();
  for (const { teamId } of teamIds) {
    emitAfterCommit(tx, {
      type: 'member.updated',
      teamId,
      entityType: 'member',
      entityId: agent.id,
      actorId: ownerId,
    });
  }
}

/**
 * Mirrors a person joining a team (invite, team creation, restore…): their agent joins too, with
 * no roles. Returns the agent's id when it was added. Call in the join's transaction.
 */
export function addAgentMembership(
  tx: Tx,
  teamId: string,
  ownerId: string,
  joinedAt: Date = new Date(),
): string | null {
  const agentId = findAgentId(tx, ownerId);
  if (!agentId) return null;
  const added = tx
    .insert(s.teamMember)
    .values({ teamId, userId: agentId, joinedAt })
    .onConflictDoNothing()
    .run();
  if (added.changes === 0) return null;
  emitAfterCommit(tx, {
    type: 'member.joined',
    teamId,
    entityType: 'member',
    entityId: agentId,
    actorId: null,
  });
  return agentId;
}

/** Is `userId` an agent member? And whose? */
export function agentOwnerOf(db: DbExecutor, userId: string): string | null {
  const row = db
    .select({ kind: s.user.kind, ownerId: s.user.agentOwnerId })
    .from(s.user)
    .where(eq(s.user.id, userId))
    .get();
  return row?.kind === 'agent' ? row.ownerId : null;
}

/**
 * The actor and their counterpart (agents A): a person and their agent member count as one
 * author, so either may use or see the other's pending uploads, edit what the other wrote, …
 */
export function selfIdsOf(db: DbExecutor, actor: Pick<Actor, 'userId' | 'ownerId'>): string[] {
  const counterpart = actor.ownerId ?? findAgentId(db, actor.userId);
  return counterpart ? [actor.userId, counterpart] : [actor.userId];
}

/** Which of `userIds` are agent members. */
export function agentIdsAmong(db: DbExecutor, userIds: readonly string[]): Set<string> {
  if (userIds.length === 0) return new Set();
  return new Set(
    db
      .select({ id: s.user.id })
      .from(s.user)
      .where(and(inArray(s.user.id, [...userIds]), eq(s.user.kind, 'agent')))
      .all()
      .map((row) => row.id),
  );
}

// ---------------------------------------------------------------------------------------------
// Pause / kill switch
// ---------------------------------------------------------------------------------------------

/**
 * Why an agent member may not write in the given team and project right now, or null: its owner
 * paused it, or the team or project paused all agents.
 */
export function agentPauseReason(
  db: DbExecutor,
  agent: { agentId: string; ownerId: string },
  teamId: string | null | undefined,
  projectId?: string | null,
): string | null {
  const owner = db
    .select({ name: s.user.name, pausedAt: s.user.agentPausedAt })
    .from(s.user)
    .where(eq(s.user.id, agent.ownerId))
    .get();
  if (owner?.pausedAt) {
    return `${owner.name} paused this agent. They can resume it in Settings → Agent.`;
  }
  if (teamId) {
    const team = db
      .select({ name: s.team.name, pausedAt: s.team.agentsPausedAt })
      .from(s.team)
      .where(eq(s.team.id, teamId))
      .get();
    if (team?.pausedAt) {
      return `Agents are paused in ${team.name}. Someone who can manage the team can resume them in its settings.`;
    }
  }
  if (projectId) {
    const project = db
      .select({ name: s.project.name, pausedAt: s.project.agentsPausedAt })
      .from(s.project)
      .where(eq(s.project.id, projectId))
      .get();
    if (project?.pausedAt) {
      return `Agents are paused in ${project.name}. Someone who can manage projects can resume them in its settings.`;
    }
  }
  return null;
}

/**
 * Refuses (423 `agents_paused`) a write by an agent actor that is paused, in a team or project
 * where agents are paused. People are never affected. `recordActivity` calls it for every
 * mutation, so the change rolls back with the refusal.
 */
export function assertAgentsNotPaused(
  db: DbExecutor,
  actor: Actor | null,
  teamId: string | null | undefined,
  projectId?: string | null,
): void {
  if (!actor?.ownerId) return;
  const reason = agentPauseReason(
    db,
    { agentId: actor.userId, ownerId: actor.ownerId },
    teamId,
    projectId,
  );
  if (reason) throw errors.agentsPaused(reason);
}

// ---------------------------------------------------------------------------------------------
// Settings: GET|PATCH /api/me/agent
// ---------------------------------------------------------------------------------------------

function requirePerson(actor: Actor): void {
  if (actor.ownerId) {
    throw errors.forbidden('Only its owner can change an agent’s settings, in the web app');
  }
}

/** The signed-in person's agent and its settings (pause, notifications). */
export function getAgentSettings(deps: AppDeps, actor: Actor): AgentSettings {
  requirePerson(actor);
  const agentId = ensureAgent(deps.db, actor.userId);
  const owner = deps.db.orm.select().from(s.user).where(eq(s.user.id, actor.userId)).get();
  if (!owner) throw errors.unauthorized();
  const agent = getUserSummaries(deps.db.orm, [agentId]).get(agentId);
  if (!agent) throw errors.notFound('Agent');
  return {
    agent,
    pausedAt: owner.agentPausedAt?.toISOString() ?? null,
    notifications: owner.agentNotifications,
  };
}

/** Pauses or resumes the agent, or changes how much of its activity reaches the inbox. */
export function updateAgentSettings(
  deps: AppDeps,
  actor: Actor,
  input: UpdateAgentSettingsInput,
): AgentSettings {
  requirePerson(actor);
  const before = getAgentSettings(deps, actor);
  const pausedChanged = input.paused !== undefined && input.paused !== (before.pausedAt !== null);
  const levelChanged =
    input.notifications !== undefined && input.notifications !== before.notifications;
  if (!pausedChanged && !levelChanged) return before;
  deps.db.write((tx) => {
    tx.update(s.user)
      .set({
        ...(pausedChanged ? { agentPausedAt: input.paused ? new Date() : null } : {}),
        ...(levelChanged ? { agentNotifications: input.notifications } : {}),
      })
      .where(and(eq(s.user.id, actor.userId), isNull(s.user.agentOwnerId)))
      .run();
    // The owner's security log: pausing is a safety switch worth a trace.
    recordActivity(tx, actor, {
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      action: 'user.agent_settings_changed',
      changes: {
        ...(pausedChanged
          ? { agentPaused: { from: before.pausedAt !== null, to: Boolean(input.paused) } }
          : {}),
        ...(levelChanged
          ? { agentNotifications: { from: before.notifications, to: input.notifications } }
          : {}),
      },
      meta: { agent: before.agent.username },
    });
    emitAfterCommit(tx, {
      type: 'me.updated',
      teamId: null,
      entityType: 'user',
      entityId: actor.userId,
      actorId: actor.userId,
      userId: actor.userId,
    });
  });
  return getAgentSettings(deps, actor);
}

/**
 * The person behind an actor: the actor itself, or for an agent member its owner acting through
 * the same key. Account-level operations through a key (the profile, the security log) are the
 * person's, as before agents A, and are logged in their security log "via" the key.
 */
export function personActor(actor: Actor): Actor {
  if (!actor.ownerId) return actor;
  return { userId: actor.ownerId, source: actor.source, key: actor.key };
}
