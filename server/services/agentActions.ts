import { and, desc, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { OWNER_ONLY_AGENT_ACTIONS, type AgentAction } from '@shared/constants';
import type {
  AgentActionListQuery,
  AgentActionListResponse,
  AgentActionRequest,
} from '@shared/schemas/agentActions';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor, Tx } from '../db';
import * as s from '../db/schema';
import { errors, isAppError, isPendingApproval } from '../lib/errors';
import { deleteAttachment } from './attachments';
import { emitAfterCommit } from './events';
import { revokeInvite } from './invites';
import { deleteIssue } from './issues';
import { deleteLabel } from './labels';
import { removeMember } from './members';
import { deleteProject } from './projects';
import { deleteReply } from './replies';
import { deleteRole } from './roles';
import {
  AGENT_ACTION_REQUEST_TTL_MS,
  approvedActor,
  emitActionRequestChanged,
  onActionRequestResolved,
  type AgentActionRequestRow,
} from './signoff';
import { deleteStatus } from './statuses';
import { deleteTask } from './tasks';
import { deleteTeam, restoreTeam, transferOwnership } from './teams';
import { getUserSummaries } from './users';

/**
 * Agent action requests (docs/design/agents-and-pipelines.md §6): the owner's list, approve and
 * deny, the agent's view of its own requests, and the expiry job. `signoff.ts` creates them.
 *
 * Only the agent's owner decides, in the web app (not through an API key: that would be the
 * agent approving itself). On approval the action runs again through its own service, so every
 * check (membership, permissions, pauses, the target still existing) is made again at that time:
 * as the agent (with the key it asked through) for most actions, as the owner for owner-only ones.
 */

// ---------------------------------------------------------------------------------------------
// Executors: how each action runs again from its stored input
// ---------------------------------------------------------------------------------------------

interface Executor {
  run(deps: AppDeps, actor: Actor, input: unknown): unknown;
}

function executor<Schema extends z.ZodType>(
  schema: Schema,
  run: (deps: AppDeps, actor: Actor, input: z.output<Schema>) => unknown,
): Executor {
  return { run: (deps, actor, input) => run(deps, actor, schema.parse(input)) };
}

const id = z.string().min(1);

const EXECUTORS: Readonly<Record<AgentAction, Executor>> = {
  delete_task: executor(z.object({ taskId: id }), (deps, actor, input) =>
    deleteTask(deps, actor, input.taskId),
  ),
  delete_issue: executor(z.object({ issueId: id }), (deps, actor, input) =>
    deleteIssue(deps, actor, input.issueId),
  ),
  delete_project: executor(z.object({ projectId: id }), (deps, actor, input) =>
    deleteProject(deps, actor, input.projectId),
  ),
  delete_status: executor(z.object({ statusId: id, moveTo: id }), (deps, actor, input) =>
    deleteStatus(deps, actor, input.statusId, { moveTo: input.moveTo }),
  ),
  delete_label: executor(z.object({ labelId: id }), (deps, actor, input) =>
    deleteLabel(deps, actor, input.labelId),
  ),
  delete_reply: executor(z.object({ replyId: id }), (deps, actor, input) =>
    deleteReply(deps, actor, input.replyId),
  ),
  delete_attachment: executor(z.object({ attachmentId: id }), (deps, actor, input) =>
    deleteAttachment(deps, actor, input.attachmentId),
  ),
  delete_role: executor(z.object({ teamId: id, roleId: id }), (deps, actor, input) =>
    deleteRole(deps, actor, input.teamId, input.roleId),
  ),
  remove_member: executor(z.object({ teamId: id, userId: id }), (deps, actor, input) =>
    removeMember(deps, actor, input.teamId, input.userId),
  ),
  revoke_invite: executor(z.object({ teamId: id, inviteId: id }), (deps, actor, input) =>
    revokeInvite(deps, actor, input.teamId, input.inviteId),
  ),
  delete_team: executor(z.object({ teamId: id }), (deps, actor, input) =>
    deleteTeam(deps, actor, input.teamId),
  ),
  restore_team: executor(z.object({ teamId: id }), (deps, actor, input) =>
    restoreTeam(deps, actor, input.teamId),
  ),
  transfer_team_ownership: executor(z.object({ teamId: id, userId: id }), (deps, actor, input) =>
    transferOwnership(deps, actor, input.teamId, { userId: input.userId }),
  ),
};

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

function expiresAt(row: AgentActionRequestRow): Date {
  return new Date(row.createdAt.getTime() + AGENT_ACTION_REQUEST_TTL_MS);
}

/** Pending past its expiry (the hourly job may not have marked it yet). */
function isOverdue(row: AgentActionRequestRow, now: Date): boolean {
  return row.status === 'pending' && expiresAt(row).getTime() <= now.getTime();
}

function toRequests(
  db: DbExecutor,
  rows: readonly AgentActionRequestRow[],
  now: Date = new Date(),
): AgentActionRequest[] {
  if (rows.length === 0) return [];
  const users = getUserSummaries(
    db,
    rows.flatMap((row) => [row.agentUserId, row.ownerId, row.decidedById]),
  );
  const teams = new Map(
    db
      .select({ id: s.team.id, name: s.team.name, slug: s.team.slug })
      .from(s.team)
      .where(inArray(s.team.id, [...new Set(rows.map((row) => row.teamId))]))
      .all()
      .map((team) => [team.id, team]),
  );
  return rows.map((row) => ({
    id: row.id,
    team: teams.get(row.teamId) ?? { id: row.teamId, name: 'Deleted team', slug: '' },
    projectId: row.projectId,
    action: row.action,
    status: isOverdue(row, now) ? 'expired' : row.status,
    summary: row.payload.summary,
    url: row.payload.url,
    agent: users.get(row.agentUserId) ?? null,
    owner: users.get(row.ownerId) ?? null,
    via:
      row.viaKeyId && row.viaKeyName
        ? { keyId: row.viaKeyId, keyName: row.viaKeyName, agentName: row.viaAgentName }
        : null,
    runsAsOwner: OWNER_ONLY_AGENT_ACTIONS.has(row.action),
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: expiresAt(row).toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedById ? (users.get(row.decidedById) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Requests the actor may see: a person's are their agent's; an agent's are its own. */
function mine(actor: Actor) {
  return actor.ownerId
    ? eq(s.agentActionRequest.agentUserId, actor.userId)
    : eq(s.agentActionRequest.ownerId, actor.userId);
}

/** `GET /api/agent-actions`: newest first, optionally one status. */
export function listActionRequests(
  deps: AppDeps,
  actor: Actor,
  query: AgentActionListQuery,
): AgentActionListResponse {
  const { orm } = deps.db;
  const now = new Date();
  const cutoff = new Date(now.getTime() - AGENT_ACTION_REQUEST_TTL_MS);
  // Overdue pending requests read as expired (before the hourly job marks them).
  const overdue = and(
    eq(s.agentActionRequest.status, 'pending'),
    lte(s.agentActionRequest.createdAt, cutoff),
  );
  const status =
    query.status === 'all'
      ? undefined
      : query.status === 'pending'
        ? and(
            eq(s.agentActionRequest.status, 'pending'),
            gt(s.agentActionRequest.createdAt, cutoff),
          )
        : query.status === 'expired'
          ? or(eq(s.agentActionRequest.status, 'expired'), overdue)
          : eq(s.agentActionRequest.status, query.status);
  const rows = orm
    .select()
    .from(s.agentActionRequest)
    .where(and(mine(actor), status))
    .orderBy(desc(s.agentActionRequest.createdAt), desc(s.agentActionRequest.id))
    .limit(query.limit)
    .all();
  return { items: toRequests(orm, rows, now) };
}

function findVisible(db: DbExecutor, actor: Actor, requestId: string): AgentActionRequestRow {
  const row = db
    .select()
    .from(s.agentActionRequest)
    .where(and(eq(s.agentActionRequest.id, requestId), mine(actor)))
    .get();
  if (!row) throw errors.notFound('Action request');
  return row;
}

/** One request: its owner's, or the agent's own (MCP `get_action_request`). */
export function getActionRequest(
  deps: AppDeps,
  actor: Actor,
  requestId: string,
): AgentActionRequest {
  const [request] = toRequests(deps.db.orm, [findVisible(deps.db.orm, actor, requestId)]);
  if (!request) throw errors.internal();
  return request;
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

/**
 * Marks the owner's notification about the request read (they answered it, or it expired), with
 * the personal `notification.read` event that refreshes their other tabs.
 */
function markRequestNotificationRead(tx: Tx, row: AgentActionRequestRow, actorId: string | null) {
  const changed = tx
    .update(s.notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(s.notification.userId, row.ownerId),
        eq(s.notification.entityType, 'agent_action_request'),
        eq(s.notification.entityId, row.id),
        isNull(s.notification.readAt),
      ),
    )
    .run();
  if (changed.changes === 0) return;
  emitAfterCommit(tx, {
    type: 'notification.read',
    teamId: row.teamId,
    projectId: null,
    entityType: 'notification',
    entityId: row.teamId,
    parentType: null,
    parentId: null,
    actorId,
    userId: row.ownerId,
  });
}

type Outcome = Pick<AgentActionRequestRow, 'status' | 'result' | 'error'>;

/** Settles a request: status and outcome, notification read, the hook and the live event. */
function settle(
  tx: Tx,
  row: AgentActionRequestRow,
  outcome: Outcome & { decidedById: string | null; decidedAt: Date },
): AgentActionRequestRow {
  const updated = tx
    .update(s.agentActionRequest)
    .set(outcome)
    .where(eq(s.agentActionRequest.id, row.id))
    .returning()
    .get();
  markRequestNotificationRead(tx, updated, outcome.decidedById);
  onActionRequestResolved(tx, updated);
  emitActionRequestChanged(tx, updated, outcome.decidedById);
  return updated;
}

/**
 * The pending request the actor (a person, the agent's owner) may decide. Through an API key the
 * actor is the agent itself, which may never approve its own request.
 */
function requireDecidable(deps: AppDeps, actor: Actor, requestId: string): AgentActionRequestRow {
  if (actor.ownerId) {
    throw errors.forbidden('Only the person the agent works for can decide, in the web app');
  }
  const row = findVisible(deps.db.orm, actor, requestId);
  const now = new Date();
  if (isOverdue(row, now)) {
    deps.db.write((tx) => {
      settle(tx, row, {
        status: 'expired',
        result: null,
        error: null,
        decidedById: null,
        decidedAt: now,
      });
    });
    throw errors.conflict('This request expired: ask your agent to try again if it still should');
  }
  if (row.status !== 'pending') {
    throw errors.conflict(`This request was already ${row.status}`);
  }
  return row;
}

/** The actor an approved request runs as: the owner for owner-only actions, else the agent. */
function runActor(row: AgentActionRequestRow, owner: Actor): Actor {
  if (OWNER_ONLY_AGENT_ACTIONS.has(row.action)) return owner;
  return approvedActor({
    userId: row.agentUserId,
    ownerId: row.ownerId,
    source: row.source,
    key:
      row.viaKeyId && row.viaKeyName
        ? { id: row.viaKeyId, name: row.viaKeyName, agentName: row.viaAgentName }
        : null,
  });
}

/** JSON copy of what the action returned (for `result`). */
function toJson(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * `POST /api/agent-actions/:id/approve`: runs the action (checking everything again) and stores
 * the outcome: `approved` with its result, or `failed` with the reason.
 */
export function approveActionRequest(
  deps: AppDeps,
  actor: Actor,
  requestId: string,
): AgentActionRequest {
  const row = requireDecidable(deps, actor, requestId);
  const decidedAt = new Date();
  // Claim it first, so a second click (or tab) can't run it twice.
  deps.db.write((tx) => {
    const claimed = tx
      .update(s.agentActionRequest)
      .set({ status: 'approved', decidedAt, decidedById: actor.userId })
      .where(and(eq(s.agentActionRequest.id, row.id), eq(s.agentActionRequest.status, 'pending')))
      .run();
    if (claimed.changes === 0) throw errors.conflict('This request was already decided');
  });

  let outcome: Outcome;
  try {
    const value = EXECUTORS[row.action].run(deps, runActor(row, actor), row.payload.input);
    outcome = { status: 'approved', result: toJson(value), error: null };
  } catch (error) {
    if (isAppError(error)) {
      outcome = {
        status: 'failed',
        result: null,
        error: { code: error.code, message: error.message },
      };
    } else {
      if (!isPendingApproval(error)) {
        deps.logger.error({ err: error, requestId: row.id }, 'approved agent action failed');
      }
      outcome = {
        status: 'failed',
        result: null,
        error: { code: 'internal', message: 'Something went wrong' },
      };
    }
  }
  const updated = deps.db.write((tx) =>
    settle(tx, row, { ...outcome, decidedById: actor.userId, decidedAt }),
  );
  return getActionRequest(deps, actor, updated.id);
}

/** `POST /api/agent-actions/:id/deny`: the action never runs. */
export function denyActionRequest(
  deps: AppDeps,
  actor: Actor,
  requestId: string,
): AgentActionRequest {
  const row = requireDecidable(deps, actor, requestId);
  deps.db.write((tx) => {
    const current = tx
      .select({ status: s.agentActionRequest.status })
      .from(s.agentActionRequest)
      .where(eq(s.agentActionRequest.id, row.id))
      .get();
    if (current?.status !== 'pending') throw errors.conflict('This request was already decided');
    settle(tx, row, {
      status: 'denied',
      result: null,
      error: null,
      decidedById: actor.userId,
      decidedAt: new Date(),
    });
  });
  return getActionRequest(deps, actor, row.id);
}

/**
 * Expires pending requests older than 7 days (hourly job): marked `expired`, their notification
 * read, the agent told through the hook. Returns how many expired.
 */
export function expireActionRequests(deps: Pick<AppDeps, 'db'>, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - AGENT_ACTION_REQUEST_TTL_MS);
  const rows = deps.db.orm
    .select()
    .from(s.agentActionRequest)
    .where(
      and(eq(s.agentActionRequest.status, 'pending'), lt(s.agentActionRequest.createdAt, cutoff)),
    )
    .all();
  if (rows.length === 0) return 0;
  deps.db.write((tx) => {
    for (const row of rows) {
      settle(tx, row, {
        status: 'expired',
        result: null,
        error: null,
        decidedById: null,
        decidedAt: now,
      });
    }
  });
  return rows.length;
}
