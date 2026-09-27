import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  approvalInputSchema,
  copyPipelineInputSchema,
  copyPipelinePreviewQuerySchema,
  saveEvidenceInputSchema,
} from '@shared/schemas/pipelines';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { copyPipeline, copyPipelinePreview } from '../services/pipelineCopy';
import { decideApproval, saveTaskEvidence } from '../services/pipelines';

/**
 * Pipelines (design §5): evidence and approvals on a task's stage, and copying a pipeline between
 * projects. Status rules themselves are edited through `PATCH /api/statuses/:statusId`. Owner:
 * tasks module. Paths are relative to /api and declared in full here.
 */
export const pipelineRoutes = new Hono<AppEnv>();

const taskParams = validateParams(z.object({ taskId: idSchema }));
const projectParams = validateParams(z.object({ projectId: idSchema }));

pipelineRoutes.put(
  '/tasks/:taskId/evidence',
  taskParams,
  validateJson(saveEvidenceInputSchema),
  (c) =>
    c.json(
      saveTaskEvidence(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').taskId,
        c.req.valid('json').evidence,
      ),
    ),
);

pipelineRoutes.post(
  '/tasks/:taskId/approvals',
  taskParams,
  validateJson(approvalInputSchema),
  (c) =>
    c.json(
      decideApproval(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json')),
      201,
    ),
);

pipelineRoutes.get(
  '/projects/:projectId/pipeline/copy-preview',
  projectParams,
  validateQuery(copyPipelinePreviewQuerySchema),
  (c) =>
    c.json(
      copyPipelinePreview(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('query').from,
        {
          fromPipelineId: c.req.valid('query').fromPipeline,
          pipelineId: c.req.valid('query').pipeline,
        },
      ),
    ),
);

pipelineRoutes.post(
  '/projects/:projectId/pipeline/copy',
  projectParams,
  validateJson(copyPipelineInputSchema),
  (c) =>
    c.json(
      copyPipeline(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);
