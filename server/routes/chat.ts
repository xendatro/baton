import { Hono } from 'hono';
import { z } from 'zod';
import {
  catchUpRangeInputSchema,
  chatPageQuerySchema,
  itemParamsSchema,
  requestTaskDraftInputSchema,
  setConversationModeInputSchema,
} from '@shared/schemas/chat';
import { idSchema } from '@shared/schemas/common';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  getCatchUp,
  getChatPage,
  requestCatchUp,
  sendTyping,
  setConversationMode,
} from '../services/chat';
import { getTaskDraft, requestTaskDraft } from '../services/taskDrafts';

/**
 * Chat conversations on issues and tasks: /items/:type/:id/{chat,typing,conversation-mode,catch-up,
 * task-draft} and /task-drafts/:jobId. Paths are relative to /api and declared in full in this file.
 */
export const chatRoutes = new Hono<AppEnv>();

const itemParams = validateParams(itemParamsSchema);

chatRoutes.get('/items/:type/:id/chat', itemParams, validateQuery(chatPageQuerySchema), (c) =>
  c.json(getChatPage(c.var.deps, requireActor(c), c.req.valid('param'), c.req.valid('query'))),
);

chatRoutes.post('/items/:type/:id/typing', itemParams, (c) =>
  c.json(sendTyping(c.var.deps, requireActor(c), c.req.valid('param'))),
);

chatRoutes.put(
  '/items/:type/:id/conversation-mode',
  itemParams,
  validateJson(setConversationModeInputSchema),
  (c) =>
    c.json(
      setConversationMode(c.var.deps, requireActor(c), c.req.valid('param'), c.req.valid('json')),
    ),
);

chatRoutes.get('/items/:type/:id/catch-up', itemParams, (c) =>
  c.json(getCatchUp(c.var.deps, requireActor(c), c.req.valid('param'))),
);

chatRoutes.post(
  '/items/:type/:id/catch-up',
  itemParams,
  validateJson(catchUpRangeInputSchema),
  (c) =>
    c.json(
      requestCatchUp(c.var.deps, requireActor(c), c.req.valid('param'), c.req.valid('json')),
      201,
    ),
);

chatRoutes.post(
  '/items/:type/:id/task-draft',
  itemParams,
  validateJson(requestTaskDraftInputSchema),
  (c) =>
    c.json(
      requestTaskDraft(c.var.deps, requireActor(c), c.req.valid('param'), c.req.valid('json')),
      201,
    ),
);

chatRoutes.get('/task-drafts/:jobId', validateParams(z.object({ jobId: idSchema })), (c) =>
  c.json(getTaskDraft(c.var.deps, requireActor(c), c.req.valid('param').jobId)),
);
