import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SSE } from '@shared/constants';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { requireActor } from '../middleware/actor';
import { isCredentialActive, subscribeUserEvents, type StreamCredential } from '../services/events';

/**
 * Live updates: GET /events (Server-Sent Events, SPEC §5). One `message` event per LiveEvent
 * (JSON), a `retry` hint, and a `: ping` comment every 25 s so proxies keep the stream open.
 * The key or session the stream was opened with is re-checked before every event and heartbeat;
 * once it is revoked, expired or signed out, the stream ends (and reconnecting gets a 401).
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

  // Disable response buffering in reverse proxies (nginx-style); Cloudflare streams SSE as is.
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
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
      if (isCredentialActive(deps, actor.userId, credential)) return true;
      finish();
      return false;
    };

    await stream.write(`retry: ${SSE.retryMs}\n\n`);
    const unsubscribe = subscribeUserEvents(deps, actor.userId, (event) => {
      if (stillAuthorized()) send(stream.writeSSE({ data: JSON.stringify(event) }));
    });
    const heartbeat = setInterval(() => {
      if (stillAuthorized()) send(stream.write(': ping\n\n'));
    }, SSE.heartbeatMs);

    try {
      await done;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
