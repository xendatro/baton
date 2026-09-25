import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '@shared/constants';
import { apiErrorSchema } from '@shared/schemas/common';
import {
  apiKeyListResponseSchema,
  createApiKeyResponseSchema,
  meResponseSchema,
} from '@shared/schemas/core';
import * as s from '../db/schema';
import { hashApiKey } from '../lib/security';
import { authenticateApiKey } from '../services/apiKeys';
import {
  bearer,
  createApiKey,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
} from '../test/helpers';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

async function errorCode(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error.code;
}

describe('actor resolution', () => {
  it('authenticates a session cookie as a web actor', async () => {
    const user = createUser(ctx.db);
    const cookie = await signIn(ctx, user);
    const res = await ctx.app.request('/api/me', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).user.id).toBe(user.id);
  });

  it('authenticates a bearer key as an api actor', async () => {
    const user = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: user.id });
    const res = await ctx.app.request('/api/me', { headers: bearer(key) });
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(await res.json()).user.id).toBe(user.id);
  });

  it('rejects anonymous, unknown, malformed, revoked and expired credentials with 401', async () => {
    const user = createUser(ctx.db);
    const revoked = createApiKey(ctx.db, { userId: user.id, revokedAt: new Date() });
    const expired = createApiKey(ctx.db, { userId: user.id, expiresAt: new Date(Date.now() - 1) });
    const cases: Array<Record<string, string>> = [
      {},
      bearer(`bat_${'x'.repeat(40)}`),
      bearer('not-a-key'),
      { Authorization: 'Basic abc' },
      bearer(revoked.key),
      bearer(expired.key),
      { Cookie: 'baton.session_token=forged' },
    ];
    for (const headers of cases) {
      const res = await ctx.app.request('/api/me', { headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
  });

  it('prefers a presented key over a session and fails closed when it is invalid', async () => {
    const user = createUser(ctx.db);
    const cookie = await signIn(ctx, user);
    const res = await ctx.app.request('/api/me', {
      headers: { Cookie: cookie, ...bearer(`bat_${'y'.repeat(40)}`) },
    });
    expect(res.status).toBe(401);
  });

  it('updates lastUsedAt at most once a minute', () => {
    const user = createUser(ctx.db);
    const { key, apiKey } = createApiKey(ctx.db, { userId: user.id });
    const t0 = new Date('2026-01-01T00:00:00Z');
    const lastUsed = () =>
      ctx.db.orm.select().from(s.apiKey).where(eq(s.apiKey.id, apiKey.id)).get()?.lastUsedAt;

    expect(authenticateApiKey(ctx.deps, key, t0)?.key).toEqual({ id: apiKey.id, name: 'Test key' });
    expect(lastUsed()).toEqual(t0);
    authenticateApiKey(ctx.deps, key, new Date(t0.getTime() + 30_000));
    expect(lastUsed()).toEqual(t0);
    const later = new Date(t0.getTime() + 61_000);
    authenticateApiKey(ctx.deps, key, later);
    expect(lastUsed()).toEqual(later);
  });
});

describe('verification and username guards', () => {
  it('lets unverified users read /api/me only', async () => {
    const user = createUser(ctx.db, { emailVerified: false });
    const { key } = createApiKey(ctx.db, { userId: user.id });
    expect((await ctx.app.request('/api/me', { headers: bearer(key) })).status).toBe(200);
    const res = await ctx.app.request('/api/notifications', { headers: bearer(key) });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('email_not_verified');
  });

  it('sends users without a username to onboarding', async () => {
    const user = createUser(ctx.db, { username: null });
    const cookie = await signIn(ctx, user);
    const me = await ctx.app.request('/api/me', { headers: { Cookie: cookie } });
    expect(meResponseSchema.parse(await me.json()).user.username).toBeNull();
    const res = await ctx.app.request('/api/notifications', { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('username_required');
  });
});

describe('CSRF', () => {
  it('requires a matching Origin or Referer on cookie-authenticated writes', async () => {
    const user = createUser(ctx.db);
    const cookie = await signIn(ctx, user);
    const body = { all: true };
    const send = (headers: Record<string, string>) =>
      ctx.app.request(
        '/api/notifications/read',
        json('POST', body, { Cookie: cookie, ...headers }),
      );

    const missing = await send({});
    expect(missing.status).toBe(403);
    expect(await errorCode(missing)).toBe('forbidden');
    expect((await send({ Origin: 'https://evil.example' })).status).toBe(403);
    expect((await send({ Origin: 'null' })).status).toBe(403);
    expect((await send({ Referer: 'https://evil.example/page' })).status).toBe(403);
    expect((await send({ Origin: ctx.env.baseUrl })).status).toBe(200);
    expect((await send({ Referer: `${ctx.env.baseUrl}/inbox` })).status).toBe(200);
    // Reads need no Origin.
    expect(
      (await ctx.app.request('/api/notifications', { headers: { Cookie: cookie } })).status,
    ).toBe(200);
  });

  it('does not apply to API-key requests', async () => {
    const user = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: user.id });
    const res = await ctx.app.request(
      '/api/notifications/read',
      json('POST', { all: true }, bearer(key)),
    );
    expect(res.status).toBe(200);
  });
});

describe('rate limits', () => {
  it('limits REST writes per user with Retry-After', async () => {
    const user = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: user.id });
    let last: Response | undefined;
    for (let i = 0; i <= RATE_LIMITS.writesPerUser; i += 1) {
      last = await ctx.app.request(
        '/api/notifications/read',
        json('POST', { all: true }, bearer(key)),
      );
    }
    expect(last?.status).toBe(429);
    expect(await errorCode(last as Response)).toBe('rate_limited');
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
    // Reads are not counted.
    expect((await ctx.app.request('/api/notifications', { headers: bearer(key) })).status).toBe(
      200,
    );
  });

  it('limits auth endpoints per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= RATE_LIMITS.authPerIp; i += 1) {
      const res = await ctx.app.request(
        '/api/auth/sign-out',
        json('POST', {}, { Origin: ctx.env.baseUrl }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, RATE_LIMITS.authPerIp).every((status) => status !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('does not count username availability checks against the auth limit', async () => {
    for (let i = 0; i <= RATE_LIMITS.authPerIp; i += 1) {
      const res = await ctx.app.request(
        '/api/auth/is-username-available',
        json('POST', { username: `name${i}` }, { Origin: ctx.env.baseUrl }),
      );
      expect(res.status).toBe(200);
    }
    const signOut = await ctx.app.request(
      '/api/auth/sign-out',
      json('POST', {}, { Origin: ctx.env.baseUrl }),
    );
    expect(signOut.status).not.toBe(429);
  });
});

describe('API keys', () => {
  it('creates, lists and revokes keys from a web session, storing only a hash', async () => {
    const user = createUser(ctx.db);
    const cookie = await signIn(ctx, user);
    const created = await ctx.app.request(
      '/api/me/api-keys',
      json('POST', { name: 'Claude on laptop', expiresInDays: 30 }, web(ctx, cookie)),
    );
    expect(created.status).toBe(201);
    const { key, apiKey } = createApiKeyResponseSchema.parse(await created.json());
    expect(key).toMatch(/^bat_[0-9A-Za-z]{40}$/);
    expect(apiKey.prefix).toBe(key.slice(4, 12));
    expect(new Date(apiKey.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    const row = ctx.db.orm.select().from(s.apiKey).where(eq(s.apiKey.id, apiKey.id)).get();
    expect(row?.hash).toBe(hashApiKey(key));
    expect(JSON.stringify(row)).not.toContain(key);

    // The key works, and shows as the actor's key.
    expect((await ctx.app.request('/api/me', { headers: bearer(key) })).status).toBe(200);

    const list = apiKeyListResponseSchema.parse(
      await (await ctx.app.request('/api/me/api-keys', { headers: web(ctx, cookie) })).json(),
    );
    expect(list.apiKeys.map((k) => k.name)).toEqual(['Claude on laptop']);
    expect(list.apiKeys[0]?.lastUsedAt).not.toBeNull();

    const revoked = await ctx.app.request(`/api/me/api-keys/${apiKey.id}`, {
      method: 'DELETE',
      headers: web(ctx, cookie),
    });
    expect(await revoked.json()).toEqual({ ok: true });
    expect((await ctx.app.request('/api/me', { headers: bearer(key) })).status).toBe(401);

    const actions = ctx.db.orm
      .select({ action: s.activity.action, viaKeyName: s.activity.viaKeyName })
      .from(s.activity)
      .where(eq(s.activity.entityType, 'api_key'))
      .all();
    expect(actions).toEqual([
      { action: 'api_key.created', viaKeyName: null },
      { action: 'api_key.revoked', viaKeyName: null },
    ]);
  });

  it('cannot be managed with an API key, nor touch other users’ keys', async () => {
    const user = createUser(ctx.db);
    const other = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: user.id });
    const othersKey = createApiKey(ctx.db, { userId: other.id });
    const viaKey = await ctx.app.request(
      '/api/me/api-keys',
      json('POST', { name: 'x' }, bearer(key)),
    );
    expect(viaKey.status).toBe(403);

    const cookie = await signIn(ctx, user);
    const res = await ctx.app.request(`/api/me/api-keys/${othersKey.apiKey.id}`, {
      method: 'DELETE',
      headers: web(ctx, cookie),
    });
    expect(res.status).toBe(404);
  });

  it('validates names', async () => {
    const user = createUser(ctx.db);
    const cookie = await signIn(ctx, user);
    const res = await ctx.app.request(
      '/api/me/api-keys',
      json('POST', { name: '  ' }, web(ctx, cookie)),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('validation_failed');
  });
});
