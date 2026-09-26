import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../logger';
import { inviteCodeHint } from './security';

/**
 * The request-scoped logger (request id, client IP) for code that runs inside a request but is
 * not handed the Hono context, such as Better Auth's logger: its "Invalid password" and "User not
 * found" warnings then say which request and address they are about.
 */
const requestLoggers = new AsyncLocalStorage<Logger>();

/** Runs `fn` (and everything it awaits) with `logger` as the current request logger. */
export function runWithRequestLogger<T>(logger: Logger, fn: () => T): T {
  return requestLoggers.run(logger, fn);
}

/** The current request's logger, or `fallback` outside a request (jobs, startup). */
export function currentLogger(fallback: Logger): Logger {
  return requestLoggers.getStore() ?? fallback;
}

/**
 * Paths whose next segment is a secret: invite codes (the join page and the invite
 * preview/accept endpoints) are working join links, and Better Auth's password-reset callback
 * carries a reset token.
 */
const SECRET_PATH_SEGMENT = /^(\/api\/invites\/|\/join\/|\/api\/auth\/reset-password\/)([^/]+)/;

/**
 * The request path as the request log records it: secret path segments are cut to a hint
 * (`/api/invites/DtYC…/accept`). Query strings are never logged.
 */
export function loggedPath(requestPath: string): string {
  return requestPath.replace(
    SECRET_PATH_SEGMENT,
    (_match, prefix: string, secret: string) => `${prefix}${inviteCodeHint(secret)}`,
  );
}
