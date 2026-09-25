import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Team members: list, remove, leave.
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const memberRoutes = new Hono<AppEnv>();
