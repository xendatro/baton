import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Per-item history: GET /activity.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const activityRoutes = new Hono<AppEnv>();
