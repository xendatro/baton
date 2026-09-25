import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Invite links: create, list, revoke, preview and accept (/join/:code).
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const inviteRoutes = new Hono<AppEnv>();
