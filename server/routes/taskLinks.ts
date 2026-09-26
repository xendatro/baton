import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { setIssueLinkInputSchema } from '@shared/schemas/tasks';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { updateTask } from '../services/tasks';

/**
 * Task links, one at a time: blocked-by dependencies and issue links (fixes/relates). They go
 * through the same `updateTask` service as `blockedBy`/`issueLinks` changes, so they are checked
 * and audited alike. Owner: tasks module. Paths are relative to /api and declared in full here.
 */
export const taskLinkRoutes = new Hono<AppEnv>();

const blockerParams = validateParams(z.object({ taskId: idSchema, blockerId: idSchema }));
const issueParams = validateParams(z.object({ taskId: idSchema, issueId: idSchema }));

taskLinkRoutes.put('/tasks/:taskId/blocked-by/:blockerId', blockerParams, (c) => {
  const { taskId, blockerId } = c.req.valid('param');
  return c.json(
    updateTask(c.var.deps, requireActor(c), taskId, { blockedBy: { add: [blockerId] } }),
  );
});

taskLinkRoutes.delete('/tasks/:taskId/blocked-by/:blockerId', blockerParams, (c) => {
  const { taskId, blockerId } = c.req.valid('param');
  return c.json(
    updateTask(c.var.deps, requireActor(c), taskId, { blockedBy: { remove: [blockerId] } }),
  );
});

taskLinkRoutes.put(
  '/tasks/:taskId/issues/:issueId',
  issueParams,
  validateJson(setIssueLinkInputSchema),
  (c) => {
    const { taskId, issueId } = c.req.valid('param');
    const { kind } = c.req.valid('json');
    return c.json(
      updateTask(c.var.deps, requireActor(c), taskId, {
        issueLinks: { add: [{ issueId, kind }] },
      }),
    );
  },
);

taskLinkRoutes.delete('/tasks/:taskId/issues/:issueId', issueParams, (c) => {
  const { taskId, issueId } = c.req.valid('param');
  return c.json(
    updateTask(c.var.deps, requireActor(c), taskId, { issueLinks: { remove: [issueId] } }),
  );
});
