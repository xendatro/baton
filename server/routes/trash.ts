import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Trash: list deleted items, restore.
 * Owner: admin module. Paths are relative to /api and declared in full in this file.
 */
export const trashRoutes = new Hono<AppEnv>();
