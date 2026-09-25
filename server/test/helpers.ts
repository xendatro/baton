import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../app';
import type { AppDeps, AppEnv } from '../context';
import { openDatabase, type Database } from '../db';
import { runMigrations } from '../db/migrate';
import { parseEnv, type Env } from '../env';
import { createEventBus } from '../lib/eventBus';
import { dataPaths, ensureDataDirs } from '../lib/paths';
import { createLogger } from '../logger';

export * from './fixtures';

export interface TestContext {
  env: Env;
  db: Database;
  deps: AppDeps;
  app: Hono<AppEnv>;
  /** Temporary DATA_DIR, removed by `close()`. */
  dataDir: string;
  /** Closes the database and deletes the temporary DATA_DIR. */
  close(): void;
}

export interface TestContextOptions {
  /** Extra environment variables (NODE_ENV=test and DATA_DIR are set for you). */
  env?: Record<string, string>;
  /** Built SPA folder to serve (see createApp). */
  webDir?: string | null;
}

/**
 * A fully wired app on a fresh, migrated SQLite database in a temp DATA_DIR. Typical use:
 *
 *   let ctx: TestContext;
 *   beforeEach(() => { ctx = createTestContext(); });
 *   afterEach(() => ctx.close());
 *   const res = await ctx.app.request('/api/me', { headers: bearer(key) });
 */
export function createTestContext(options: TestContextOptions = {}): TestContext {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'));
  const env = parseEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, ...options.env });
  const paths = dataPaths(env.dataDir);
  ensureDataDirs(paths);
  const db = openDatabase(paths.database);
  runMigrations(db);
  const logger = createLogger(env);
  const deps: AppDeps = { env, db, logger, events: createEventBus(logger) };
  const app = createApp({ ...deps, webDir: options.webDir ?? null });
  return {
    env,
    db,
    deps,
    app,
    dataDir,
    close() {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** `Authorization: Bearer <key>` header for API-key requests. */
export function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** JSON request init: `ctx.app.request('/api/x', json('POST', body, bearer(key)))`. */
export function json(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
