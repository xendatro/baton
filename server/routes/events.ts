import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SSE } from '@shared/constants';
import { livePollQuerySchema, type LivePollResponse } from '@shared/events';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  isCredentialActive,
  pollUserEvents,
  subscribeUserEvents,
  type StreamCredential,
} from '../services/events';
import { openLiveConnection } from '../services/presence';

/**
 * Live updates: GET /events (Server-Sent Events, SPEC §5). One `message` event per LiveEvent
 * (JSON), a `retry` hint, and a `: ping` comment every 25 s so proxies keep the stream open.
 * The key or session the stream was opened with is re-checked before every event and heartbeat;
 * once it is revoked, expired or signed out, the stream ends (and reconnecting gets a 401).
 * A `ready` event right after the `retry` hint lets clients notice a proxy that holds the stream
 * back; they then long-poll GET /events/poll instead.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const eventRoutes = new Hono<AppEnv>();

eventRoutes.get('/events', (c) => {
  const actor = requireActor(c);
  const { deps } = c.var;
  const sessionId = c.var.sessionId;
  let credential: StreamCredential;
  if (actor.key) credential = { apiKeyId: actor.key.id };
  else if (sessionId) credential = { sessionId };
  else throw errors.unauthorized();

  // Ask proxies not to buffer or transform the stream (nginx-style header, and `no-transform`
  // against compression). Some still do (Cloudflare quick tunnels): see /events/poll.
  c.header('X-Accel-Buffering', 'no');
  const response = streamSSE(c, async (stream) => {
    let closed = false;
    const ended = new AbortController();
    const finish = () => {
      closed = true;
      ended.abort();
    };
    stream.onAbort(finish);
    const done = new Promise<void>((resolve) => {
      ended.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const send = (chunk: Promise<unknown>) => {
      chunk.catch(() => {
        // The client went away mid-write; onAbort cleans up.
      });
    };
    /** False (and the stream ends) once the credential is no longer valid. */
    const stillAuthorized = () => {
      if (closed) return false;
      // Keys belong to the person, even when the stream is their agent's (agents A).
      if (isCredentialActive(deps, actor.ownerId ?? actor.userId, credential)) return true;
      finish();
      return false;
    };

    await stream.write(`retry: ${SSE.retryMs}\n\n`);
    await stream.writeSSE({ event: 'ready', data: '{}' });
    const unsubscribe = subscribeUserEvents(deps, actor.userId, (event) => {
      if (stillAuthorized()) send(stream.writeSSE({ data: JSON.stringify(event) }));
    });
    const heartbeat = setInterval(() => {
      if (stillAuthorized()) send(stream.write(': ping\n\n'));
    }, SSE.heartbeatMs);
    // A person with an open stream is online (design §4); agents are online by their listener.
    const offline = actor.ownerId ? () => undefined : openLiveConnection(deps, actor.userId);

    try {
      await done;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
      offline();
    }
  });
  // streamSSE sets its own `Cache-Control: no-cache`, so this goes on the response it returns.
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  return response;
});

/**
 * Long-poll fallback: GET /events/poll?cursor=… answers with the events after `cursor` as soon as
 * there are any, or with none after 25 s. Without a cursor it answers at once with one to start
 * from. `reset: true` means events may have been missed, so the client refetches everything.
 */
eventRoutes.get('/events/poll', validateQuery(livePollQuerySchema), async (c) => {
  const actor = requireActor(c);
  const { cursor } = c.req.valid('query');
  // Long-polling counts as a live connection for presence, and for 60 s after each poll.
  const offline = actor.ownerId ? () => undefined : openLiveConnection(c.var.deps, actor.userId);
  let result: LivePollResponse;
  try {
    result = await pollUserEvents(c.var.deps, actor.userId, cursor ?? null, {
      signal: c.req.raw.signal,
    });
  } finally {
    offline();
  }
  c.header('Cache-Control', 'no-store');
  return c.json(result);
});
