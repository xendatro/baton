import type { z } from 'zod';

/** First message per top-level field of a failed zod parse, for inline form errors. */
export function fieldErrors<F extends string>(error: z.ZodError): Partial<Record<F, string>> {
  const result: Partial<Record<F, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string') result[field as F] ??= issue.message;
  }
  return result;
}
