import type { Context, MiddlewareHandler } from 'hono';
import { RATE_LIMITS } from '@shared/constants';
import type { AppEnv } from '../context';
import { errors } from '../lib/errors';
import type { RateLimitRule } from '../lib/rateLimit';

/**
 * Rate-limit middlewares (SPEC §5): auth endpoints 10/min per IP, REST writes 120/min per user,
 * uploads 30/min per user, MCP 300/min per key. Buckets live in `deps.rateLimiter`.
 */

const MINUTE_MS = 60_000;

export const RATE_LIMIT_RULES = {
  auth: { max: RATE_LIMITS.authPerIp, windowMs: MINUTE_MS },
  writes: { max: RATE_LIMITS.writesPerUser, windowMs: MINUTE_MS },
  uploads: { max: RATE_LIMITS.uploadsPerUser, windowMs: MINUTE_MS },
  mcp: { max: RATE_LIMITS.mcpPerKey, windowMs: MINUTE_MS },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMIT_RULES;

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RateLimitOptions {
  name: RateLimitName;
  /** Bucket key for this request (IP, user or key id); null skips limiting. */
  key: (c: Context<AppEnv>) => string | null;
  /** Only count data-changing requests (default: every request). */
  writesOnly?: boolean;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const rule = RATE_LIMIT_RULES[options.name];
  return async (c, next) => {
    if (options.writesOnly && !WRITE_METHODS.has(c.req.method)) return next();
    const key = options.key(c);
    if (key === null) return next();
    const decision = c.var.deps.rateLimiter.consume(`${options.name}:${key}`, rule);
    if (!decision.allowed) {
      c.var.logger.warn({ limit: options.name }, 'rate limited');
      return c.json(errors.rateLimited().toJSON(), 429, {
        'Retry-After': String(decision.retryAfterSeconds),
      });
    }
    return next();
  };
}

/** Per-IP key; requests with an unknown address share one bucket. */
export const byClientIp = (c: Context<AppEnv>) => c.var.clientIp ?? 'unknown';

/** Per-user key (null for anonymous requests, which the route rejects anyway). */
export const byUser = (c: Context<AppEnv>) => c.var.actor?.userId ?? null;

/** Per-API-key key. */
export const byApiKey = (c: Context<AppEnv>) => c.var.actor?.key?.id ?? null;
