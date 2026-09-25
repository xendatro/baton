import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { idSchema } from '@shared/schemas/common';
import { createApiKeyInputSchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import { validateJson, validateParams } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys';

/**
 * Personal API keys: /me/api-keys. Web sessions only (SPEC §1.14): a key can't mint or revoke keys.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const apiKeyRoutes = new Hono<AppEnv>();

const webOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (requireActor(c).source !== 'web') {
    throw errors.forbidden('API keys can only be managed from the web app');
  }
  return next();
};

apiKeyRoutes.get('/me/api-keys', webOnly, (c) => c.json(listApiKeys(c.var.deps, requireActor(c))));

apiKeyRoutes.post('/me/api-keys', webOnly, validateJson(createApiKeyInputSchema), (c) =>
  c.json(createApiKey(c.var.deps, requireActor(c), c.req.valid('json')), 201),
);

apiKeyRoutes.delete('/me/api-keys/:id', webOnly, validateParams(z.object({ id: idSchema })), (c) =>
  c.json(revokeApiKey(c.var.deps, requireActor(c), c.req.valid('param').id)),
);
