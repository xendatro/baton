import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import type { AppEnv } from '../context';
import { validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  assignRole,
  leaveTeam,
  listMembers,
  removeMember,
  unassignRole,
} from '../services/members';

/**
 * Team members: list, remove, leave, grant and revoke roles.
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const memberRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));
const memberParams = validateParams(z.object({ teamId: idSchema, userId: idSchema }));
const memberRoleParams = validateParams(
  z.object({ teamId: idSchema, userId: idSchema, roleId: idSchema }),
);

memberRoutes.get('/teams/:teamId/members', teamParams, (c) =>
  c.json(listMembers(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

memberRoutes.delete('/teams/:teamId/members/:userId', memberParams, (c) => {
  const { teamId, userId } = c.req.valid('param');
  return c.json(removeMember(c.var.deps, requireActor(c), teamId, userId));
});

memberRoutes.post('/teams/:teamId/leave', teamParams, (c) =>
  c.json(leaveTeam(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

memberRoutes.put('/teams/:teamId/members/:userId/roles/:roleId', memberRoleParams, (c) => {
  const { teamId, userId, roleId } = c.req.valid('param');
  return c.json(assignRole(c.var.deps, requireActor(c), teamId, userId, roleId));
});

memberRoutes.delete('/teams/:teamId/members/:userId/roles/:roleId', memberRoleParams, (c) => {
  const { teamId, userId, roleId } = c.req.valid('param');
  return c.json(unassignRole(c.var.deps, requireActor(c), teamId, userId, roleId));
});
