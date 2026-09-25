import { Hono } from 'hono';
import {
  listNotificationsQuerySchema,
  markNotificationsReadInputSchema,
} from '@shared/schemas/core';
import type { AppEnv } from '../context';
import { validateJson, validateQuery } from '../lib/validate';
import { requireActor } from '../middleware/actor';
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from '../services/notifications';

/**
 * Inbox: /notifications.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.get('/notifications', validateQuery(listNotificationsQuerySchema), (c) =>
  c.json(listNotifications(c.var.deps, requireActor(c), c.req.valid('query'))),
);

notificationRoutes.get('/notifications/unread-count', (c) =>
  c.json({ count: unreadNotificationCount(c.var.deps, requireActor(c)) }),
);

notificationRoutes.post(
  '/notifications/read',
  validateJson(markNotificationsReadInputSchema),
  (c) => c.json(markNotificationsRead(c.var.deps, requireActor(c), c.req.valid('json'))),
);
