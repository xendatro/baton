import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  liveEventSchema,
  livePollResponseSchema,
  type LiveEvent,
  type LiveEventType,
  type LivePollResponse,
} from '@shared/events';
import { api } from './api';
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
  ...teamKeys(e, queryKeys.teams.members, queryKeys.teams.presence, (teamId) =>
    queryKeys.teams.mentionables(teamId),
  ),
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

// The pipelines' task counts (tabs, sidebar) change with their tasks.
const taskChange: Invalidation = (e) => [
  ...projectKeys(e, queryKeys.tasks.all, queryKeys.issues.all, queryKeys.projects.pipelines),
  queryKeys.work.all(),
];

const replyChange: Invalidation = (e) => [
  ...parentKey(e, queryKeys.replies.list),
  ...parentItemKeys(e),
];

// Reactions show only on task and issue pages and in threads, so lists and boards stay put.
const reactionChange: Invalidation = (e) => {
  if (e.entityType === 'reply') return parentKey(e, queryKeys.replies.list);
  if (e.entityType === 'task') return projectKeys(e, queryKeys.tasks.details);
  if (e.entityType === 'issue') return projectKeys(e, queryKeys.issues.details);
  return [];
};

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
  // Roles or overrides changed: the viewer's permissions (me) and visible projects may differ.
  'project_access.changed': projectChange,
  // Work lists show statuses and labels, and a stage's rules decide what is completed or blocked.
  // Issues list the statuses of the tasks addressing them.
  'status.changed': (e) => [
    ...projectKeys(
      e,
      queryKeys.projects.statuses,
      queryKeys.projects.pipelines,
      queryKeys.tasks.all,
      queryKeys.issues.all,
    ),
    queryKeys.work.all(),
  ],
  'label.changed': (e) => [
    ...projectKeys(e, queryKeys.projects.labels, queryKeys.tasks.all, queryKeys.issues.all),
    queryKeys.work.all(),
  ],
  'difficulty.changed': (e) => [
    ...projectKeys(e, queryKeys.projects.detail, queryKeys.tasks.all),
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
  'reaction.changed': reactionChange,
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
  // Task cards and issue rows show the viewer's unread count (BAT-16); the event names the item.
  'notification.created': (e) => [queryKeys.notifications.all(), ...parentItemKeys(e)],
  // Personal: marked read in another tab (or by item, BAT-15). Refreshes the project's badges.
  'notification.read': (e) => [
    queryKeys.notifications.all(),
    queryKeys.me(),
    ...(e.parentType
      ? parentItemKeys(e)
      : projectKeys(e, queryKeys.tasks.all, queryKeys.issues.all)),
  ],
  'me.updated': () => [queryKeys.me(), queryKeys.account.all()],
  // Someone of the team came online or went offline (throttled on the server).
  'presence.changed': (e) => teamKeys(e, queryKeys.teams.presence),
  // Personal: your agent's jobs or listener sessions changed.
  'agent_job.changed': () => [
    queryKeys.account.agentActivity(),
    queryKeys.account.agentRunners(),
    queryKeys.account.agentWaiting(),
    queryKeys.account.agentModelFailures(),
    queryKeys.account.agentConnection(),
  ],
  // Personal: your agent asked for sign-off, or a request was decided or expired (design §6).
  'agent_action.changed': () => [queryKeys.account.agentActions(), queryKeys.notifications.all()],
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

/**
 * How long a new stream may take to deliver its `ready` event. Some proxies (Cloudflare quick
 * tunnels) pass the SSE headers through but hold the body back, so the stream looks open and never
 * delivers; without `ready` in time the client long-polls instead.
 */
export const LIVE_READY_TIMEOUT_MS = 8_000;

/** One long-poll request (`GET /api/events/poll`); null cursor = "from now". */
export type LivePoll = (cursor: string | null, signal: AbortSignal) => Promise<LivePollResponse>;

const defaultPoll: LivePoll = (cursor, signal) =>
  api.get('/api/events/poll', {
    query: cursor ? { cursor } : undefined,
    schema: livePollResponseSchema,
    signal,
    routeAuthErrors: false,
  });

export interface LiveConnectionOptions {
  queryClient: QueryClient;
  url?: string;
  /** Test seam: the EventSource constructor. */
  createEventSource?: (url: string) => EventSource;
  /** Test seam: one long-poll request. */
  poll?: LivePoll;
  onStateChange?: (state: LiveConnectionState) => void;
}

/**
 * Opens one EventSource and keeps it open: every message is validated, mapped to query
 * invalidations (batched, see `LIVE_INVALIDATION_DELAY_MS`) and handed to the listeners. When the
 * browser gives up on the stream (HTTP errors close it for good) it reconnects with backoff. After
 * a reconnect every query is invalidated, since events may have been missed while offline.
 * If a stream's `ready` event doesn't arrive in time (a proxy that holds the stream back), it
 * switches to long-polling `GET /api/events/poll` for the rest of the page's life (BAT-1).
 * Returns the close function.
 */
export function connectLiveEvents(options: LiveConnectionOptions): () => void {
  const {
    queryClient,
    url = '/api/events',
    createEventSource = (target) => new EventSource(target, { withCredentials: true }),
    poll = defaultPoll,
    onStateChange,
  } = options;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let hasConnected = false;
  let closed = false;
  let pendingKeys: QueryKey[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const polling = new AbortController();

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

  const handleEvent = (payload: unknown) => {
    const parsed = liveEventSchema.safeParse(payload);
    if (!parsed.success) return;
    queueInvalidations(LIVE_INVALIDATIONS[parsed.data.type](parsed.data));
    for (const listener of eventListeners) listener(parsed.data);
  };

  const handleMessage = (message: MessageEvent<unknown>) => {
    if (typeof message.data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(payload);
  };

  const clearReadyTimer = () => {
    if (readyTimer !== null) clearTimeout(readyTimer);
    readyTimer = null;
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

  /** Long-polls until closed; network and server errors back off like stream reconnects. */
  async function pollLoop() {
    let cursor: string | null = null;
    let failures = 0;
    while (!closed) {
      try {
        const result = await poll(cursor, polling.signal);
        if (closed) return;
        // Refetch everything once the first cursor is known (events may have been missed while
        // the stream looked open, or before the cursor), after a reset, and after failures.
        if (cursor === null || result.reset || failures > 0) void queryClient.invalidateQueries();
        failures = 0;
        cursor = result.cursor;
        setState('open');
        for (const payload of result.events) handleEvent(payload);
      } catch {
        if (closed) return;
        setState('reconnecting');
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay(failures)));
        failures += 1;
      }
    }
  }

  const switchToPolling = () => {
    clearReadyTimer();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    source?.close();
    source = null;
    void pollLoop();
  };

  function open() {
    if (closed) return;
    setState(hasConnected ? 'reconnecting' : 'connecting');
    const current = createEventSource(url);
    source = current;
    clearReadyTimer();
    readyTimer = setTimeout(() => {
      if (source === current) switchToPolling();
    }, LIVE_READY_TIMEOUT_MS);
    current.onopen = () => {
      attempt = 0;
      setState('open');
      if (hasConnected) void queryClient.invalidateQueries();
      hasConnected = true;
    };
    current.addEventListener('ready', () => {
      if (source === current) clearReadyTimer();
    });
    current.onmessage = handleMessage;
    current.onerror = () => {
      // CONNECTING: the browser is retrying on its own (network blip). CLOSED: it gave up.
      if (current.readyState === EVENT_SOURCE_CLOSED) {
        current.close();
        if (source === current) {
          source = null;
          clearReadyTimer();
        }
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
    clearReadyTimer();
    polling.abort();
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
