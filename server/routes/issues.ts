import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createIssueInputSchema,
  listIssuesQuerySchema,
  updateIssueInputSchema,
} from '@shared/schemas/issues';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createIssue,
  deleteIssue,
  getIssue,
  getIssueByNumber,
  listIssues,
  reopenIssue,
  resolveIssue,
  restoreIssue,
  updateIssue,
} from '../services/issues';

/**
 * Issues: list, create, get, update, resolve/reopen, delete, restore.
 * Owner: issues module. Paths are relative to /api and declared in full in this file.
 */
export const issueRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const numberParams = validateParams(
  z.object({ projectId: idSchema, number: z.coerce.number().int().positive().max(999_999_999) }),
);
const issueParams = validateParams(z.object({ issueId: idSchema }));

issueRoutes.get(
  '/projects/:projectId/issues',
  projectParams,
  validateQuery(listIssuesQuerySchema),
  (c) =>
    c.json(
      listIssues(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('query')),
    ),
);

issueRoutes.post(
  '/projects/:projectId/issues',
  projectParams,
  validateJson(createIssueInputSchema),
  (c) =>
    c.json(
      createIssue(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('json')),
      201,
    ),
);

issueRoutes.get('/projects/:projectId/issues/:number', numberParams, (c) => {
  const { projectId, number } = c.req.valid('param');
  return c.json(getIssueByNumber(c.var.deps, requireActor(c), projectId, number));
});

issueRoutes.get('/issues/:issueId', issueParams, (c) =>
  c.json(getIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId)),
);

issueRoutes.patch('/issues/:issueId', issueParams, validateJson(updateIssueInputSchema), (c) =>
  c.json(
    updateIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId, c.req.valid('json')),
  ),
);

issueRoutes.post('/issues/:issueId/resolve', issueParams, (c) =>
  c.json(resolveIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId)),
);

issueRoutes.post('/issues/:issueId/reopen', issueParams, (c) =>
  c.json(reopenIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId)),
);

issueRoutes.delete('/issues/:issueId', issueParams, (c) =>
  c.json(deleteIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId)),
);

issueRoutes.post('/issues/:issueId/restore', issueParams, (c) =>
  c.json(restoreIssue(c.var.deps, requireActor(c), c.req.valid('param').issueId)),
);
