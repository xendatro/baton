import { Hono } from 'hono';
import { z } from 'zod';
import { trashListQuerySchema } from '@shared/schemas/admin';
import { idSchema } from '@shared/schemas/common';
import { trashItemRefSchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listTeamTrash, restoreTrashItem } from '../services/admin';

/**
 * Trash: list deleted items, restore.
 * Owner: admin module. Paths are relative to /api and declared in full in this file.
 */
export const trashRoutes = new Hono<AppEnv>();

trashRoutes.get(
  '/teams/:teamId/trash',
  validateParams(z.object({ teamId: idSchema })),
  validateQuery(trashListQuerySchema),
  (c) =>
    c.json(
      listTeamTrash(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('query')),
    ),
);

trashRoutes.post('/trash/restore', validateJson(trashItemRefSchema), (c) =>
  c.json(restoreTrashItem(c.var.deps, requireActor(c), c.req.valid('json'))),
);
