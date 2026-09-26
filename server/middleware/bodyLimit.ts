import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LIMITS } from '@shared/constants';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';

/**
 * Request body size limits for the REST API. Every JSON body under /api is capped before anything
 * reads it, so no request can make the server buffer, parse and validate an arbitrarily large
 * body. Upload routes (`POST /api/attachments`, `POST /api/me/avatar`) and `/mcp` set their own,
 * larger limits.
 */

/**
 * Worst-case JSON size of the largest text field the API takes: a README of `LIMITS.readme.max`
 * UTF-16 units, each at most 6 bytes when JSON-escaped (`\uXXXX`).
 */
export const LARGEST_TEXT_FIELD_BYTES = LIMITS.readme.max * 6;

/** Largest JSON body the REST API accepts: above the largest text field plus the other fields. */
export const JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** Largest body Better Auth's endpoints (/api/auth/*) accept: they only take small forms. */
export const AUTH_BODY_MAX_BYTES = 64 * 1024;

function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

/**
 * Rejects bodies over `maxBytes` with 413 `payload_too_large`: at once when `Content-Length`
 * says so, otherwise as soon as the streamed body passes the limit.
 */
export function requestBodyLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      c.json(
        errors.payloadTooLarge(`Request bodies can be at most ${describeSize(maxBytes)}`).toJSON(),
        413,
      ),
  });
}
