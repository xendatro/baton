import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { liveEventSchema, type LiveEvent, type LiveEventType } from '@shared/events';
import { queryKeys } from './queryKeys';

/**
 * Live event → query invalidation map (SPEC §5). Every event type must be listed (the Record type
 * enforces it). Invalidation matches by key prefix, so broad keys refresh everything below them.
 * `connectLiveEvents` / `useLiveEvents` (below) hold the SSE connection that feeds it.
 */
export type Invalidation = (event: LiveEvent) => QueryKey[];

function teamKeys(event: LiveEvent, ...builders: Array<(teamId: string) => QueryKey>): QueryKey[] {
  const { teamId } = event;
  return teamId ? builders.map((build) => build(teamId)) : [];
}

function projectKeys(
  event: LiveEvent,
  ...builders: Array<(projectId: string) => QueryKey>
): QueryKey[] {
  const { projectId } = event;
  return projectId ? builders.map((build) => build(projectId)) : [];
}

/** The key of the entity named by `parentType`/`parentId`, when both are present. */
function parentKey(event: LiveEvent, build: (type: string, id: string) => QueryKey): QueryKey[] {
  return event.parentType && event.parentId ? [build(event.parentType, event.parentId)] : [];
}

/** Issue or task queries of a reply's or attachment's parent item. */
function parentItemKeys(event: LiveEvent): QueryKey[] {
  if (event.parentType === 'issue') return projectKeys(event, queryKeys.issues.all);
  if (event.parentType === 'task') return projectKeys(event, queryKeys.tasks.all);
  return [];
}

const trash = (event: LiveEvent) => teamKeys(event, queryKeys.teams.trash);

const memberChange: Invalidation = (e) => [
  queryKeys.me(),
  ...teamKeys(e, queryKeys.teams.members, (teamId) => queryKeys.teams.mentionables(teamId)),
  queryKeys.work.all(),
];

const projectChange: Invalidation = (e) => [
  queryKeys.me(),
  ...teamKeys(e, queryKeys.teams.projects),
  ...projectKeys(e, queryKeys.projects.detail),
  queryKeys.work.all(),
];

// Tasks show linked issues and issues list the tasks addressing them, so both refresh.
const issueChange: Invalidation = (e) => [
  ...projectKeys(e, queryKeys.issues.all, queryKeys.tasks.all),
  queryKeys.work.dashboard(),
];

const taskChange: Invalidation = (e) => [
  ...projectKeys(e, queryKeys.tasks.all, queryKeys.issues.all),
  queryKeys.work.all(),
];

const replyChange: Invalidation = (e) => [
  ...parentKey(e, queryKeys.replies.list),
  ...parentItemKeys(e),
];

export const LIVE_INVALIDATIONS: Readonly<Record<LiveEventType, Invalidation>> = {
  'team.updated': (e) => [
    queryKeys.me(),
    ...teamKeys(e, queryKeys.teams.detail),
    queryKeys.work.all(),
  ],
  'team.deleted': () => [
    queryKeys.me(),
    queryKeys.teams.all(),
    queryKeys.work.all(),
    queryKeys.account.all(),
  ],
  'member.joined': memberChange,
  'member.left': memberChange,
  'member.updated': memberChange,
  'role.changed': (e) => [...memberChange(e), ...teamKeys(e, queryKeys.teams.roles)],
  'invite.changed': (e) => teamKeys(e, queryKeys.teams.invites),
  'project.created': projectChange,
  'project.updated': projectChange,
  'project.deleted': (e) => [...projectChange(e), ...trash(e)],
  'project.restored': (e) => [...projectChange(e), ...trash(e)],
  // Work lists show statuses and labels, and a status's category decides what is still open.
  // Issues list the statuses of the tasks addressing them.
  'status.changed': (e) => [
    ...projectKeys(e, queryKeys.projects.statuses, queryKeys.tasks.all, queryKeys.issues.all),
    queryKeys.work.all(),
  ],
  'label.changed': (e) => [
    ...projectKeys(e, queryKeys.projects.labels, queryKeys.tasks.all, queryKeys.issues.all),
    queryKeys.work.all(),
  ],
  'issue.created': issueChange,
  'issue.updated': issueChange,
  'issue.deleted': (e) => [...issueChange(e), ...trash(e)],
  'issue.restored': (e) => [...issueChange(e), ...trash(e)],
  'task.created': taskChange,
  'task.updated': taskChange,
  'task.deleted': (e) => [...taskChange(e), ...trash(e)],
  'task.restored': (e) => [...taskChange(e), ...trash(e)],
  'task.claimed': taskChange,
  'task.released': taskChange,
  'reply.created': replyChange,
  'reply.updated': replyChange,
  'reply.deleted': (e) => [...replyChange(e), ...trash(e)],
  // Attachments are embedded in replies and items; a reply attachment doesn't name its thread.
  'attachment.changed': (e) => [
    ...parentKey(e, queryKeys.attachments),
    ...(e.parentType === 'reply' ? [queryKeys.replies.all()] : parentItemKeys(e)),
    ...trash(e),
  ],
  // For activity events parentType/parentId name the entity the activity row is about.
  'activity.created': (e) => [
    ...parentKey(e, queryKeys.activity),
    ...teamKeys(e, (teamId) => queryKeys.teams.auditLog(teamId)),
    queryKeys.work.dashboard(),
    // Account-level rows (team null) are the user's security log: sign-ins, sessions, keys.
    ...(e.teamId === null
      ? [queryKeys.account.securityLog(), queryKeys.account.sessions(), queryKeys.apiKeys()]
      : []),
  ],
  'notification.created': () => [queryKeys.notifications.all()],
  'me.updated': () => [queryKeys.me(), queryKeys.account.all()],
};

/**
 * The keys to invalidate for a batch of keys: duplicates and keys below another key of the batch
 * (invalidation matches by prefix) are dropped, so each query refetches once.
 */
export function coalesceQueryKeys(keys: readonly QueryKey[]): QueryKey[] {
  const unique = new Map(keys.map((key) => [JSON.stringify(key), key]));
  const isPrefix = (prefix: QueryKey, key: QueryKey) =>
    prefix.length <= key.length &&
    prefix.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));
  return [...unique.values()].filter(
    (key) =>
      ![...unique.values()].some(
        (other) => other !== key && other.length < key.length && isPrefix(other, key),
      ),
  );
}

/**
 * How long live invalidations are collected before they run. One mutation sends several events
 * (e.g. `task.updated` and `activity.created`, which both refresh the dashboard), and agents write
 * in bursts: batching makes each affected query refetch once instead of once per event.
 */
export const LIVE_INVALIDATION_DELAY_MS = 100;

/** Invalidates every query affected by `event`. */
export async function invalidateForEvent(
  queryClient: QueryClient,
  event: LiveEvent,
): Promise<void> {
  await Promise.all(
    LIVE_INVALIDATIONS[event.type](event).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// SSE connection (`GET /api/events`)
// ---------------------------------------------------------------------------------------------

/** `EventSource.CLOSED`, spelled out so fakes in tests need no global. */
const EVENT_SOURCE_CLOSED = 2;

export type LiveEventListener = (event: LiveEvent) => void;
export type LiveConnectionState = 'connecting' | 'open' | 'reconnecting';

const eventListeners = new Set<LiveEventListener>();

/**
 * Listens to every live event (its invalidations are queued and run shortly after, batched with
 * those of the events around it). Returns the unsubscribe.
 */
export function subscribeLiveEvents(listener: LiveEventListener): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/** `subscribeLiveEvents` for the lifetime of a component; the latest `listener` is always used. */
export function useLiveEventListener(listener: LiveEventListener): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => subscribeLiveEvents((event) => latest.current(event)), []);
}

/** Reconnect delays: 1 s doubling to 30 s, with ±20 % jitter so clients don't reconnect in step. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface LiveConnectionOptions {
  queryClient: QueryClient;
  url?: string;
  /** Test seam: the EventSource constructor. */
  createEventSource?: (url: string) => EventSource;
  onStateChange?: (state: LiveConnectionState) => void;
}

/**
 * Opens one EventSource and keeps it open: every message is validated, mapped to query
 * invalidations (batched, see `LIVE_INVALIDATION_DELAY_MS`) and handed to the listeners. When the
 * browser gives up on the stream (HTTP errors close it for good) it reconnects with backoff. After
 * a reconnect every query is invalidated, since events may have been missed while offline.
 * Returns the close function.
 */
export function connectLiveEvents(options: LiveConnectionOptions): () => void {
  const {
    queryClient,
    url = '/api/events',
    createEventSource = (target) => new EventSource(target, { withCredentials: true }),
    onStateChange,
  } = options;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let hasConnected = false;
  let closed = false;
  let pendingKeys: QueryKey[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (state: LiveConnectionState) => onStateChange?.(state);

  const flushInvalidations = () => {
    flushTimer = null;
    const keys = coalesceQueryKeys(pendingKeys);
    pendingKeys = [];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };

  const queueInvalidations = (keys: readonly QueryKey[]) => {
    pendingKeys.push(...keys);
    flushTimer ??= setTimeout(flushInvalidations, LIVE_INVALIDATION_DELAY_MS);
  };

  const handleMessage = (message: MessageEvent<unknown>) => {
    if (typeof message.data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    const parsed = liveEventSchema.safeParse(payload);
    if (!parsed.success) return;
    queueInvalidations(LIVE_INVALIDATIONS[parsed.data.type](parsed.data));
    for (const listener of eventListeners) listener(parsed.data);
  };

  const scheduleReconnect = () => {
    if (closed || timer !== null) return;
    setState('reconnecting');
    timer = setTimeout(() => {
      timer = null;
      open();
    }, reconnectDelay(attempt));
    attempt += 1;
  };

  function open() {
    if (closed) return;
    setState(hasConnected ? 'reconnecting' : 'connecting');
    const current = createEventSource(url);
    source = current;
    current.onopen = () => {
      attempt = 0;
      setState('open');
      if (hasConnected) void queryClient.invalidateQueries();
      hasConnected = true;
    };
    current.onmessage = handleMessage;
    current.onerror = () => {
      // CONNECTING: the browser is retrying on its own (network blip). CLOSED: it gave up.
      if (current.readyState === EVENT_SOURCE_CLOSED) {
        current.close();
        if (source === current) source = null;
        scheduleReconnect();
      } else {
        setState('reconnecting');
      }
    };
  }

  open();

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    if (flushTimer !== null) clearTimeout(flushTimer);
    source?.close();
    source = null;
  };
}

/**
 * Keeps one live connection open while `enabled` (the app shell mounts this once, for signed-in
 * users). Returns the connection state for an offline indicator.
 */
export function useLiveEvents(enabled = true): LiveConnectionState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveConnectionState>('connecting');
  useEffect(() => {
    if (!enabled) return;
    return connectLiveEvents({ queryClient, onStateChange: setState });
  }, [enabled, queryClient]);
  return state;
}
