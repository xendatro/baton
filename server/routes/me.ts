import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  reorderMyProjectsInputSchema,
  reorderMyTeamsInputSchema,
  securityLogQuerySchema,
  updateMyTeamInputSchema,
} from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listSecurityLog } from '../services/activity';
import { getMe, reorderMyProjects, reorderMyTeams, updateMyTeam } from '../services/users';

/**
 * Current user: GET /me, GET /me/security-log, PUT /me/teams/order, PATCH /me/teams/:teamId,
 * PUT /me/teams/:teamId/projects/order.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/me', (c) => c.json(getMe(c.var.deps, requireActor(c))));

meRoutes.get('/me/security-log', validateQuery(securityLogQuerySchema), (c) =>
  c.json(listSecurityLog(c.var.deps, requireActor(c), c.req.valid('query'))),
);

// Your sidebar (BAT-36): team order, pins and folded teams.
meRoutes.put('/me/teams/order', validateJson(reorderMyTeamsInputSchema), (c) =>
  c.json(reorderMyTeams(c.var.deps, requireActor(c), c.req.valid('json'))),
);

meRoutes.patch(
  '/me/teams/:teamId',
  validateParams(z.object({ teamId: idSchema })),
  validateJson(updateMyTeamInputSchema),
  (c) =>
    c.json(
      updateMyTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json')),
    ),
);

// BAT#27: your order of a team's projects (they only move within their team).
meRoutes.put(
  '/me/teams/:teamId/projects/order',
  validateParams(z.object({ teamId: idSchema })),
  validateJson(reorderMyProjectsInputSchema),
  (c) =>
    c.json(
      reorderMyProjects(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').teamId,
        c.req.valid('json'),
      ),
    ),
);
