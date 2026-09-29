import { Hono } from 'hono';
import {
  catchUpRangeInputSchema,
  chatPageQuerySchema,
  itemParamsSchema,
  setConversationModeInputSchema,
} from '@shared/schemas/chat';
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

/**
 * Chat conversations on issues and tasks: /items/:type/:id/{chat,typing,conversation-mode,catch-up}.
 * Paths are relative to /api and declared in full in this file.
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
