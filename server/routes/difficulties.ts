import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createDifficultyInputSchema,
  reorderDifficultiesInputSchema,
  updateDifficultyInputSchema,
} from '@shared/schemas/projects';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createDifficulty,
  deleteDifficulty,
  listDifficulties,
  reorderDifficulties,
  updateDifficulty,
} from '../services/difficulties';

/**
 * Difficulty levels (BAT-24): list, create, update, reorder, delete.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const difficultyRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const difficultyParams = validateParams(z.object({ difficultyId: idSchema }));

difficultyRoutes.get('/projects/:projectId/difficulties', projectParams, (c) =>
  c.json(listDifficulties(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

difficultyRoutes.post(
  '/projects/:projectId/difficulties',
  projectParams,
  validateJson(createDifficultyInputSchema),
  (c) =>
    c.json(
      createDifficulty(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
      201,
    ),
);

difficultyRoutes.put(
  '/projects/:projectId/difficulties/order',
  projectParams,
  validateJson(reorderDifficultiesInputSchema),
  (c) =>
    c.json(
      reorderDifficulties(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

difficultyRoutes.patch(
  '/difficulties/:difficultyId',
  difficultyParams,
  validateJson(updateDifficultyInputSchema),
  (c) =>
    c.json(
      updateDifficulty(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').difficultyId,
        c.req.valid('json'),
      ),
    ),
);

difficultyRoutes.delete('/difficulties/:difficultyId', difficultyParams, (c) =>
  c.json(deleteDifficulty(c.var.deps, requireActor(c), c.req.valid('param').difficultyId)),
);
