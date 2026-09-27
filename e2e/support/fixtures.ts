import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { E2E_BASE_URL, E2E_DATA_DIR } from './env.ts';

/**
 * Shared e2e helpers. Every test gets its own client IP (sent as CF-Connecting-IP; the e2e server
 * runs with TRUST_PROXY=cloudflare), so the per-IP auth rate limits never leak between tests, and
 * its own freshly named users, so tests can run in any order against one server.
 */

export const test = base.extend({
  // Playwright fixtures must destructure their first argument, even when they use no fixture.
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({
      'CF-Connecting-IP': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    });
  },
});

export { expect };

export interface TestUser {
  name: string;
  username: string;
  email: string;
  password: string;
}

/** A user nobody has signed up with yet (lowercase, `[a-z0-9_]`, well under 32 characters). */
export function newUser(): TestUser {
  const suffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  return {
    name: `E2E ${suffix}`,
    username: `e2e_${suffix}`,
    email: `e2e_${suffix}@example.test`,
    password: `Correct-horse-${suffix}`,
  };
}

/** Headers for requests that change data: Better Auth and the CSRF guard both check the origin. */
export const ORIGIN = { Origin: E2E_BASE_URL };

type OtpKind = 'email-verification' | 'forget-password';

interface MailboxEmail {
  to: string;
  subject: string;
  text: string;
  kind?: string;
  code?: string;
  sentAt: string;
}

/** Every email sent to `to` (optionally of one kind), oldest first. */
export function mailbox(to: string, kind?: OtpKind): MailboxEmail[] {
  const dir = path.join(E2E_DATA_DIR, 'mailbox');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as MailboxEmail)
    .filter((email) => email.to === to && (kind === undefined || email.kind === kind));
}

/** The newest one-time code emailed to `to`, waiting for it to arrive. */
export async function readCode(to: string, kind: OtpKind): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(() => (code = mailbox(to, kind).at(-1)?.code), { message: `${kind} code for ${to}` })
    .toMatch(/^\d{6}$/);
  return code as string;
}

async function expectOk(response: Awaited<ReturnType<APIRequestContext['post']>>, what: string) {
  expect(response.ok(), `${what}: ${response.status()} ${await response.text()}`).toBe(true);
}

/**
 * Signs `user` up and verifies the emailed code through the REST API. Verifying signs in, so the
 * request context (for `page.request`: the browser) ends up holding the session cookie.
 */
export async function createVerifiedUser(
  request: APIRequestContext,
  user: TestUser = newUser(),
): Promise<TestUser> {
  await expectOk(
    await request.post('/api/auth/sign-up/email', { data: user, headers: ORIGIN }),
    'sign up',
  );
  const otp = await readCode(user.email, 'email-verification');
  await expectOk(
    await request.post('/api/auth/email-otp/verify-email', {
      data: { email: user.email, otp },
      headers: ORIGIN,
    }),
    'verify email',
  );
  return user;
}

/** A verified user whose session lives in the page's browser context (signed in). */
export async function signedInUser(page: Page): Promise<TestUser> {
  return createVerifiedUser(page.request);
}

/**
 * Writes to the e2e server's database directly, for states the API can't produce on purpose (an
 * OAuth user who hasn't chosen a username yet). WAL mode lets this run beside the server.
 */
export function withDatabase<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(E2E_DATA_DIR, 'baton.db'));
  try {
    db.pragma('busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

/** Types a code into the one-time-code boxes digit by digit, as a person would. */
export async function typeCode(page: Page, code: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Digit 1 of 6' }).click();
  await page.keyboard.type(code);
}

export interface StageJson {
  id: string;
  name: string;
}

/**
 * Trims a new project's default pipeline (Backlog, To do, In progress, In review, Done since
 * 2026-09-27) to the two stages the older specs were written for: Open (Backlog renamed, the
 * default) and Done. Specs about boards, moves and tasks rather than the seeded stages use it, so
 * a card still reaches Done in one move. Returns `[open, done]`.
 */
export async function trimToOpenAndDone(
  request: APIRequestContext,
  projectId: string,
): Promise<[StageJson, StageJson]> {
  const res = await request.get(`/api/projects/${projectId}/statuses`);
  expect(res.ok(), await res.text()).toBe(true);
  const { items } = (await res.json()) as { items: StageJson[] };
  const backlog = items.find((item) => item.name === 'Backlog');
  const done = items.find((item) => item.name === 'Done');
  if (!backlog || !done) throw new Error('A new project should have Backlog and Done');
  for (const item of items) {
    if (item.id === backlog.id || item.id === done.id) continue;
    const removed = await request.delete(`/api/statuses/${item.id}?moveTo=${backlog.id}`, {
      headers: ORIGIN,
    });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
  const renamed = await request.patch(`/api/statuses/${backlog.id}`, {
    data: { name: 'Open', icon: 'circle' },
    headers: ORIGIN,
  });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  return [{ id: backlog.id, name: 'Open' }, done];
}
