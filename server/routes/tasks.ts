import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Tasks: list (board/list filters), create, get, update, move, delete, restore, create from issue.
 * Owner: tasks module. Paths are relative to /api and declared in full in this file.
 */
export const taskRoutes = new Hono<AppEnv>();
