import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createRoleInputSchema,
  reorderRolesInputSchema,
  updateRoleInputSchema,
} from '@shared/schemas/teams';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { createRole, deleteRole, listRoles, reorderRoles, updateRole } from '../services/roles';

/**
 * Roles: list, create, update, delete, reorder. Granting and revoking roles lives in members.ts.
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const roleRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));
const roleParams = validateParams(z.object({ teamId: idSchema, roleId: idSchema }));

roleRoutes.get('/teams/:teamId/roles', teamParams, (c) =>
  c.json(listRoles(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

roleRoutes.post('/teams/:teamId/roles', teamParams, validateJson(createRoleInputSchema), (c) =>
  c.json(
    createRole(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json')),
    201,
  ),
);

roleRoutes.put(
  '/teams/:teamId/roles/order',
  teamParams,
  validateJson(reorderRolesInputSchema),
  (c) =>
    c.json(
      reorderRoles(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json')),
    ),
);

roleRoutes.patch(
  '/teams/:teamId/roles/:roleId',
  roleParams,
  validateJson(updateRoleInputSchema),
  (c) => {
    const { teamId, roleId } = c.req.valid('param');
    return c.json(updateRole(c.var.deps, requireActor(c), teamId, roleId, c.req.valid('json')));
  },
);

roleRoutes.delete('/teams/:teamId/roles/:roleId', roleParams, (c) => {
  const { teamId, roleId } = c.req.valid('param');
  return c.json(deleteRole(c.var.deps, requireActor(c), teamId, roleId));
});
