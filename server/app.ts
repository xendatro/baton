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
import { AppError, errors, type ErrorCode } from './lib/errors';
import { toValidationIssues } from './lib/validate';
import { mountApiRoutes } from './routes';
import { VERSION } from './version';

export interface CreateAppOptions extends AppDeps {
  /**
   * Folder with the built SPA (`dist/web`). When set and it contains index.html, static files are
   * served and unknown GET paths fall back to index.html. Null in development (Vite serves the SPA).
   */
  webDir?: string | null;
}

/** Paths that never fall back to the SPA. */
const NON_SPA_PREFIXES = ['/api', '/mcp', '/healthz'];

function isNonSpaPath(requestPath: string): boolean {
  return NON_SPA_PREFIXES.some(
    (prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`),
  );
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
    const log = logger.child({ reqId: c.var.requestId });
    c.set('deps', deps);
    c.set('logger', log);
    c.set('actor', null);
    const started = performance.now();
    await next();
    const entry = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    };
    if (c.req.path === '/healthz') log.debug(entry, 'request');
    else log.info(entry, 'request');
  });

  // --- Security headers (SPEC §5) ----------------------------------------------------------
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

  // --- SPA ---------------------------------------------------------------------------------
  const indexFile = webDir ? path.join(webDir, 'index.html') : null;
  if (webDir && indexFile && fs.existsSync(indexFile)) {
    const indexHtml = fs.readFileSync(indexFile, 'utf8');
    const staticFiles = serveStatic<AppEnv>({ root: webDir });

    app.get('*', async (c, next) => {
      if (isNonSpaPath(c.req.path) || c.req.path.endsWith('/')) return next();
      const response = await staticFiles(c, next);
      // A Response means a file was served (otherwise serveStatic already ran the SPA fallback).
      if (!(response instanceof Response)) return;
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
