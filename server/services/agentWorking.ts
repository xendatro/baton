import { and, eq, gte, inArray, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import { AGENT_LISTENER, type AgentJobKind } from '@shared/constants';
import type { AgentWorking } from '@shared/schemas/core';
import type { AppDeps } from '../context';
import type { DbExecutor } from '../db';
import * as s from '../db/schema';
import type { EventBus } from '../lib/eventBus';
import { emitEvent } from './events';

/**
 * BAT#42: which agents are **working** on a task or issue right now — the pulsing dot on cards,
 * rows and the item's header, and the chat's "Ethan AI is working…". A job counts only while it is
 * claimed and actually being worked on:
 *   - claimed by a desktop runner whose latest heartbeat (reported within
 *     `RUNNER_REPORT_FRESH_MS`) lists it among the jobs whose harness is running now
 *     (`activeJobIds`, else `jobIds` from older apps). A job queued on the machine, waiting for
 *     usage, held or released is not working;
 *   - or claimed by an MCP listener session that is still alive (its subagent works on it at once;
 *     a vanished session's jobs are put back by the listener sweep);
 *   - and the agent hasn't answered the job's trigger reply yet: the answer is the end of the work,
 *     so the chat stops saying "working" when the answer lands, not when `complete_job` follows.
 * Private jobs (catch up, task drafts) and action results never count.
 *
 * Everything is derived from the database (`agent_session.running_job_ids`, written by the
 * heartbeat), so lists compute it in one query per page. Changes are published as team events
 * `item.working_changed` (entity: the item): each refresh compares with the working sets last
 * published (in memory, per event bus); the listener sweep (every 15 s) catches reports that went
 * stale.
 */

/** A runner's report of its running jobs counts this long (heartbeats come every 30 s). */
export const RUNNER_REPORT_FRESH_MS = 75_000;

/** A listener session counts while it may still be waiting in `start_listener`. */
const LISTENER_FRESH_MS = AGENT_LISTENER.sessionTimeoutMs + AGENT_LISTENER.maxWaitSeconds * 1000;

/** Jobs that are work on the item, visible to everyone (not catch-ups or drafts). */
const WORKING_KINDS: readonly AgentJobKind[] = [
  'mention',
  'thread_reply',
  'assigned',
  'pool',
  'approval',
];

export type WorkingItemType = 'task' | 'issue';

export interface WorkingItem {
  type: WorkingItemType;
  id: string;
}

interface WorkingRow {
  jobId: string;
  agentUserId: string;
  name: string;
  targetType: string;
  targetId: string;
  teamId: string;
  projectId: string;
  sessionKind: 'listener' | 'runner';
  runningJobIds: string[];
  runningReportedAt: Date | null;
  lastSeenAt: Date;
}

function isWorkingItemType(type: string): type is WorkingItemType {
  return type === 'task' || type === 'issue';
}

/** Is the job of `row` being worked on at `now` (see the module comment)? */
function isWorking(row: WorkingRow, now: number): boolean {
  if (row.sessionKind === 'listener') return now - row.lastSeenAt.getTime() < LISTENER_FRESH_MS;
  return (
    row.runningReportedAt !== null &&
    now - row.runningReportedAt.getTime() < RUNNER_REPORT_FRESH_MS &&
    row.runningJobIds.includes(row.jobId)
  );
}

/** Claimed item jobs matching `filter` that are being worked on now, with their agents' names. */
function workingRows(db: DbExecutor, filter: SQL | undefined, now: number): WorkingRow[] {
  return db
    .select({
      jobId: s.agentJob.id,
      agentUserId: s.agentJob.agentUserId,
      name: s.user.name,
      targetType: s.agentJob.targetType,
      targetId: s.agentJob.targetId,
      teamId: s.agentJob.teamId,
      projectId: s.agentJob.projectId,
      sessionKind: s.agentSession.kind,
      runningJobIds: s.agentSession.runningJobIds,
      runningReportedAt: s.agentSession.runningReportedAt,
      lastSeenAt: s.agentSession.lastSeenAt,
    })
    .from(s.agentJob)
    .innerJoin(s.agentSession, eq(s.agentSession.id, s.agentJob.sessionId))
    .innerJoin(s.user, eq(s.user.id, s.agentJob.agentUserId))
    .where(
      and(
        eq(s.agentJob.status, 'claimed'),
        inArray(s.agentJob.kind, [...WORKING_KINDS]),
        inArray(s.agentJob.targetType, ['task', 'issue']),
        filter,
        // The agent's answer to the job's trigger reply ends the work.
        notExists(
          db
            .select({ one: sql`1` })
            .from(s.reply)
            .where(
              and(
                eq(s.reply.parentReplyId, s.agentJob.triggerReplyId),
                eq(s.reply.authorId, s.agentJob.agentUserId),
                isNull(s.reply.deletedAt),
                gte(s.reply.createdAt, s.agentJob.claimedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(s.agentJob.claimedAt)
    .all()
    .filter((row) => isWorking(row, now));
}

/** Groups working rows by item key (`type:id`), agents in the order they started. */
function group(rows: readonly WorkingRow[]): Map<string, AgentWorking> {
  const result = new Map<string, AgentWorking>();
  for (const row of rows) {
    const key = `${row.targetType}:${row.targetId}`;
    const entry = result.get(key) ?? { agentIds: [], names: [] };
    if (!entry.agentIds.includes(row.agentUserId)) {
      entry.agentIds.push(row.agentUserId);
      entry.names.push(row.name);
    }
    result.set(key, entry);
  }
  return result;
}

/**
 * The agents working on each of the items (`ids`, all of one type) now; items without any are
 * left out. One query, for lists, boards and item pages.
 */
export function agentWorkingByItem(
  db: DbExecutor,
  type: WorkingItemType,
  ids: readonly string[],
  now: number = Date.now(),
): Map<string, AgentWorking> {
  if (ids.length === 0) return new Map();
  const rows = workingRows(
    db,
    and(eq(s.agentJob.targetType, type), inArray(s.agentJob.targetId, [...new Set(ids)])),
    now,
  );
  const byKey = group(rows);
  const result = new Map<string, AgentWorking>();
  for (const id of ids) {
    const entry = byKey.get(`${type}:${id}`);
    if (entry) result.set(id, entry);
  }
  return result;
}

/** The agents working on one item now (empty when none). */
export function workingAgentIdsOf(db: DbExecutor, item: WorkingItem): string[] {
  return agentWorkingByItem(db, item.type, [item.id]).get(item.id)?.agentIds ?? [];
}

// ---------------------------------------------------------------------------------------------
// Live events
// ---------------------------------------------------------------------------------------------

interface Published {
  teamId: string;
  projectId: string;
  /** The agent ids last published as working, joined. */
  signature: string;
}

/** Items last published as worked on, per event bus (so per app, like presence). */
const states = new WeakMap<EventBus, Map<string, Published>>();

function publishedOf(deps: Pick<AppDeps, 'events'>): Map<string, Published> {
  let state = states.get(deps.events);
  if (!state) {
    state = new Map();
    states.set(deps.events, state);
  }
  return state;
}

function publish(
  deps: Pick<AppDeps, 'events'>,
  key: string,
  target: { teamId: string; projectId: string },
): void {
  const [type, id] = key.split(':') as [WorkingItemType, string];
  emitEvent(deps, {
    type: 'item.working_changed',
    teamId: target.teamId,
    projectId: target.projectId,
    entityType: type,
    entityId: id,
    actorId: null,
  });
}

/**
 * Compares the working sets of `keys` (`type:id`) now with those last published and emits
 * `item.working_changed` for each item that changed.
 */
function reconcile(
  deps: Pick<AppDeps, 'events'>,
  keys: Iterable<string>,
  rows: readonly WorkingRow[],
): void {
  const published = publishedOf(deps);
  const now = group(rows);
  const targets = new Map(rows.map((row) => [`${row.targetType}:${row.targetId}`, row]));
  for (const key of new Set(keys)) {
    const before = published.get(key);
    const entry = now.get(key);
    const signature = entry ? [...entry.agentIds].sort().join(',') : '';
    if ((before?.signature ?? '') === signature) continue;
    const row = targets.get(key);
    if (entry && row) {
      published.set(key, { teamId: row.teamId, projectId: row.projectId, signature });
      publish(deps, key, row);
    } else if (before) {
      published.delete(key);
      publish(deps, key, before);
    }
  }
}

type WorkingDeps = Pick<AppDeps, 'db' | 'events' | 'logger'>;

/**
 * Re-checks whether agents work on the items and publishes the changes. Call it after the change
 * committed (a job claimed, completed or released, a runner's heartbeat, an agent's answer).
 * Never throws: the dot is a hint.
 */
export function refreshItemsWorking(deps: WorkingDeps, items: readonly WorkingItem[]): void {
  const list = items.filter((item) => isWorkingItemType(item.type));
  if (list.length === 0) return;
  try {
    const conditions = (['task', 'issue'] as const).flatMap((type) => {
      const ids = [...new Set(list.filter((item) => item.type === type).map((item) => item.id))];
      return ids.length === 0
        ? []
        : [and(eq(s.agentJob.targetType, type), inArray(s.agentJob.targetId, ids))];
    });
    const filter =
      conditions.length === 1 ? conditions[0] : sql`(${conditions[0]} or ${conditions[1]})`;
    const rows = workingRows(deps.db.orm, filter, Date.now());
    reconcile(
      deps,
      list.map((item) => `${item.type}:${item.id}`),
      rows,
    );
  } catch (error) {
    deps.logger.debug({ err: error }, 'working refresh failed');
  }
}

/** `refreshItemsWorking` for the items jobs are about (other targets are skipped). */
export function refreshJobsWorking(
  deps: WorkingDeps,
  jobs: ReadonlyArray<{ targetType: string; targetId: string }>,
): void {
  refreshItemsWorking(
    deps,
    jobs.flatMap((job) =>
      isWorkingItemType(job.targetType) ? [{ type: job.targetType, id: job.targetId }] : [],
    ),
  );
}

/** `refreshJobsWorking` for jobs by id (a runner's reported jobs). */
export function refreshJobIdsWorking(deps: WorkingDeps, jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  const jobs = deps.db.orm
    .select({ targetType: s.agentJob.targetType, targetId: s.agentJob.targetId })
    .from(s.agentJob)
    .where(inArray(s.agentJob.id, [...new Set(jobIds)]))
    .all();
  refreshJobsWorking(deps, jobs);
}

/**
 * Re-checks every item with a claimed job and every item last published as worked on (runner
 * reports that went stale, jobs cancelled inside other changes). Run by the listener sweep.
 */
export function sweepWorking(deps: WorkingDeps): void {
  try {
    const rows = workingRows(deps.db.orm, undefined, Date.now());
    const keys = new Set(publishedOf(deps).keys());
    for (const row of rows) keys.add(`${row.targetType}:${row.targetId}`);
    reconcile(deps, keys, rows);
  } catch (error) {
    deps.logger.debug({ err: error }, 'working sweep failed');
  }
}
