import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { auditLogQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listAuditLog } from '../services/activity';

/**
 * Team audit log: GET /teams/:teamId/audit-log (needs VIEW_AUDIT_LOG).
 * Owner: admin module (route), core module (service). Paths are relative to /api.
 */
export const auditLogRoutes = new Hono<AppEnv>();

auditLogRoutes.get(
  '/teams/:teamId/audit-log',
  validateParams(z.object({ teamId: idSchema })),
  validateQuery(auditLogQuerySchema),
  (c) =>
    c.json(
      listAuditLog(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('query')),
    ),
);
