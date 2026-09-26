import { Hono } from 'hono';
import { dashboardQuerySchema } from '@shared/schemas/work';
import type { AppEnv } from '../context';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { getDashboard } from '../services/dashboard';

/**
 * Dashboard summary: GET /me/dashboard.
 * Owner: work module. Paths are relative to /api and declared in full in this file.
 */
export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.get('/me/dashboard', validateQuery(dashboardQuerySchema), (c) =>
  c.json(getDashboard(c.var.deps, requireActor(c), c.req.valid('query'))),
);
