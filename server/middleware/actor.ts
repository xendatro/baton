import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Actor, AppEnv } from '../context';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { agentPauseReason } from '../services/agents';
import { authenticateApiKey } from '../services/apiKeys';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authentication for the REST API (SPEC §5): a Better Auth session cookie gives a `web` actor;
 * `Authorization: Bearer bat_…` gives an `api` actor: the key owner's agent member, acting via
 * that key (writes answer 423 `agents_paused` while its owner has paused it). A presented key that is
 * unknown, revoked or expired is a 401 even if a session cookie is present too. Signed-in users
 * with an unverified email or no username get 403 `email_not_verified` / `username_required`
 * everywhere except `GET /api/me` (the web app needs it to route them to verification/onboarding).
 */

/** Paths (relative to the app) that unverified and username-less users may call. */
function isOnboardingExempt(c: Context<AppEnv>): boolean {
  return c.req.method === 'GET' && c.req.path === '/api/me';
}

/** Reads the bearer token, or null without an Authorization header. Malformed headers are 401. */
export function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header === undefined) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  if (!match?.[1]) throw errors.unauthorized('Malformed Authorization header: use "Bearer bat_…"');
  return match[1];
}

export function actorMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.var.deps;
    const token = bearerToken(c);
    let user: { emailVerified: boolean; username?: string | null | undefined } | null = null;
    let refreshedCookies: string[] = [];

    if (token !== null) {
      const authenticated = authenticateApiKey(deps, token);
      if (!authenticated) throw errors.unauthorized('Invalid, expired or revoked API key');
      c.set('actor', {
        userId: authenticated.userId,
        ownerId: authenticated.ownerId,
        source: 'api',
        key: authenticated.key,
      });
      // The key acts as the owner's agent; the owner's verification and username gate it.
      user =
        deps.db.orm
          .select({ emailVerified: s.user.emailVerified, username: s.user.username })
          .from(s.user)
          .where(eq(s.user.id, authenticated.ownerId))
          .get() ?? null;
      if (!user) throw errors.unauthorized('Invalid, expired or revoked API key');
      if (!SAFE_METHODS.has(c.req.method)) {
        // A paused agent can read but not write (team and project pauses: recordActivity).
        const reason = agentPauseReason(
          deps.db.orm,
          { agentId: authenticated.userId, ownerId: authenticated.ownerId },
          null,
        );
        if (reason) throw errors.agentsPaused(reason);
      }
    } else {
      const { headers, response: session } = await deps.auth.api.getSession({
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      if (session) {
        c.set('actor', { userId: session.user.id, source: 'web', key: null });
        c.set('sessionId', session.session.id);
        user = session.user;
      }
      // Rolling sessions: Better Auth may have extended the session; forward its cookie.
      refreshedCookies = headers.getSetCookie();
    }

    if (user && !isOnboardingExempt(c)) {
      if (!user.emailVerified) throw errors.emailNotVerified();
      if (!user.username) throw errors.usernameRequired();
    }
    await next();
    for (const cookie of refreshedCookies) c.res.headers.append('Set-Cookie', cookie);
  };
}

/** The authenticated actor, or 401. Routes call this first. */
export function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.var.actor;
  if (!actor) throw errors.unauthorized();
  return actor;
}

/**
 * 401 for anonymous requests, before any route reads, parses or validates the body (a route's
 * validators run before its handler's `requireActor`). Runs after `actorMiddleware`.
 */
export function signedInMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    requireActor(c);
    await next();
  };
}
