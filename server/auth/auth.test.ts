import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { meResponseSchema } from '@shared/schemas/core';
import * as s from '../db/schema';
import {
  cookieHeader,
  createTestContext,
  createUser,
  signIn,
  web,
  type TestContext,
} from '../test/helpers';
import { isValidUsername } from './auth';
import { mailboxDir } from './mailer';

let ctx: TestContext;

afterEach(() => {
  // Not every test builds a context.
  ctx?.close();
});

function setup(env: Record<string, string> = {}): TestContext {
  ctx = createTestContext({ env: { E2E_MAILBOX: 'true', LOG_LEVEL: 'silent', ...env } });
  return ctx;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return ctx.app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ctx.env.baseUrl, ...headers },
    body: JSON.stringify(body),
  });
}

interface MailboxEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  code: string;
}

function mailbox(): MailboxEmail[] {
  const dir = mailboxDir(ctx.dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as MailboxEmail);
}

function lastCode(to: string, kind: string): string {
  const email = mailbox()
    .filter((mail) => mail.to === to && mail.kind === kind)
    .at(-1);
  if (!email) throw new Error(`no ${kind} email to ${to}`);
  return email.code;
}

function securityActions(userId: string): string[] {
  return ctx.db.orm
    .select({ action: s.activity.action })
    .from(s.activity)
    .where(and(eq(s.activity.actorId, userId), isNull(s.activity.teamId)))
    .all()
    .map((row) => row.action);
}

const signUp = (overrides: Record<string, unknown> = {}) =>
  post('/api/auth/sign-up/email', {
    email: 'Ethan@Example.test',
    password: 'hunter2hunter2',
    name: 'Ethan',
    username: 'Ethan_1',
    ...overrides,
  });

describe('username rules', () => {
  it('accepts [a-z0-9_] 3–32 and rejects reserved names', () => {
    expect(isValidUsername('ethan_1')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(33))).toBe(false);
    expect(isValidUsername('with-dash')).toBe(false);
    expect(isValidUsername('admin')).toBe(false);
    expect(isValidUsername('everyone')).toBe(false);
  });
});

describe('email sign-up with verification code', () => {
  it('requires a username and rejects reserved or invalid ones', async () => {
    setup();
    expect((await signUp({ username: undefined })).status).toBe(400);
    expect((await signUp({ username: 'Admin' })).status).toBe(400);
    expect((await signUp({ username: 'no spaces' })).status).toBe(400);
    expect(ctx.db.orm.select().from(s.user).all()).toHaveLength(0);
  });

  it('rate limits sign-up attempts per client', async () => {
    setup();
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await signUp({ password: 'short' })).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  it('creates an unverified user, emails a 6-digit code and verifies with it', async () => {
    setup();
    const res = await signUp();
    expect(res.status).toBe(200);
    const user = ctx.db.orm.select().from(s.user).get();
    expect(user).toMatchObject({
      email: 'ethan@example.test',
      username: 'ethan_1',
      emailVerified: false,
      theme: 'system',
    });
    expect(user?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const [email] = mailbox();
    expect(email).toMatchObject({ to: 'ethan@example.test', kind: 'email-verification' });
    expect(email?.code).toMatch(/^\d{6}$/);
    expect(email?.text).toContain(email?.code);
    expect(email?.html).toContain(email?.code);
    expect(email?.html).toContain('10 minutes');

    // Unverified users cannot sign in.
    const blocked = await post('/api/auth/sign-in/email', {
      email: 'ethan@example.test',
      password: 'hunter2hunter2',
    });
    expect(blocked.status).toBe(403);

    const verified = await post('/api/auth/email-otp/verify-email', {
      email: 'ethan@example.test',
      otp: lastCode('ethan@example.test', 'email-verification'),
    });
    expect(verified.status).toBe(200);
    const cookie = cookieHeader(verified);
    expect(cookie).toContain('baton.session_token=');

    const me = await ctx.app.request('/api/me', { headers: web(ctx, cookie) });
    expect(me.status).toBe(200);
    const body = meResponseSchema.parse(await me.json());
    expect(body.user).toMatchObject({ username: 'ethan_1', emailVerified: true });

    const userId = user?.id ?? '';
    expect(securityActions(userId)).toEqual(['user.signed_up', 'user.signed_in']);
  });

  it('allows at most 5 attempts per code', async () => {
    setup();
    await signUp();
    const code = lastCode('ethan@example.test', 'email-verification');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const res = await post('/api/auth/email-otp/verify-email', {
        email: 'ethan@example.test',
        otp: wrong,
      });
      expect(res.status).toBe(400);
    }
    const tooMany = await post('/api/auth/email-otp/verify-email', {
      email: 'ethan@example.test',
      otp: code,
    });
    expect(tooMany.status).toBe(403);
  });

  it('enforces a resend cooldown', async () => {
    setup();
    await signUp();
    const first = await post('/api/auth/email-otp/send-verification-otp', {
      email: 'ethan@example.test',
      type: 'email-verification',
    });
    expect(first.status).toBe(200);
    const second = await post('/api/auth/email-otp/send-verification-otp', {
      email: 'ethan@example.test',
      type: 'email-verification',
    });
    expect(second.status).toBe(429);
  });

  it('never signs anyone in or up with a code alone', async () => {
    setup();
    const res = await post('/api/auth/sign-in/email-otp', {
      email: 'x@example.test',
      otp: '123456',
    });
    expect(res.status).toBe(404);
  });

  it('blocks new accounts when SIGNUPS_ENABLED=false', async () => {
    setup({ SIGNUPS_ENABLED: 'false' });
    const res = await signUp();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(ctx.db.orm.select().from(s.user).all()).toHaveLength(0);
    const config = await ctx.app.request('/api/config');
    expect(await config.json()).toMatchObject({ signupsEnabled: false });
  });
});

describe('sign-in, sessions and password changes', () => {
  it('signs in by email or username with a SameSite=Lax HttpOnly cookie', async () => {
    setup();
    const user = createUser(ctx.db, { username: 'mia', email: 'mia@example.test' });
    const cookie = await signIn(ctx, user, 'a long password');
    expect(cookie).toContain('baton.session_token=');

    const byUsername = await post('/api/auth/sign-in/username', {
      username: 'MIA',
      password: 'a long password',
    });
    expect(byUsername.status).toBe(200);
    const setCookie = byUsername.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(securityActions(user.id)).toEqual(['user.signed_in', 'user.signed_in']);
  });

  it('uses Secure cookies in production', async () => {
    setup({
      NODE_ENV: 'production',
      BASE_URL: 'https://baton.example.test',
      BETTER_AUTH_SECRET: 'x'.repeat(40),
    });
    const user = createUser(ctx.db, { email: 'prod@example.test' });
    const { addPassword } = await import('../test/helpers');
    await addPassword(ctx.db, user.id, 'a long password');
    const res = await ctx.app.request('https://baton.example.test/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://baton.example.test' },
      body: JSON.stringify({ email: 'prod@example.test', password: 'a long password' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/__Secure-baton\.session_token=/);
    expect(setCookie).toMatch(/Secure/);
  });

  it('logs password changes in the security log', async () => {
    setup();
    const user = createUser(ctx.db, { email: 'pw@example.test' });
    const cookie = await signIn(ctx, user, 'old password!');
    const res = await post(
      '/api/auth/change-password',
      { currentPassword: 'old password!', newPassword: 'new password!' },
      { Cookie: cookie },
    );
    expect(res.status).toBe(200);
    expect(securityActions(user.id)).toContain('user.password_changed');
  });

  it('resets a password with an emailed code and revokes sessions', async () => {
    setup();
    const user = createUser(ctx.db, { email: 'reset@example.test' });
    const cookie = await signIn(ctx, user, 'forgotten password');
    const requested = await post('/api/auth/email-otp/request-password-reset', {
      email: 'reset@example.test',
    });
    expect(requested.status).toBe(200);
    const code = lastCode('reset@example.test', 'forget-password');
    expect(mailbox().at(-1)?.subject).toBe('Reset your Baton password');

    const reset = await post('/api/auth/email-otp/reset-password', {
      email: 'reset@example.test',
      otp: code,
      password: 'brand new password',
    });
    expect(reset.status).toBe(200);
    expect(securityActions(user.id)).toContain('user.password_reset');

    const stale = await ctx.app.request('/api/me', { headers: web(ctx, cookie) });
    expect(stale.status).toBe(401);
    await expect(
      signIn(ctx, user, 'brand new password', { addPassword: false }),
    ).resolves.toContain('baton.session_token=');
  });
});

// Regression (SEC-4): a verification code for an already-verified address signed its owner in
// (verify-email auto-signs in), i.e. a password-less login for anyone reading the mailbox.
describe('verification codes for verified addresses', () => {
  it('sends no code and never signs in', async () => {
    setup();
    createUser(ctx.db, { email: 'done@example.test' });
    const sent = await post('/api/auth/email-otp/send-verification-otp', {
      email: 'done@example.test',
      type: 'email-verification',
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ success: true });
    expect(mailbox()).toEqual([]);

    const verify = await post('/api/auth/email-otp/verify-email', {
      email: 'done@example.test',
      otp: '123456',
    });
    expect(verify.status).toBe(400);
    expect(verify.headers.getSetCookie()).toEqual([]);
    expect(ctx.db.orm.select().from(s.session).all()).toEqual([]);
  });

  it('sends only email-verification codes through send-verification-otp', async () => {
    setup();
    await signUp();
    const res = await post('/api/auth/email-otp/send-verification-otp', {
      email: 'ethan@example.test',
      type: 'sign-in',
    });
    expect(res.status).toBe(200);
    expect(mailbox().map((mail) => mail.kind)).toEqual(['email-verification']);
  });
});

// Regression (SEC-9): update-user accepted a 100,000-character name, any displayUsername and any
// image URL (a tracking pixel for every teammate).
describe('profile input through Better Auth', () => {
  async function setupUser() {
    setup();
    const user = createUser(ctx.db, { username: 'verified', email: 'v@example.test' });
    const cookie = await signIn(ctx, user);
    const update = (body: Record<string, unknown>) =>
      post('/api/auth/update-user', body, { Cookie: cookie });
    const stored = () => ctx.db.orm.select().from(s.user).where(eq(s.user.id, user.id)).get();
    return { user, update, stored };
  }

  it('bounds and trims the display name', async () => {
    const { update, stored } = await setupUser();
    expect((await update({ name: 'x'.repeat(100_000) })).status).toBe(400);
    expect((await update({ name: '   ' })).status).toBe(400);
    expect((await update({ name: '  Mia  ' })).status).toBe(200);
    expect(stored()?.name).toBe('Mia');
    expect((await signUp({ name: 'x'.repeat(65) })).status).toBe(400);
  });

  it('keeps displayUsername equal to the username', async () => {
    const { update, stored } = await setupUser();
    expect((await update({ displayUsername: 'ethan' })).status).toBe(400);
    expect((await update({ username: 'mia_2', displayUsername: 'someone' })).status).toBe(400);
    expect(stored()).toMatchObject({ username: 'verified', displayUsername: 'verified' });
    expect((await update({ displayUsername: 'Verified' })).status).toBe(200);
    expect(stored()).toMatchObject({ username: 'verified', displayUsername: 'Verified' });
    // A username change carries the display form along, so the old handle never lingers.
    expect((await update({ username: 'Mia_2' })).status).toBe(200);
    expect(stored()).toMatchObject({ username: 'mia_2', displayUsername: 'Mia_2' });
  });

  it('accepts only the user’s own avatar upload as image', async () => {
    const { user, update, stored } = await setupUser();
    expect((await update({ image: 'https://tracker.example/pixel.png' })).status).toBe(400);
    const avatar = ctx.db.orm
      .insert(s.attachment)
      .values({
        teamId: null,
        uploaderId: user.id,
        parentType: 'user_avatar',
        filename: 'me.png',
        mimeType: 'image/png',
        size: 1,
        sha256: 'x',
        storagePath: 'x',
      })
      .returning()
      .get();
    const url = `/api/attachments/${avatar.id}/me.png`;
    expect((await update({ image: url })).status).toBe(200);
    expect(stored()?.image).toBe(url);
    expect((await update({ image: null })).status).toBe(200);
    expect(stored()?.image).toBeNull();
    expect((await signUp({ image: url })).status).toBe(400);
  });
});

describe('config', () => {
  it('reports enabled social providers', async () => {
    setup({ GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs' });
    const res = await ctx.app.request('/api/config');
    expect(await res.json()).toMatchObject({ providers: { google: true, github: false } });
    const social = await post('/api/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
    expect(social.status).toBe(200);
    expect((await social.json()) as { url: string }).toMatchObject({
      url: expect.stringContaining('accounts.google.com') as unknown,
    });
    const github = await post('/api/auth/sign-in/social', { provider: 'github', callbackURL: '/' });
    expect(github.status).toBe(404);
  });
});
