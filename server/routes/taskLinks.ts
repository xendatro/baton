import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Task links: issue links (fixes/relates) and blocked-by dependencies.
 * Owner: tasks module. Paths are relative to /api and declared in full in this file.
 */
export const taskLinkRoutes = new Hono<AppEnv>();
