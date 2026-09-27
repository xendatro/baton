import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import type { Env } from '../env';

/**
 * The client's IP address (rate limits, sessions, security log). Behind Cloudflare Tunnel
 * (`TRUST_PROXY=cloudflare`) it is the `CF-Connecting-IP` header. On Render (`TRUST_PROXY=render`)
 * it is the last `X-Forwarded-For` entry: Render's proxy appends the address it received the
 * request from, and anything before it could be forged by the client. Otherwise the socket
 * address, because any forwarding header could be forged. Null when unknown (e.g. requests
 * dispatched in-process by tests).
 */
export function clientIp(c: Context, trustProxy: Env['trustProxy']): string | null {
  if (trustProxy === 'cloudflare') {
    const header = c.req.header('cf-connecting-ip')?.trim();
    return header ? header : null;
  }
  if (trustProxy === 'render') {
    const last = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
    return last ? last : null;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // Not served by @hono/node-server (in-process `app.request`): no socket to ask.
    return null;
  }
}
