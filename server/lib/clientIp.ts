import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { Env } from '../env';

/**
 * The client's IP address (rate limits, sessions, security log). Behind Cloudflare Tunnel
 * (`TRUST_PROXY=cloudflare`) it is the `CF-Connecting-IP` header; otherwise the socket address,
 * because any forwarding header could be forged by the client. Null when unknown (e.g. requests
 * dispatched in-process by tests).
 */
export function clientIp(c: Context, trustProxy: Env['trustProxy']): string | null {
  if (trustProxy === 'cloudflare') {
    const header = c.req.header('cf-connecting-ip')?.trim();
    return header ? header : null;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // Not served by @hono/node-server (in-process `app.request`): no socket to ask.
    return null;
  }
}
