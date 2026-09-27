import { and, eq, inArray } from 'drizzle-orm';
import {
  AGENT_ACTION_REQUEST_TTL_DAYS,
  OWNER_ONLY_AGENT_ACTIONS,
  type AgentAction,
} from '@shared/constants';
import type { PendingApprovalResponse } from '@shared/schemas/agentActions';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { PendingApproval } from '../lib/errors';
import { newId } from '../lib/ids';
import { queueJobs } from './agentJobs';
import { assertAgentsNotPaused } from './agents';
import { emitAfterCommit } from './events';
import { notifyUsers } from './notifications';

/**
 * Human sign-off for agents' destructive actions (docs/design/agents-and-pipelines.md §6).
 *
 * Every destructive service (delete a task, remove a member, …) calls `requireSignoff` once its
 * own checks passed, just before it changes anything. For people it does nothing. For an agent
 * member in a team whose "Agents need human sign-off" is on, it stores an `agent_action_request`,
 * notifies the agent's owner (always, whatever their agent notification level) and throws
 * `PendingApproval`, which REST answers with `202` and MCP with a normal tool result. When the
 * owner approves, `agentActions.ts` runs the same service again with an actor marked approved
 * here, so the service's checks run again and this time the change goes through.
 */

export type AgentActionRequestRow = typeof s.agentActionRequest.$inferSelect;

export const AGENT_ACTION_REQUEST_TTL_MS = AGENT_ACTION_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Actors running an approved request: `requireSignoff` lets them through. */
const approvedActors = new WeakSet<Actor>();

/** A copy of `actor` that `requireSignoff` lets through (running an approved request). */
export function approvedActor(actor: Actor): Actor {
  const copy: Actor = { ...actor };
  approvedActors.add(copy);
  return copy;
}

/** What the agent wants to do, as the destructive service describes it. */
export interface SignoffRequest {
  action: AgentAction;
  teamId: string;
  projectId?: string | null;
  /** The action's arguments (ids), which the action's executor runs again once approved. */
  input: Record<string, unknown>;
  /** `delete BAT-12 “Fix login”`, read as "Ethan AI wants to delete BAT-12 “Fix login”". */
  summary: string;
  /** App URL of the target (relative), for the notification; defaults to Settings → Agent. */
  url?: string | null;
}

/** Does the team want its agents' destructive actions signed off? (Default on.) */
export function teamWantsSignoff(db: DbExecutor, teamId: string): boolean {
  const row = db
    .select({ agentSignoff: s.team.agentSignoff })
    .from(s.team)
    .where(eq(s.team.id, teamId))
    .get();
  return row?.agentSignoff ?? true;
}

/**
 * Lets people and approved runs through; for an agent member whose team wants sign-off (and
 * always for owner-only actions, which an agent can never take itself), stores the request,
 * notifies the owner and throws `PendingApproval`. Call it after the service's own checks and
 * before it changes anything, outside any transaction.
 */
export function requireSignoff(deps: AppDeps, actor: Actor, request: SignoffRequest): void {
  if (!actor.ownerId || approvedActors.has(actor)) return;
  if (
    !OWNER_ONLY_AGENT_ACTIONS.has(request.action) &&
    !teamWantsSignoff(deps.db.orm, request.teamId)
  ) {
    return;
  }
  throw new PendingApproval(
    createActionRequest(deps, actor, { ...request, ownerId: actor.ownerId }),
  );
}

/** An identical request of the same agent that is still waiting, if any (asking twice). */
function findPending(
  tx: Tx,
  agentUserId: string,
  request: SignoffRequest,
  now: Date,
): AgentActionRequestRow | undefined {
  const input = JSON.stringify(request.input);
  return tx
    .select()
    .from(s.agentActionRequest)
    .where(
      and(
        eq(s.agentActionRequest.agentUserId, agentUserId),
        eq(s.agentActionRequest.action, request.action),
        eq(s.agentActionRequest.status, 'pending'),
      ),
    )
    .all()
    .find(
      (row) =>
        JSON.stringify(row.payload.input) === input &&
        row.createdAt.getTime() + AGENT_ACTION_REQUEST_TTL_MS > now.getTime(),
    );
}

function pendingMessage(ownerName: string, summary: string, requestId: string): string {
  return (
    `Nothing changed yet: ${ownerName} has to approve this (${summary}) in Baton first. ` +
    `They have been notified. Check the outcome with get_action_request { id: "${requestId}" } ` +
    `(REST: GET /api/agent-actions/${requestId}); pending requests expire after ` +
    `${AGENT_ACTION_REQUEST_TTL_DAYS} days.`
  );
}

function createActionRequest(
  deps: AppDeps,
  actor: Actor,
  request: SignoffRequest & { ownerId: string },
): PendingApprovalResponse {
  const names = new Map(
    deps.db.orm
      .select({ id: s.user.id, name: s.user.name })
      .from(s.user)
      .where(inArray(s.user.id, [actor.userId, request.ownerId]))
      .all()
      .map((row) => [row.id, row.name]),
  );
  const agentName = names.get(actor.userId) ?? 'Your agent';
  const ownerName = names.get(request.ownerId) ?? 'Its owner';
  const now = new Date();
  const row = deps.db.write((tx) => {
    // A paused agent can't even ask (its owner, team or project stopped it).
    assertAgentsNotPaused(tx, actor, request.teamId, request.projectId);
    const existing = findPending(tx, actor.userId, request, now);
    if (existing) return existing;
    const created = tx
      .insert(s.agentActionRequest)
      .values({
        id: newId(),
        teamId: request.teamId,
        projectId: request.projectId ?? null,
        agentUserId: actor.userId,
        ownerId: request.ownerId,
        action: request.action,
        payload: { input: request.input, summary: request.summary, url: request.url ?? null },
        source: actor.source,
        viaKeyId: actor.key?.id ?? null,
        viaKeyName: actor.key?.name ?? null,
        viaAgentName: actor.key?.agentName ?? null,
        status: 'pending',
        createdAt: now,
      })
      .returning()
      .get();
    notifyUsers(
      tx,
      actor,
      'agent_action_request',
      [request.ownerId],
      {
        teamId: request.teamId,
        entityType: 'agent_action_request',
        entityId: created.id,
        title: `${agentName} wants to ${request.summary}`,
        url: request.url ?? '/settings/agent',
      },
      new Set(),
      { always: true },
    );
    emitActionRequestChanged(tx, created, actor.userId);
    return created;
  });
  return {
    pendingApproval: true,
    requestId: row.id,
    message: pendingMessage(ownerName, row.payload.summary, row.id),
  };
}

/** The personal live event that refreshes the owner's inbox row and pending list. */
export function emitActionRequestChanged(
  tx: Tx,
  row: AgentActionRequestRow,
  actorId: string | null,
): void {
  emitAfterCommit(tx, {
    type: 'agent_action.changed',
    teamId: row.teamId,
    projectId: row.projectId,
    entityType: 'agent_action',
    entityId: row.id,
    actorId,
    userId: row.ownerId,
  });
}

/**
 * Called in the transaction that settles a request (approved and run, failed, denied or expired).
 * Wave 2C wires it to queue an `action_result` job for the agent (design §4); a no-op until then.
 */
export function onActionRequestResolved(tx: Tx, request: AgentActionRequestRow): void {
  // The agent hears the outcome through its listener (design §4 `action_result`). Team-level
  // requests have no project, and jobs are per project: those are read with get_action_request.
  if (!request.projectId) return;
  queueJobs(tx, [
    {
      agentUserId: request.agentUserId,
      teamId: request.teamId,
      projectId: request.projectId,
      kind: 'action_result',
      targetType: 'action_request',
      targetId: request.id,
      payload: { action: request.action, status: request.status },
    },
  ]);
}
