import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Task statuses: list, create, update, reorder, delete (with task migration).
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const statusRoutes = new Hono<AppEnv>();
