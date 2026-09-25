import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { auditLogQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listAuditLog } from '../services/activity';
import { getAuditLogFacets } from '../services/admin';

/**
 * Team audit log: GET /teams/:teamId/audit-log and its filter facets (both need VIEW_AUDIT_LOG).
 * Owner: admin module (routes), core module (log service). Paths are relative to /api.
 */
export const auditLogRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));

auditLogRoutes.get(
  '/teams/:teamId/audit-log',
  teamParams,
  validateQuery(auditLogQuerySchema),
  (c) =>
    c.json(
      listAuditLog(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('query')),
    ),
);

auditLogRoutes.get('/teams/:teamId/audit-log/facets', teamParams, (c) =>
  c.json(getAuditLogFacets(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);
