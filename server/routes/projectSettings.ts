import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { updateMyProjectSettingsInputSchema } from '@shared/schemas/projectSettings';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { getMyProjectSettings, updateMyProjectSettings } from '../services/projectSettings';

/**
 * Your settings for one project (BAT-29): its notifications and your models by difficulty.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const projectSettingsRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));

projectSettingsRoutes.get('/projects/:projectId/my-settings', projectParams, (c) =>
  c.json(getMyProjectSettings(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

projectSettingsRoutes.put(
  '/projects/:projectId/my-settings',
  projectParams,
  validateJson(updateMyProjectSettingsInputSchema),
  (c) =>
    c.json(
      updateMyProjectSettings(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);
