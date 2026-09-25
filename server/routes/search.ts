import { Hono } from 'hono';
import { searchQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { search } from '../services/search';

/**
 * Full-text search: GET /search.
 * Owner: admin module (route), core module (service). Paths are relative to /api.
 */
export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get('/search', validateQuery(searchQuerySchema), (c) =>
  c.json(search(c.var.deps, requireActor(c), c.req.valid('query'))),
);
