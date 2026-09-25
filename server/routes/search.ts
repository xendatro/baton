import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Full-text search: GET /search.
 * Owner: admin module. Paths are relative to /api and declared in full in this file.
 */
export const searchRoutes = new Hono<AppEnv>();
