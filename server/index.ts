/**
 * Production/development entrypoint: env → database + migrations → app → HTTP server → jobs.
 * Shuts down gracefully on SIGINT/SIGTERM (systemd stop, Ctrl+C).
 */
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { runMigrations } from './db/migrate';
import { createAppDeps } from './deps';
import { EnvError, loadDotEnv, parseEnv, type Env } from './env';
import { startJobs } from './jobs';
import { dataPaths, ensureDataDirs } from './lib/paths';
import { createLogger } from './logger';
import { VERSION } from './version';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const DRAIN_MS = 2_000;

function loadEnv(): Env {
  loadDotEnv();
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();
const logger = createLogger(env);
const paths = dataPaths(env.dataDir);
ensureDataDirs(paths);

const deps = createAppDeps({ env, logger, databaseFile: paths.database });
const { db } = deps;
runMigrations(db);

// The SPA build (dist/web) is resolved from the working directory, like Hono's serveStatic.
const app = createApp({ ...deps, webDir: path.resolve('dist', 'web') });

const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  logger.info(
    { version: VERSION, url: `http://${info.address}:${info.port}`, baseUrl: env.baseUrl },
    'Baton listening',
  );
});
const jobs = startJobs(deps);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  jobs.stop();
  const forceExit = setTimeout(() => {
    logger.warn('graceful shutdown timed out; exiting');
    db.close();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  server.close(() => {
    db.close();
    logger.info('bye');
    process.exit(0);
  });
  if ('closeIdleConnections' in server) {
    server.closeIdleConnections();
    // Give in-flight requests a moment, then drop long-lived ones (SSE) so close() can finish.
    setTimeout(() => server.closeAllConnections(), DRAIN_MS).unref();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
