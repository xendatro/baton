import type { Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../context';
import { actorMiddleware } from '../middleware/actor';
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

function exceptAuth(middleware: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> {
  return (c, next) => (isAuthPath(c.req.path) ? next() : middleware(c, next));
}

/**
 * Mounts every router under /api behind the shared middleware: auth endpoints are rate limited per
 * IP; everything else resolves the actor (session cookie or API key, plus the verification and
 * username guards), enforces CSRF for cookie requests and rate limits writes per user.
 */
export function mountApiRoutes(api: Hono<AppEnv>): void {
  api.use('/auth/*', rateLimit({ name: 'auth', key: byClientIp, writesOnly: true }));
  api.use('*', exceptAuth(actorMiddleware()));
  api.use('*', exceptAuth(csrfMiddleware()));
  api.use('*', exceptAuth(rateLimit({ name: 'writes', key: byUser, writesOnly: true })));
  for (const router of routers) api.route('/', router);
}
