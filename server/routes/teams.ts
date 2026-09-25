import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createTeamInputSchema,
  transferOwnershipInputSchema,
  updateTeamInputSchema,
} from '@shared/schemas/teams';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createTeam,
  deleteTeam,
  getTeam,
  getTeamOverview,
  listDeletedTeams,
  listTeams,
  restoreTeam,
  transferOwnership,
  updateTeam,
} from '../services/teams';

/**
 * Teams: list, create, get, overview, update, delete, restore, transfer ownership, and the
 * owner's deleted teams (GET /me/deleted-teams).
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const teamRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));

teamRoutes.get('/teams', (c) => c.json(listTeams(c.var.deps, requireActor(c))));

teamRoutes.post('/teams', validateJson(createTeamInputSchema), (c) =>
  c.json(createTeam(c.var.deps, requireActor(c), c.req.valid('json')), 201),
);

teamRoutes.get('/me/deleted-teams', (c) => c.json(listDeletedTeams(c.var.deps, requireActor(c))));

teamRoutes.get('/teams/:teamId', teamParams, (c) =>
  c.json(getTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

teamRoutes.get('/teams/:teamId/overview', teamParams, (c) =>
  c.json(getTeamOverview(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

teamRoutes.patch('/teams/:teamId', teamParams, validateJson(updateTeamInputSchema), (c) =>
  c.json(updateTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json'))),
);

teamRoutes.delete('/teams/:teamId', teamParams, (c) =>
  c.json(deleteTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

teamRoutes.post('/teams/:teamId/restore', teamParams, (c) =>
  c.json(restoreTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

teamRoutes.post(
  '/teams/:teamId/transfer',
  teamParams,
  validateJson(transferOwnershipInputSchema),
  (c) =>
    c.json(
      transferOwnership(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').teamId,
        c.req.valid('json'),
      ),
    ),
);
