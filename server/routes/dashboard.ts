import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Dashboard summary: GET /dashboard.
 * Owner: work module. Paths are relative to /api and declared in full in this file.
 */
export const dashboardRoutes = new Hono<AppEnv>();
