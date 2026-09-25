import { Hono } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { mentionablesQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateParams, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { listMentionables } from '../services/users';

/**
 * Users: GET /teams/:teamId/mentionables (@-mention autocomplete).
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const userRoutes = new Hono<AppEnv>();

userRoutes.get(
  '/teams/:teamId/mentionables',
  validateParams(z.object({ teamId: idSchema })),
  validateQuery(mentionablesQuerySchema),
  (c) =>
    c.json(
      listMentionables(
        c.var.deps,
        requireActor(c),
        c.req.valid('param').teamId,
        c.req.valid('query'),
      ),
    ),
);
