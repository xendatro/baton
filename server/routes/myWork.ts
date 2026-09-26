import { Hono } from 'hono';
import { myTasksQuerySchema } from '@shared/schemas/work';
import type { AppEnv } from '../context';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listMyTasks } from '../services/myWork';

/**
 * My tasks across teams: GET /me/tasks.
 * Owner: work module. Paths are relative to /api and declared in full in this file.
 */
export const myWorkRoutes = new Hono<AppEnv>();

myWorkRoutes.get('/me/tasks', validateQuery(myTasksQuerySchema), (c) =>
  c.json(listMyTasks(c.var.deps, requireActor(c), c.req.valid('query'))),
);
