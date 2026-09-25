import type { ActorSource } from '@shared/constants';
import type { Auth } from './auth/auth';
import type { Mailer } from './auth/mailer';
import type { Database } from './db';
import type { Env } from './env';
import type { EventBus } from './lib/eventBus';
import type { RateLimiter } from './lib/rateLimit';
import type { Logger } from './logger';

/** The API key a request authenticated with. */
export interface ActorKey {
  id: string;
  name: string;
}

/**
 * Who is performing an action. Every service function takes one. `key` is set when an agent or
 * script acts through an API key ("ethan via Claude on laptop"); null for the web session.
 */
export interface Actor {
  userId: string;
  source: ActorSource;
  key: ActorKey | null;
}

/**
 * Process-wide dependencies handed to routes, MCP tools, jobs and services. Tests build their own
 * (server/test/helpers.ts), so nothing here may be a module-level singleton.
 */
export interface AppDeps {
  env: Env;
  db: Database;
  logger: Logger;
  events: EventBus;
  /** Outgoing email (verification and reset codes). */
  mailer: Mailer;
  /** Better Auth instance (sessions, sign-in, OAuth). */
  auth: Auth;
  /** In-memory token buckets for every rate limit (SPEC §5). */
  rateLimiter: RateLimiter;
}

/** Hono environment for every router: `c.var.deps`, `c.var.logger`, `c.var.actor`, … */
export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    /** Request-scoped child logger (carries the request id). */
    logger: Logger;
    /** Client IP (CF-Connecting-IP behind Cloudflare, else the socket address); null if unknown. */
    clientIp: string | null;
    /** Set by the auth middleware; null on unauthenticated requests. */
    actor: Actor | null;
    /** Better Auth session id of a `web` actor (null for API keys and anonymous requests). */
    sessionId: string | null;
  };
}
