import { Hono } from 'hono';
import { reactionInputSchema, type ReactionListResponse } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { addReaction, removeReaction, type ReactionResult } from '../services/reactions';

/**
 * Emoji reactions on replies, tasks and issues (BAT-14): /reactions.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const reactionRoutes = new Hono<AppEnv>();

/** The REST contract returns the target and its reactions (MCP tools add its ref and URL). */
function plain({ ref: _ref, url: _url, ...rest }: ReactionResult): ReactionListResponse {
  return rest;
}

reactionRoutes.put('/reactions', validateJson(reactionInputSchema), (c) =>
  c.json(plain(addReaction(c.var.deps, requireActor(c), c.req.valid('json')))),
);

reactionRoutes.delete('/reactions', validateQuery(reactionInputSchema), (c) =>
  c.json(plain(removeReaction(c.var.deps, requireActor(c), c.req.valid('query')))),
);
