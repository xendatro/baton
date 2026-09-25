import { Hono } from 'hono';
import { CLIENT_IP_HEADER } from '../auth/auth';
import type { AppEnv } from '../context';

/**
 * Better Auth: /auth/* (sign-up, sign-in, email codes, OAuth, sessions, linking).
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const authRoutes = new Hono<AppEnv>();

authRoutes.on(['GET', 'POST'], '/auth/*', (c) => {
  // Hand Better Auth the client IP the app trusts (never a client-supplied header).
  const headers = new Headers(c.req.raw.headers);
  headers.delete(CLIENT_IP_HEADER);
  if (c.var.clientIp) headers.set(CLIENT_IP_HEADER, c.var.clientIp);
  const request = new Request(c.req.raw, { headers });
  return c.var.deps.auth.handler(request);
});
