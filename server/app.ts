import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import type { ConfigResponse } from '@shared/schemas/core';
import type { AppDeps, AppEnv } from './context';
import { clientIp } from './lib/clientIp';
import { AppError, errors, PendingApproval, type ErrorCode } from './lib/errors';
import { loggedPath, runWithRequestLogger } from './lib/requestContext';
import { toValidationIssues } from './lib/validate';
import { mcpRoutes } from './mcp/server';
import { mountApiRoutes } from './routes';
import { attachmentDownloadHeaders } from './routes/attachments';
import { VERSION } from './version';

export interface CreateAppOptions extends AppDeps {
  /**
   * Folder with the built SPA (`dist/web`). When set and it contains index.html, static files are
   * served and unknown GET paths fall back to index.html. Null in development (Vite serves the SPA).
   */
  webDir?: string | null;
}

export { loggedPath };

/** Paths that never fall back to the SPA. */
const NON_SPA_PREFIXES = ['/api', '/mcp', '/healthz'];

function isNonSpaPath(requestPath: string): boolean {
  return NON_SPA_PREFIXES.some(
    (prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`),
  );
}

/** Longest user agent the request log keeps. */
const USER_AGENT_LOG_MAX = 200;

/**
 * Requests answered with a file from the SPA build (`/assets/*`, `/theme-init.js`, …): logged at
 * debug, since one page load fetches dozens of them.
 */
const staticFileRequests = new WeakSet<Context>();

/** Source maps are never served, even when a build left some in the web folder. */
function isSourceMap(requestPath: string): boolean {
  return requestPath.endsWith('.map');
}

const HTTP_STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'validation_failed',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'payload_too_large',
  429: 'rate_limited',
};

function errorResponse(c: Context<AppEnv>, error: AppError) {
  return c.json(error.toJSON(), error.status);
}

/** Builds the Hono app. Pure: no listening, no jobs — tests call this with their own deps. */
export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { webDir = null, ...deps } = options;
  const { env, logger } = deps;
  const app = new Hono<AppEnv>();

  // --- Request context: id, deps, logger ---------------------------------------------------
  app.use(requestId());
  app.use(async (c, next) => {
    const ip = clientIp(c, env.trustProxy);
    // Every line logged for the request carries its id and the client's address.
    const log = logger.child({ reqId: c.var.requestId, ...(ip ? { ip } : {}) });
    c.set('deps', deps);
    c.set('logger', log);
    c.set('actor', null);
    c.set('sessionId', null);
    c.set('clientIp', ip);
    const started = performance.now();
    await runWithRequestLogger(log, next);
    const { actor } = c.var;
    const entry = {
      method: c.req.method,
      path: loggedPath(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      userId: actor?.userId,
      // The person behind an agent member (agents A).
      ownerId: actor?.ownerId,
      keyId: actor?.key?.id,
      ua: c.req.header('user-agent')?.slice(0, USER_AGENT_LOG_MAX),
    };
    if (c.req.path === '/healthz' || staticFileRequests.has(c)) log.debug(entry, 'request');
    else log.info(entry, 'request');
  });

  // --- Security headers (SPEC §5) ----------------------------------------------------------
  // Before secureHeaders, so its download CSP replaces the app-wide one on the way out.
  app.use('/api/attachments/:id/:filename', attachmentDownloadHeaders);
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      xFrameOptions: 'DENY',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xContentTypeOptions: 'nosniff',
      crossOriginResourcePolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin',
      strictTransportSecurity: env.isProduction ? 'max-age=31536000; includeSubDomains' : false,
    }),
  );

  // --- Errors ------------------------------------------------------------------------------
  app.onError((error, c) => {
    if (error instanceof AppError) return errorResponse(c, error);
    // An agent's destructive action now waits for its owner's sign-off (design §6).
    if (error instanceof PendingApproval) return c.json(error.body, 202);
    if (error instanceof ZodError) {
      return errorResponse(
        c,
        errors.validation('Invalid input', { issues: toValidationIssues(error) }),
      );
    }
    if (error instanceof HTTPException && error.status < 500) {
      const code = HTTP_STATUS_CODES[error.status] ?? 'validation_failed';
      return errorResponse(c, new AppError(code, error.status, error.message || code));
    }
    c.var.logger.error({ err: error }, 'unhandled error');
    return errorResponse(c, errors.internal());
  });

  app.notFound((c) =>
    errorResponse(c, errors.notFound(isNonSpaPath(c.req.path) ? 'Endpoint' : 'Page')),
  );

  // --- Health & public config --------------------------------------------------------------
  app.get('/healthz', (c) => {
    try {
      deps.db.sqlite.prepare('select 1').get();
    } catch (error) {
      c.var.logger.error({ err: error }, 'health check failed');
      return c.json({ ok: false, version: VERSION }, 503);
    }
    return c.json({ ok: true, version: VERSION });
  });

  app.get('/api/config', (c) =>
    c.json({
      version: VERSION,
      signupsEnabled: env.signupsEnabled,
      providers: { google: env.google !== null, github: env.github !== null },
      maxUploadMb: env.maxUploadMb,
    } satisfies ConfigResponse),
  );

  // --- REST API ----------------------------------------------------------------------------
  const api = new Hono<AppEnv>();
  mountApiRoutes(api);
  app.route('/api', api);

  // --- MCP (Streamable HTTP, stateless) ------------------------------------------------------
  app.route('/', mcpRoutes);

  // --- SPA ---------------------------------------------------------------------------------
  const indexFile = webDir ? path.join(webDir, 'index.html') : null;
  if (webDir && indexFile && fs.existsSync(indexFile)) {
    const indexHtml = fs.readFileSync(indexFile, 'utf8');
    const staticFiles = serveStatic<AppEnv>({ root: webDir });

    app.get('*', async (c, next) => {
      if (isNonSpaPath(c.req.path) || c.req.path.endsWith('/')) return next();
      if (isSourceMap(c.req.path)) throw errors.notFound('Page');
      const response = await staticFiles(c, next);
      // A Response means a file was served (otherwise serveStatic already ran the SPA fallback).
      if (!(response instanceof Response)) return;
      staticFileRequests.add(c);
      // Vite emits content-hashed names under /assets; everything else must revalidate.
      response.headers.set(
        'Cache-Control',
        c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return response;
    });
    app.get('*', (c) => {
      if (isNonSpaPath(c.req.path)) throw errors.notFound('Endpoint');
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  } else if (webDir) {
    // Expected in development, where Vite serves the SPA; a misdeployment in production.
    logger[env.isProduction ? 'warn' : 'debug'](
      { webDir },
      'SPA build not found (run `npm run build:web`); serving the API only',
    );
  }

  return app;
}
