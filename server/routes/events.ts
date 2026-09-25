import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SSE } from '@shared/constants';
import type { AppEnv } from '../context';
import { requireActor } from '../middleware/actor';
import { subscribeUserEvents } from '../services/events';

/**
 * Live updates: GET /events (Server-Sent Events, SPEC §5). One `message` event per LiveEvent
 * (JSON), a `retry` hint, and a `: ping` comment every 25 s so proxies keep the stream open.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const eventRoutes = new Hono<AppEnv>();

eventRoutes.get('/events', (c) => {
  const actor = requireActor(c);
  const { deps } = c.var;
  // Disable response buffering in reverse proxies (nginx-style); Cloudflare streams SSE as is.
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    let closed = false;
    const done = new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true;
        resolve();
      });
    });
    const send = (chunk: Promise<unknown>) => {
      chunk.catch(() => {
        // The client went away mid-write; onAbort cleans up.
      });
    };

    await stream.write(`retry: ${SSE.retryMs}\n\n`);
    const unsubscribe = subscribeUserEvents(deps, actor.userId, (event) => {
      if (!closed) send(stream.writeSSE({ data: JSON.stringify(event) }));
    });
    const heartbeat = setInterval(() => {
      if (!closed) send(stream.write(': ping\n\n'));
    }, SSE.heartbeatMs);

    try {
      await done;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
