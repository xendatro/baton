import { and, gt, inArray } from 'drizzle-orm';
import { AGENT_LISTENER, PERSON_PRESENCE_TIMEOUT_MS } from '@shared/constants';
import type { TeamPresence } from '@shared/schemas/agentJobs';
import type { Actor, AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import type { EventBus } from '../lib/eventBus';
import { requireMember, teamMemberIds } from './access';
import { emitEvent } from './events';

/**
 * Presence (docs/design/agents-and-pipelines.md §4, §7). A person is online while they have a
 * live-updates request open (the SSE stream `GET /api/events`, or a long-poll of
 * `GET /api/events/poll`) or had one in the last 60 s; an agent member is online while one of
 * its listener sessions was seen in the last 90 s (`agent_session.last_seen_at`) or is waiting
 * in `start_listener` right now. Connections and waits are tracked in memory, per event bus
 * (so per app, like everything in AppDeps): presence starts empty after a restart and clients
 * reconnect within seconds.
 *
 * Changes are published as `presence.changed` team events, at most one per team every
 * `PRESENCE_EVENT_INTERVAL_MS` (a trailing event carries later changes), so a flapping connection
 * doesn't flood every member's stream.
 */

/** Least time between two `presence.changed` events of one team. */
export const PRESENCE_EVENT_INTERVAL_MS = 3_000;

interface Throttle {
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PresenceState {
  /** Open live-update requests (SSE streams, pending long-polls) per person. */
  connections: Map<string, number>;
  /** When each person's last live-update request ended. */
  lastSeen: Map<string, number>;
  /** `start_listener` calls waiting right now, per listener session and per agent. */
  listeningSessions: Map<string, number>;
  listeningAgents: Map<string, number>;
  /** Users last published as online. */
  known: Set<string>;
  throttles: Map<string, Throttle>;
}

const states = new WeakMap<EventBus, PresenceState>();

function stateOf(deps: Pick<AppDeps, 'events'>): PresenceState {
  let state = states.get(deps.events);
  if (!state) {
    state = {
      connections: new Map(),
      lastSeen: new Map(),
      listeningSessions: new Map(),
      listeningAgents: new Map(),
      known: new Set(),
      throttles: new Map(),
    };
    states.set(deps.events, state);
  }
  return state;
}

function increment(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

type PresenceDeps = Pick<AppDeps, 'db' | 'events' | 'logger'>;

/**
 * A person's live-updates request opened (an SSE stream, or a long-poll). Returns the function to
 * call when it ends. Agents' own event streams don't count: agents are online by their listener.
 */
export function openLiveConnection(deps: PresenceDeps, userId: string): () => void {
  const state = stateOf(deps);
  increment(state.connections, userId, 1);
  refreshPresence(deps, [userId]);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    increment(state.connections, userId, -1);
    state.lastSeen.set(userId, Date.now());
    refreshPresence(deps, [userId]);
  };
}

/**
 * A `start_listener` call of `sessionId` (agent `agentId`) started waiting; returns the function
 * to call when it stops. While it waits the session counts as seen.
 */
export function beginListening(deps: PresenceDeps, sessionId: string, agentId: string): () => void {
  const state = stateOf(deps);
  increment(state.listeningSessions, sessionId, 1);
  increment(state.listeningAgents, agentId, 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    increment(state.listeningSessions, sessionId, -1);
    increment(state.listeningAgents, agentId, -1);
  };
}

/** Is a `start_listener` call of the session waiting right now? */
export function isSessionListening(deps: Pick<AppDeps, 'events'>, sessionId: string): boolean {
  return stateOf(deps).listeningSessions.has(sessionId);
}

/** Agents among `userIds` with a listener session seen in the last 90 s (or waiting now). */
function onlineAgents(
  db: DbExecutor,
  state: PresenceState,
  userIds: readonly string[],
  now: number,
): Set<string> {
  const online = new Set(userIds.filter((id) => state.listeningAgents.has(id)));
  const rest = userIds.filter((id) => !online.has(id));
  if (rest.length === 0) return online;
  const rows = db
    .selectDistinct({ agentUserId: s.agentSession.agentUserId })
    .from(s.agentSession)
    .where(
      and(
        inArray(s.agentSession.agentUserId, rest),
        gt(s.agentSession.lastSeenAt, new Date(now - AGENT_LISTENER.sessionTimeoutMs)),
      ),
    )
    .all();
  for (const row of rows) online.add(row.agentUserId);
  return online;
}

/** Which of `userIds` are online now (people by connection, agents by listener). */
export function onlineUserIds(
  deps: Pick<AppDeps, 'db' | 'events'>,
  userIds: readonly string[],
  now: number = Date.now(),
): Set<string> {
  const state = stateOf(deps);
  const ids = [...new Set(userIds)];
  const online = new Set<string>();
  const others: string[] = [];
  for (const id of ids) {
    const seen = state.lastSeen.get(id);
    if (
      state.connections.has(id) ||
      (seen !== undefined && now - seen < PERSON_PRESENCE_TIMEOUT_MS)
    ) {
      online.add(id);
    } else {
      others.push(id);
    }
  }
  // Agents never hold live-update connections of their own that count; check their listeners.
  for (const id of onlineAgents(deps.db.orm, state, others, now)) online.add(id);
  return online;
}

/** Publishes `presence.changed` for the team now, or once the throttle interval has passed. */
function publishTeam(deps: Pick<AppDeps, 'events'>, state: PresenceState, teamId: string): void {
  const throttle = state.throttles.get(teamId) ?? { last: 0, timer: null };
  state.throttles.set(teamId, throttle);
  if (throttle.timer) return;
  const emit = () => {
    throttle.timer = null;
    throttle.last = Date.now();
    emitEvent(deps, {
      type: 'presence.changed',
      teamId,
      entityType: 'team',
      entityId: teamId,
      actorId: null,
    });
  };
  const wait = throttle.last + PRESENCE_EVENT_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    emit();
    return;
  }
  throttle.timer = setTimeout(emit, wait);
  throttle.timer.unref?.();
}

/**
 * Re-evaluates whether `userIds` are online and publishes `presence.changed` to the teams of
 * those whose state changed since it was last published.
 */
export function refreshPresence(deps: PresenceDeps, userIds: readonly string[]): void {
  if (userIds.length === 0) return;
  const state = stateOf(deps);
  try {
    const online = onlineUserIds(deps, userIds);
    const changed = [...new Set(userIds)].filter((id) => online.has(id) !== state.known.has(id));
    if (changed.length === 0) return;
    for (const id of changed) {
      if (online.has(id)) state.known.add(id);
      else state.known.delete(id);
    }
    const teamIds = deps.db.orm
      .selectDistinct({ teamId: s.teamMember.teamId })
      .from(s.teamMember)
      .where(inArray(s.teamMember.userId, changed))
      .all()
      .map((row) => row.teamId);
    for (const teamId of teamIds) publishTeam(deps, state, teamId);
  } catch (error) {
    // Presence is a hint; never fail the request (or a closing stream) over it.
    deps.logger.debug({ err: error }, 'presence refresh failed');
  }
}

/**
 * Publishes the people and agents that went offline since the last check (connections that ended
 * over 60 s ago, listener sessions not seen for 90 s). Run by the listener sweep job.
 */
export function sweepPresence(deps: PresenceDeps): void {
  const state = stateOf(deps);
  const now = Date.now();
  for (const [userId, seen] of state.lastSeen) {
    if (now - seen >= PERSON_PRESENCE_TIMEOUT_MS && !state.connections.has(userId)) {
      state.lastSeen.delete(userId);
    }
  }
  refreshPresence(deps, [...state.known]);
}

/** `GET /api/teams/:teamId/presence`: the team's members who are online now. */
export function getTeamPresence(deps: AppDeps, actor: Actor, teamId: string): TeamPresence {
  requireMember(deps.db.orm, actor, teamId);
  const members = teamMemberIds(deps.db.orm, teamId);
  const online = onlineUserIds(deps, members);
  return { online: members.filter((id) => online.has(id)) };
}
