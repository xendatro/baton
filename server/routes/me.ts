import { Hono } from 'hono';
import { securityLogQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listSecurityLog } from '../services/activity';
import { getMe } from '../services/users';

/**
 * Current user: GET /me, GET /me/security-log.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/me', (c) => c.json(getMe(c.var.deps, requireActor(c))));

meRoutes.get('/me/security-log', validateQuery(securityLogQuerySchema), (c) =>
  c.json(listSecurityLog(c.var.deps, requireActor(c), c.req.valid('query'))),
);
