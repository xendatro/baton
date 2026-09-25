import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * User lookups: GET /teams/:teamId/mentionables.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const userRoutes = new Hono<AppEnv>();
