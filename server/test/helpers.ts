import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../app';
import type { AppDeps, AppEnv } from '../context';
import type { Database } from '../db';
import { runMigrations } from '../db/migrate';
import { createAppDeps } from '../deps';
import { parseEnv, type Env } from '../env';
import { dataPaths, ensureDataDirs } from '../lib/paths';
import { createLogger } from '../logger';

import { addPassword } from './fixtures';

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
  const deps = createAppDeps({ env, logger: createLogger(env), databaseFile: paths.database });
  const { db } = deps;
  runMigrations(db);
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

/**
 * Signs `user` in through Better Auth (adding the password first when given) and returns the
 * `Cookie` header value of the session.
 */
export async function signIn(
  ctx: TestContext,
  user: { email: string; id: string },
  password = 'correct horse battery staple',
  options: { addPassword?: boolean } = {},
): Promise<string> {
  if (options.addPassword !== false) await addPassword(ctx.db, user.id, password);
  const res = await ctx.app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.env.baseUrl },
    body: JSON.stringify({ email: user.email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return cookieHeader(res);
}

/** `Cookie` header value built from a response's `Set-Cookie` headers. */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

/** Headers of a same-origin browser request with a session cookie. */
export function web(ctx: TestContext, cookie: string): Record<string, string> {
  return { Cookie: cookie, Origin: ctx.env.baseUrl };
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
