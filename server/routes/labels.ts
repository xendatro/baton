import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Labels: list, create, update, delete.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const labelRoutes = new Hono<AppEnv>();
