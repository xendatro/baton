import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createProjectRoleInputSchema,
  overrideSubjectTypeSchema,
  reorderProjectRolesInputSchema,
  setPermissionOverrideInputSchema,
  updateProjectRoleInputSchema,
} from '@shared/schemas/projectAccess';
import type { AppEnv } from '../context';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  assignProjectRole,
  createProjectRole,
  deleteProjectRole,
  getMemberProjectPermissions,
  getProjectPermissions,
  listProjectRoles,
  removePermissionOverride,
  reorderProjectRoles,
  setPermissionOverride,
  unassignProjectRole,
  updateProjectRole,
} from '../services/projectAccess';

/**
 * Project access (docs/design/agents-and-pipelines.md §3): project roles, their members and the
 * project's permission overrides. Owner: projects module. Paths are relative to /api.
 */
export const projectAccessRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const roleParams = validateParams(z.object({ projectId: idSchema, roleId: idSchema }));
const roleMemberParams = validateParams(
  z.object({ projectId: idSchema, roleId: idSchema, userId: idSchema }),
);
const memberParams = validateParams(z.object({ projectId: idSchema, userId: idSchema }));
const overrideParams = validateParams(
  z.object({ projectId: idSchema, subjectType: overrideSubjectTypeSchema, subjectId: idSchema }),
);

projectAccessRoutes.get('/projects/:projectId/roles', projectParams, (c) =>
  c.json(listProjectRoles(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

projectAccessRoutes.post(
  '/projects/:projectId/roles',
  projectParams,
  validateJson(createProjectRoleInputSchema),
  (c) =>
    c.json(
      createProjectRole(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
      201,
    ),
);

projectAccessRoutes.put(
  '/projects/:projectId/roles/order',
  projectParams,
  validateJson(reorderProjectRolesInputSchema),
  (c) =>
    c.json(
      reorderProjectRoles(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

projectAccessRoutes.patch(
  '/projects/:projectId/roles/:roleId',
  roleParams,
  validateJson(updateProjectRoleInputSchema),
  (c) => {
    const { projectId, roleId } = c.req.valid('param');
    return c.json(
      updateProjectRole(c.var.deps, requireActor(c), projectId, roleId, c.req.valid('json')),
    );
  },
);

projectAccessRoutes.delete('/projects/:projectId/roles/:roleId', roleParams, (c) => {
  const { projectId, roleId } = c.req.valid('param');
  return c.json(deleteProjectRole(c.var.deps, requireActor(c), projectId, roleId));
});

projectAccessRoutes.put(
  '/projects/:projectId/roles/:roleId/members/:userId',
  roleMemberParams,
  (c) => {
    const { projectId, roleId, userId } = c.req.valid('param');
    return c.json(assignProjectRole(c.var.deps, requireActor(c), projectId, roleId, userId));
  },
);

projectAccessRoutes.delete(
  '/projects/:projectId/roles/:roleId/members/:userId',
  roleMemberParams,
  (c) => {
    const { projectId, roleId, userId } = c.req.valid('param');
    return c.json(unassignProjectRole(c.var.deps, requireActor(c), projectId, roleId, userId));
  },
);

projectAccessRoutes.get('/projects/:projectId/permissions', projectParams, (c) =>
  c.json(getProjectPermissions(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

projectAccessRoutes.get('/projects/:projectId/permissions/members/:userId', memberParams, (c) => {
  const { projectId, userId } = c.req.valid('param');
  return c.json(getMemberProjectPermissions(c.var.deps, requireActor(c), projectId, userId));
});

projectAccessRoutes.put(
  '/projects/:projectId/permissions/overrides',
  projectParams,
  validateJson(setPermissionOverrideInputSchema),
  (c) =>
    c.json(
      setPermissionOverride(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

projectAccessRoutes.delete(
  '/projects/:projectId/permissions/overrides/:subjectType/:subjectId',
  overrideParams,
  (c) => {
    const { projectId, subjectType, subjectId } = c.req.valid('param');
    return c.json(
      removePermissionOverride(c.var.deps, requireActor(c), projectId, subjectType, subjectId),
    );
  },
);
