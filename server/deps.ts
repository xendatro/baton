import { createAuth } from './auth/auth';
import { createMailer } from './auth/mailer';
import type { AppDeps } from './context';
import { openDatabase } from './db';
import type { Env } from './env';
import { createEventBus } from './lib/eventBus';
import { createGithubClient } from './lib/github';
import { createRateLimiter } from './lib/rateLimit';
import type { Logger } from './logger';

/**
 * Wires the process-wide dependencies: the event bus (which also receives the live events queued
 * inside database transactions, after commit), the database, mailer, rate limiter and Better Auth.
 * Used by the entrypoint and by tests, so every app instance gets its own set.
 */
export function createAppDeps(options: {
  env: Env;
  logger: Logger;
  databaseFile: string;
}): AppDeps {
  const { env, logger } = options;
  const events = createEventBus(logger);
  const db = openDatabase(options.databaseFile, {
    onCommittedEvents: (queued) => {
      for (const event of queued) events.emit(event);
    },
  });
  const mailer = createMailer(env, logger);
  const rateLimiter = createRateLimiter();
  const auth = createAuth({ env, db, logger, mailer, rateLimiter });
  return {
    env,
    db,
    logger,
    events,
    mailer,
    auth,
    rateLimiter,
    github: createGithubClient(env, logger),
  };
}
