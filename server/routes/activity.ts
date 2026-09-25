import { Hono } from 'hono';
import { entityActivityQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listEntityActivity } from '../services/activity';

/**
 * Per-item history: GET /activity.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const activityRoutes = new Hono<AppEnv>();

activityRoutes.get('/activity', validateQuery(entityActivityQuerySchema), (c) =>
  c.json(listEntityActivity(c.var.deps, requireActor(c), c.req.valid('query'))),
);
