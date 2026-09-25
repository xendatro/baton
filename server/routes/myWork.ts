import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * My tasks across teams: GET /my-tasks.
 * Owner: work module. Paths are relative to /api and declared in full in this file.
 */
export const myWorkRoutes = new Hono<AppEnv>();
