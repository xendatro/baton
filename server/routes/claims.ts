import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Task claims: claim, claim next, renew, release.
 * Owner: tasks module. Paths are relative to /api and declared in full in this file.
 */
export const claimRoutes = new Hono<AppEnv>();
