import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createProjectInputSchema,
  projectKeyCheckQuerySchema,
  resolveProjectQuerySchema,
  restoreProjectInputSchema,
  updateProjectInputSchema,
} from '@shared/schemas/projects';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  checkProjectKey,
  createProject,
  deleteProject,
  getProject,
  listTeamProjects,
  resolveProjectRef,
  restoreProject,
  updateProject,
} from '../services/projects';

/**
 * Projects: list, create, get, update (incl. key change), delete, restore.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const projectRoutes = new Hono<AppEnv>();

const teamParams = validateParams(z.object({ teamId: idSchema }));
const projectParams = validateParams(z.object({ projectId: idSchema }));

projectRoutes.get('/teams/:teamId/projects', teamParams, (c) =>
  c.json(listTeamProjects(c.var.deps, requireActor(c), c.req.valid('param').teamId)),
);

projectRoutes.post(
  '/teams/:teamId/projects',
  teamParams,
  validateJson(createProjectInputSchema),
  (c) =>
    c.json(
      createProject(c.var.deps, requireActor(c), c.req.valid('param').teamId, c.req.valid('json')),
      201,
    ),
);

projectRoutes.get(
  '/teams/:teamId/projects/key-check',
  teamParams,
  validateQuery(projectKeyCheckQuerySchema),
  (c) =>
    c.json(
      checkProjectKey(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').teamId,
        c.req.valid('query'),
      ),
    ),
);

// Declared before /projects/:projectId so "resolve" is never taken for an id.
projectRoutes.get('/projects/resolve', validateQuery(resolveProjectQuerySchema), (c) =>
  c.json(resolveProjectRef(c.var.deps, requireActor(c), c.req.valid('query').ref)),
);

projectRoutes.get('/projects/:projectId', projectParams, (c) =>
  c.json(getProject(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

projectRoutes.patch(
  '/projects/:projectId',
  projectParams,
  validateJson(updateProjectInputSchema),
  (c) =>
    c.json(
      updateProject(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);

projectRoutes.delete('/projects/:projectId', projectParams, (c) =>
  c.json(deleteProject(c.var.deps, requireActor(c), c.req.valid('param').projectId)),
);

projectRoutes.post(
  '/projects/:projectId/restore',
  projectParams,
  validateJson(restoreProjectInputSchema),
  (c) =>
    c.json(
      restoreProject(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
    ),
);
