import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Roles: list, create, update, delete, reorder, assign/unassign.
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const roleRoutes = new Hono<AppEnv>();
