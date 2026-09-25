import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Replies on issues and tasks: /replies.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const replyRoutes = new Hono<AppEnv>();
