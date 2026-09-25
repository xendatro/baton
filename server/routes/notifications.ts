import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Notifications: /notifications, /notifications/unread-count, /notifications/read.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const notificationRoutes = new Hono<AppEnv>();
