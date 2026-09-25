import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Better Auth handler: /api/auth/*.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const authRoutes = new Hono<AppEnv>();
