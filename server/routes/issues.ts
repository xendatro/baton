import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Issues: list, create, get, update, resolve/reopen, delete, restore.
 * Owner: issues module. Paths are relative to /api and declared in full in this file.
 */
export const issueRoutes = new Hono<AppEnv>();
