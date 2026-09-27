import type { Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { actorMiddleware, signedInMiddleware } from '../middleware/actor';
import {
  AUTH_BODY_MAX_BYTES,
  JSON_BODY_MAX_BYTES,
  requestBodyLimit,
} from '../middleware/bodyLimit';
import { csrfMiddleware } from '../middleware/csrf';
import { byClientIp, byUser, rateLimit } from '../middleware/rateLimit';
import { accountRoutes } from './account';
import { activityRoutes } from './activity';
import { apiKeyRoutes } from './apiKeys';
import { attachmentRoutes } from './attachments';
import { auditLogRoutes } from './auditLog';
import { authRoutes } from './auth';
import { claimRoutes } from './claims';
import { dashboardRoutes } from './dashboard';
import { eventRoutes } from './events';
import { inviteRoutes } from './invites';
import { issueRoutes } from './issues';
import { labelRoutes } from './labels';
import { meRoutes } from './me';
import { memberRoutes } from './members';
import { myWorkRoutes } from './myWork';
import { notificationRoutes } from './notifications';
import { projectRoutes } from './projects';
import { reactionRoutes } from './reactions';
import { replyRoutes } from './replies';
import { roleRoutes } from './roles';
import { searchRoutes } from './search';
import { statusRoutes } from './statuses';
import { subscriptionRoutes } from './subscriptions';
import { taskLinkRoutes } from './taskLinks';
import { taskRoutes } from './tasks';
import { teamRoutes } from './teams';
import { trashRoutes } from './trash';
import { userRoutes } from './users';

/**
 * Every REST router, mounted under /api. Each file declares its own full paths (relative to /api)
 * and belongs to one module (SPEC §3). Add new routers here; keep the list grouped by module.
 */
const routers: ReadonlyArray<Hono<AppEnv>> = [
  // core
  authRoutes,
  meRoutes,
  apiKeyRoutes,
  notificationRoutes,
  attachmentRoutes,
  replyRoutes,
  reactionRoutes,
  activityRoutes,
  userRoutes,
  subscriptionRoutes,
  eventRoutes,
  // teams
  teamRoutes,
  memberRoutes,
  roleRoutes,
  inviteRoutes,
  // projects
  projectRoutes,
  statusRoutes,
  labelRoutes,
  // issues
  issueRoutes,
  // tasks
  taskRoutes,
  claimRoutes,
  taskLinkRoutes,
  // work
  myWorkRoutes,
  dashboardRoutes,
  // admin
  trashRoutes,
  auditLogRoutes,
  searchRoutes,
  // account
  accountRoutes,
];

/** Better Auth serves /api/auth/* itself (sessions, CSRF/origin checks, its own rate limits). */
function isAuthPath(path: string): boolean {
  return path === '/api/auth' || path.startsWith('/api/auth/');
}

/**
 * Better Auth endpoints that only read, although they are POSTs: the sign-up and onboarding forms
 * check username availability as the user types, which must not use up the 10/min/IP budget for
 * signing up and in. Better Auth's own limit (100/min/IP) still applies to them.
 */
const AUTH_READ_PATHS: ReadonlySet<string> = new Set(['/api/auth/is-username-available']);

/** The per-IP auth limit, skipping the read-only endpoints above. */
function authRateLimit(): MiddlewareHandler<AppEnv> {
  const limit = rateLimit({ name: 'auth', key: byClientIp, writesOnly: true });
  return (c, next) => (AUTH_READ_PATHS.has(c.req.path) ? next() : limit(c, next));
}

function exceptAuth(middleware: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return (c, next) => (isAuthPath(c.req.path) ? next() : middleware(c, next));
}

/** Upload routes, which stream multipart bodies under their own (larger) size limits. */
const UPLOAD_PATHS: ReadonlySet<string> = new Set(['/api/attachments', '/api/me/avatar']);

/** The JSON body limit, except for the upload routes' multipart bodies. */
function jsonBodyLimit(): MiddlewareHandler<AppEnv> {
  const limit = requestBodyLimit(JSON_BODY_MAX_BYTES);
  return (c, next) =>
    c.req.method === 'POST' && UPLOAD_PATHS.has(c.req.path) ? next() : limit(c, next);
}

/**
 * Mounts every router under /api behind the shared middleware: auth endpoints are rate limited per
 * IP and take small bodies only; everything else resolves the actor (session cookie or API key,
 * plus the verification and username guards), turns anonymous requests away with a 401 before
 * any body is read, enforces CSRF for cookie requests, rate limits writes per user and caps the
 * body size. (`GET /api/config`, the one public endpoint, is registered on the app before this.)
 */
export function mountApiRoutes(api: Hono<AppEnv>): void {
  api.use('/auth/*', authRateLimit());
  api.use('/auth/*', requestBodyLimit(AUTH_BODY_MAX_BYTES));
  api.use('*', exceptAuth(actorMiddleware()));
  api.use('*', exceptAuth(signedInMiddleware()));
  api.use('*', exceptAuth(csrfMiddleware()));
  api.use('*', exceptAuth(rateLimit({ name: 'writes', key: byUser, writesOnly: true })));
  api.use('*', exceptAuth(jsonBodyLimit()));
  for (const router of routers) api.route('/', router);
}
