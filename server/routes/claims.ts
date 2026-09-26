import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  claimNextTaskInputSchema,
  claimTaskInputSchema,
  releaseTaskInputSchema,
  renewClaimInputSchema,
} from '@shared/schemas/tasks';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { claimNextTask, claimTask, releaseTask, renewClaim } from '../services/claims';

/**
 * Task claims: claim the next eligible task, claim (or take over), renew, release.
 * Owner: tasks module. Paths are relative to /api and declared in full in this file.
 */
export const claimRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const taskParams = validateParams(z.object({ taskId: idSchema }));

claimRoutes.post(
  '/projects/:projectId/claim-next',
  projectParams,
  validateJson(claimNextTaskInputSchema),
  (c) =>
    c.json(
      claimNextTask(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

claimRoutes.post('/tasks/:taskId/claim', taskParams, validateJson(claimTaskInputSchema), (c) =>
  c.json(claimTask(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json'))),
);

claimRoutes.post(
  '/tasks/:taskId/claim/renew',
  taskParams,
  validateJson(renewClaimInputSchema),
  (c) =>
    c.json(
      renewClaim(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json')),
    ),
);

claimRoutes.post('/tasks/:taskId/release', taskParams, validateJson(releaseTaskInputSchema), (c) =>
  c.json(
    releaseTask(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json')),
  ),
);
