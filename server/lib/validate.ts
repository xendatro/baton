import type { Context } from 'hono';
import type { BodyData } from 'hono/utils/body';
import { validator } from 'hono/validator';
import type { z } from 'zod';
import { errors } from './errors';

export interface ValidationIssue {
  /** Dotted path of the offending field (`''` for the whole input). */
  path: string;
  message: string;
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * Parses `input` with `schema`, throwing `validation_failed` (HTTP 400) with
 * `details: { issues: [{ path, message }] }` on failure.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = toValidationIssues(result.error);
  const first = issues[0];
  const message = first
    ? first.path
      ? `${first.path}: ${first.message}`
      : first.message
    : 'Invalid input';
  throw errors.validation(message, { issues });
}

/** Hono validators; read the parsed value with `c.req.valid('json' | 'query' | 'param' | 'form')`. */
export const validateJson = <T extends z.ZodType>(schema: T) =>
  validator('json', (value) => parseInput(schema, value));

export const validateQuery = <T extends z.ZodType>(schema: T) =>
  validator('query', (value) => parseInput(schema, value));

export const validateParams = <T extends z.ZodType>(schema: T) =>
  validator('param', (value) => parseInput(schema, value));

export const validateForm = <T extends z.ZodType>(schema: T) =>
  validator('form', (value) => parseInput(schema, value));

/**
 * Reads a multipart/form-data body (`c.req.parseBody()`). A body that isn't valid multipart (no
 * or a wrong boundary, truncated parts) is a 400 `validation_failed` with `message`, not a 500.
 */
export async function parseMultipartBody(c: Context, message: string): Promise<BodyData> {
  try {
    return await c.req.parseBody();
  } catch {
    throw errors.validation(message);
  }
}
