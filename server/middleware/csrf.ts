import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF protection (SPEC §5): a cookie-authenticated request that changes data must carry an
 * `Origin` — or, failing that, a `Referer` — whose origin is `BASE_URL`'s. API-key requests carry
 * no ambient credentials and are exempt. Runs after the actor middleware. (Better Auth applies the
 * same check to its own endpoints under /api/auth.)
 */
export function csrfMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || c.var.actor?.source !== 'web') return next();
    const expected = originOf(c.var.deps.env.baseUrl);
    const origin = c.req.header('origin');
    const presented =
      origin !== undefined ? originOf(origin) : originOf(c.req.header('referer') ?? '');
    if (!expected || presented !== expected) {
      throw errors.forbidden('Cross-site request blocked: the Origin does not match this site');
    }
    return next();
  };
}
