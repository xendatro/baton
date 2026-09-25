import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { createLabelInputSchema, updateLabelInputSchema } from '@shared/schemas/projects';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { createLabel, deleteLabel, listLabels, updateLabel } from '../services/labels';

/**
 * Labels: list, create, update, delete.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const labelRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const labelParams = validateParams(z.object({ labelId: idSchema }));

labelRoutes.get('/projects/:projectId/labels', projectParams, (c) =>
  c.json(listLabels(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

labelRoutes.post(
  '/projects/:projectId/labels',
  projectParams,
  validateJson(createLabelInputSchema),
  (c) =>
    c.json(
      createLabel(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('json')),
      201,
    ),
);

labelRoutes.patch('/labels/:labelId', labelParams, validateJson(updateLabelInputSchema), (c) =>
  c.json(
    updateLabel(c.var.deps, requireActor(c), c.req.valid('param').labelId, c.req.valid('json')),
  ),
);

labelRoutes.delete('/labels/:labelId', labelParams, (c) =>
  c.json(deleteLabel(c.var.deps, requireActor(c), c.req.valid('param').labelId)),
);
