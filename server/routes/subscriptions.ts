import { Hono } from 'hono';
import { setSubscriptionInputSchema, subscriptionQuerySchema } from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import { getSubscription, setSubscription } from '../services/subscriptions';

/**
 * Reply-notification subscriptions: /subscriptions.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.get('/subscriptions', validateQuery(subscriptionQuerySchema), (c) =>
  c.json(getSubscription(c.var.deps, requireActor(c), c.req.valid('query'))),
);

subscriptionRoutes.post('/subscriptions', validateJson(setSubscriptionInputSchema), (c) =>
  c.json(setSubscription(c.var.deps, requireActor(c), c.req.valid('json'))),
);
