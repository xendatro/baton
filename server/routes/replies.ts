import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import {
  createReplyInputSchema,
  listRepliesQuerySchema,
  updateReplyInputSchema,
  type Reply,
} from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  createReply,
  deleteReply,
  editReply,
  listReplies,
  type ReplyWithContext,
} from '../services/replies';

/**
 * Replies on issues and tasks: /replies.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const replyRoutes = new Hono<AppEnv>();

const idParams = validateParams(z.object({ id: idSchema }));

/** The REST contract returns the plain `Reply` (MCP tools add the parent's ref and URL). */
function plain({ ref: _ref, url: _url, ...reply }: ReplyWithContext): Reply {
  return reply;
}

replyRoutes.get('/replies', validateQuery(listRepliesQuerySchema), (c) =>
  c.json(listReplies(c.var.deps, requireActor(c), c.req.valid('query'))),
);

replyRoutes.post('/replies', validateJson(createReplyInputSchema), (c) =>
  c.json(plain(createReply(c.var.deps, requireActor(c), c.req.valid('json'))), 201),
);

replyRoutes.patch('/replies/:id', idParams, validateJson(updateReplyInputSchema), (c) =>
  c.json(
    plain(editReply(c.var.deps, requireActor(c), c.req.valid('param').id, c.req.valid('json'))),
  ),
);

replyRoutes.delete('/replies/:id', idParams, (c) =>
  c.json(deleteReply(c.var.deps, requireActor(c), c.req.valid('param').id)),
);
