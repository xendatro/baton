import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  boardQuerySchema,
  createTaskFromIssueSchema,
  createTaskInputSchema,
  listTasksQuerySchema,
  moveTaskInputSchema,
  updateTaskInputSchema,
} from '@shared/schemas/tasks';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createTask,
  createTaskFromIssue,
  deleteTask,
  getBoard,
  getTask,
  getTaskByNumber,
  listTasks,
  moveTask,
  restoreTask,
  updateTask,
} from '../services/tasks';

/**
 * Tasks: board and list (SPEC §1.9 filters), create (also from an issue), get, update, move,
 * delete, restore. Owner: tasks module. Paths are relative to /api and declared in full here.
 */
export const taskRoutes = new Hono<AppEnv>();

const projectParams = validateParams(z.object({ projectId: idSchema }));
const taskParams = validateParams(z.object({ taskId: idSchema }));
const numberParams = validateParams(
  z.object({ projectId: idSchema, number: z.coerce.number().int().min(1).max(999_999_999) }),
);

taskRoutes.get('/projects/:projectId/board', projectParams, validateQuery(boardQuerySchema), (c) =>
  c.json(
    getBoard(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('query')),
  ),
);

taskRoutes.get(
  '/projects/:projectId/tasks',
  projectParams,
  validateQuery(listTasksQuerySchema),
  (c) =>
    c.json(
      listTasks(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('query')),
    ),
);

taskRoutes.post(
  '/projects/:projectId/tasks',
  projectParams,
  validateJson(createTaskInputSchema),
  (c) =>
    c.json(
      createTask(c.var.deps, requireActor(c), c.req.valid('param').projectId, c.req.valid('json')),
      201,
    ),
);

taskRoutes.post(
  '/projects/:projectId/tasks/from-issue',
  projectParams,
  validateJson(createTaskFromIssueSchema),
  (c) =>
    c.json(
      createTaskFromIssue(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').projectId,
        c.req.valid('json'),
      ),
      201,
    ),
);

taskRoutes.get('/projects/:projectId/tasks/:number', numberParams, (c) => {
  const { projectId, number } = c.req.valid('param');
  return c.json(getTaskByNumber(c.var.deps, requireActor(c), projectId, number));
});

taskRoutes.get('/tasks/:taskId', taskParams, (c) =>
  c.json(getTask(c.var.deps, requireActor(c), c.req.valid('param').taskId)),
);

taskRoutes.patch('/tasks/:taskId', taskParams, validateJson(updateTaskInputSchema), (c) =>
  c.json(updateTask(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json'))),
);

taskRoutes.post('/tasks/:taskId/move', taskParams, validateJson(moveTaskInputSchema), (c) =>
  c.json(moveTask(c.var.deps, requireActor(c), c.req.valid('param').taskId, c.req.valid('json'))),
);

taskRoutes.delete('/tasks/:taskId', taskParams, (c) =>
  c.json(deleteTask(c.var.deps, requireActor(c), c.req.valid('param').taskId)),
);

taskRoutes.post('/tasks/:taskId/restore', taskParams, (c) =>
  c.json(restoreTask(c.var.deps, requireActor(c), c.req.valid('param').taskId)),
);
