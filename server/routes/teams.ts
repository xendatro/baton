import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Teams: list, create, get, update, delete, restore, transfer ownership.
 * Owner: teams module. Paths are relative to /api and declared in full in this file.
 */
export const teamRoutes = new Hono<AppEnv>();
