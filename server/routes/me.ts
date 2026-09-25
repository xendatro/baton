import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Current user: GET /me.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const meRoutes = new Hono<AppEnv>();
