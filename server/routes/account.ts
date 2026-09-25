import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Account: profile, username, avatar, theme, sessions, security log, deletion.
 * Owner: account module. Paths are relative to /api and declared in full in this file.
 */
export const accountRoutes = new Hono<AppEnv>();
