import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * API keys: /me/api-keys.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const apiKeyRoutes = new Hono<AppEnv>();
