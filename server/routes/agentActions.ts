import { Hono } from 'hono';
import { z } from 'zod';
import { agentActionListQuerySchema } from '@shared/schemas/agentActions';
import { idSchema } from '@shared/schemas/common';
import type { AppEnv } from '../context';
import { validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  approveActionRequest,
  denyActionRequest,
  getActionRequest,
  listActionRequests,
} from '../services/agentActions';

/**
 * Agent action requests (design §6): the owner lists, approves and denies what their agent asked
 * to do; the agent (through a key) reads its own requests.
 * Owner: agents module. Paths are relative to /api and declared in full in this file.
 */
export const agentActionRoutes = new Hono<AppEnv>();

const requestParams = validateParams(z.object({ id: idSchema }));

agentActionRoutes.get('/agent-actions', validateQuery(agentActionListQuerySchema), (c) =>
  c.json(listActionRequests(c.var.deps, requireActor(c), c.req.valid('query'))),
);

agentActionRoutes.get('/agent-actions/:id', requestParams, (c) =>
  c.json(getActionRequest(c.var.deps, requireActor(c), c.req.valid('param').id)),
);

agentActionRoutes.post('/agent-actions/:id/approve', requestParams, (c) =>
  c.json(approveActionRequest(c.var.deps, requireActor(c), c.req.valid('param').id)),
);

agentActionRoutes.post('/agent-actions/:id/deny', requestParams, (c) =>
  c.json(denyActionRequest(c.var.deps, requireActor(c), c.req.valid('param').id)),
);
