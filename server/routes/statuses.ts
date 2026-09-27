import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createPipelineInputSchema,
  createStatusInputSchema,
  deletePipelineQuerySchema,
  deleteStatusQuerySchema,
  reorderPipelinesInputSchema,
  reorderStatusesInputSchema,
  updatePipelineInputSchema,
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
import {
  createPipeline,
  deletePipeline,
  listPipelines,
  reorderPipelines,
  updatePipeline,
} from '../services/projectPipelines';

/**
 * Task statuses: list, create, update, reorder, delete (with task migration). Pipelines (BAT-25):
 * a project's sets of statuses, listed, created, updated, reordered and deleted here too.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const statusRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const statusParams = validateParams(z.object({ statusId: idSchema }));

statusRoutes.get(
  '/projects/:projectId/statuses',
  projectParams,
  validateQuery(z.object({ pipeline: z.string().trim().min(1).max(64).optional() })),
  (c) =>
    c.json(
      listStatuses(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('query').pipeline,
      ),
    ),
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

const pipelineParams = validateParams(z.object({ pipelineId: idSchema }));

statusRoutes.get('/projects/:projectId/pipelines', projectParams, (c) =>
  c.json(listPipelines(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

statusRoutes.post(
  '/projects/:projectId/pipelines',
  projectParams,
  validateJson(createPipelineInputSchema),
  (c) =>
    c.json(
      createPipeline(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
      201,
    ),
);

statusRoutes.put(
  '/projects/:projectId/pipelines/order',
  projectParams,
  validateJson(reorderPipelinesInputSchema),
  (c) =>
    c.json(
      reorderPipelines(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

statusRoutes.patch(
  '/pipelines/:pipelineId',
  pipelineParams,
  validateJson(updatePipelineInputSchema),
  (c) =>
    c.json(
      updatePipeline(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').pipelineId,
        c.req.valid('json'),
      ),
    ),
);

statusRoutes.delete(
  '/pipelines/:pipelineId',
  pipelineParams,
  validateQuery(deletePipelineQuerySchema),
  (c) =>
    c.json(
      deletePipeline(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').pipelineId,
        c.req.valid('query'),
      ),
    ),
);
