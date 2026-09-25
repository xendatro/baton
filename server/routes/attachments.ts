import { Hono } from 'hono';
import type { AppEnv } from '../context';

/**
 * Attachments: upload, download (/attachments/:id/:filename), delete.
 * Owner: core module. Paths are relative to /api and declared in full in this file.
 */
export const attachmentRoutes = new Hono<AppEnv>();
