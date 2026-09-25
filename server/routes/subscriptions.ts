import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Reply-notification subscriptions: /subscriptions.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const subscriptionRoutes = new Hono<AppEnv>();
