import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createStatusInputSchema,
  deleteStatusQuerySchema,
  reorderStatusesInputSchema,
  updateStatusInputSchema,
} from '@shared/schemas/projects';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createStatus,
  deleteStatus,
  listStatuses,
  reorderStatuses,
  updateStatus,
} from '../services/statuses';

/**
 * Task statuses: list, create, update, reorder, delete (with task migration).
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const statusRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const statusParams = validateParams(z.object({ statusId: idSchema }));

statusRoutes.get('/projects/:projectId/statuses', projectParams, (c) =>
  c.json(listStatuses(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

statusRoutes.post(
  '/projects/:projectId/statuses',
  projectParams,
  validateJson(createStatusInputSchema),
  (c) =>
    c.json(
      createStatus(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
      201,
    ),
);

statusRoutes.put(
  '/projects/:projectId/statuses/order',
  projectParams,
  validateJson(reorderStatusesInputSchema),
  (c) =>
    c.json(
      reorderStatuses(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

statusRoutes.patch(
  '/statuses/:statusId',
  statusParams,
  validateJson(updateStatusInputSchema),
  (c) =>
    c.json(
      updateStatus(c.var.deps, requireActor(c), c.req.valid('param').statusId, c.req.valid('json')),
    ),
);

statusRoutes.delete(
  '/statuses/:statusId',
  statusParams,
  validateQuery(deleteStatusQuerySchema),
  (c) =>
    c.json(
      deleteStatus(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').statusId,
        c.req.valid('query'),
      ),
    ),
);
