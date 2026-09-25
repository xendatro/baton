import type { ActorSource } from '@shared/constants';
import type { Database } from './db';
import type { Env } from './env';
import type { EventBus } from './lib/eventBus';
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
}

/** Hono environment for every router: `c.var.deps`, `c.var.logger`, `c.var.actor`, … */
export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    /** Request-scoped child logger (carries the request id). */
    logger: Logger;
    /** Set by the auth middleware; null on unauthenticated requests. */
    actor: Actor | null;
  };
}
