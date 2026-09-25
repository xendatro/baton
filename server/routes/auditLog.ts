import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Team audit log: GET /teams/:teamId/audit-log.
 * Owner: admin module. Paths are relative to /api and declared in full in this file.
 */
export const auditLogRoutes = new Hono<AppEnv>();
