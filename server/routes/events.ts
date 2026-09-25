import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Live events over Server-Sent Events: GET /events.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const eventRoutes = new Hono<AppEnv>();
