import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Projects: list, create, get, update (incl. key change), delete, restore.
 * Owner: projects module. Paths are relative to /api and declared in full in this file.
 */
export const projectRoutes = new Hono<AppEnv>();
