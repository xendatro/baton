import { z } from 'zod';
import { errors } from './errors';

/**
 * Opaque pagination cursors: base64url-encoded JSON of the sort key of the last returned row,
 * e.g. `[createdAtMs, id]`. Clients pass `nextCursor` back verbatim.
 */
export function encodeCursor(values: ReadonlyArray<string | number>): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/** Decodes a cursor and validates its shape; malformed cursors are a `validation_failed` error. */
export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.output<T> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation('Invalid cursor');
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw errors.validation('Invalid cursor');
  return result.data;
}

/** The common `[createdAtMs, id]` cursor shape. */
export const timeIdCursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1)]);
