import fs from 'node:fs';
import { makeSignature } from 'better-auth/crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import {
  connectionsResponseSchema,
  passwordResponseSchema,
  profileResponseSchema,
  sessionListResponseSchema,
} from '@shared/schemas/account';
import { apiErrorSchema } from '@shared/schemas/common';
import * as s from '../db/schema';
import { newId } from '../lib/ids';
import {
  addMember,
  bearer,
  createApiKey,
  createIssue,
  createProject,
  createTeam,
  createTestContext,
  createUser,
  json,
  signIn,
  web,
  type TestContext,
  type UserRow,
} from '../test/helpers';
import { attachmentFilePath } from './attachments';
import { emailFromIdToken } from './account';

let ctx: TestContext;
let user: UserRow;
let cookie: string;
let events: LiveEvent[];

const PASSWORD = 'correct horse battery staple';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  ctx = createTestContext({ env: { LOG_LEVEL: 'silent' } });
  user = createUser(ctx.db, { username: 'ada', name: 'Ada Lovelace', email: 'ada@example.test' });
  cookie = await signIn(ctx, user, PASSWORD);
  events = [];
  ctx.deps.events.subscribe((event) => events.push(event));
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.close();
});

function request(method: string, url: string, body?: unknown, headers = web(ctx, cookie)) {
  return ctx.app.request(
    url,
    body === undefined ? { method, headers } : json(method, body, headers),
  );
}

async function errorOf(res: Response) {
  return apiErrorSchema.parse(await res.json()).error;
}

function securityLog(userId = user.id) {
  return ctx.db.orm
    .select()
    .from(s.activity)
    .where(and(eq(s.activity.actorId, userId), isNull(s.activity.teamId)))
    .all();
}

function actions(userId = user.id): string[] {
  return securityLog(userId).map((row) => row.action);
}

function reloadUser(id = user.id) {
  return ctx.db.orm.select().from(s.user).where(eq(s.user.id, id)).get();
}

/** Inserts another session for the user (a second browser or device). */
function addSession(
  userId = user.id,
  options: { userAgent?: string; ip?: string; expiresAt?: Date } = {},
) {
  const now = new Date();
  return ctx.db.orm
    .insert(s.session)
    .values({
      id: newId(),
      token: newId(),
      userId,
      expiresAt: options.expiresAt ?? new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
      userAgent:
        options.userAgent ??
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ipAddress: options.ip ?? '203.0.113.7',
    })
    .returning()
    .get();
}

function avatarForm(bytes: Uint8Array | Buffer, name = 'me.png', type = 'image/png') {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return form;
}

function uploadAvatar(
  bytes: Uint8Array | Buffer = PNG,
  name = 'me.png',
  headers = web(ctx, cookie),
) {
  return ctx.app.request('/api/me/avatar', {
    method: 'POST',
    headers,
    body: avatarForm(bytes, name),
  });
}

// ---------------------------------------------------------------------------------------------

describe('PATCH /api/me', () => {
  it('updates the name, username and theme, keeping the typed case for display', async () => {
    const res = await request('PATCH', '/api/me', {
      name: '  Ada King ',
      username: 'Ada_K',
      theme: 'dark',
    });
    expect(res.status).toBe(200);
    const profile = profileResponseSchema.parse(await res.json());
    expect(profile).toMatchObject({
      name: 'Ada King',
      username: 'ada_k',
      displayUsername: 'Ada_K',
      theme: 'dark',
    });
    expect(reloadUser()).toMatchObject({ username: 'ada_k', displayUsername: 'Ada_K' });

    const [row] = securityLog().filter((entry) => entry.action === 'user.profile_updated');
    expect(row?.changes).toEqual({
      name: { from: 'Ada Lovelace', to: 'Ada King' },
      username: { from: 'ada', to: 'ada_k' },
      theme: { from: 'system', to: 'dark' },
    });
    expect(row?.source).toBe('web');
    expect(events.map((event) => event.type)).toContain('me.updated');
    expect(events.find((event) => event.type === 'me.updated')?.userId).toBe(user.id);
  });

  it('tells teammates the member changed', async () => {
    const { team } = createTeam(ctx.db, { ownerId: user.id });
    await request('PATCH', '/api/me', { name: 'Countess' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'member.updated', teamId: team.id, entityId: user.id }),
    );
  });

  it('writes nothing when nothing changes', async () => {
    const before = actions().length;
    const res = await request('PATCH', '/api/me', { name: 'Ada Lovelace', theme: 'system' });
    expect(res.status).toBe(200);
    expect(actions()).toHaveLength(before);
    expect(events.filter((event) => event.type === 'me.updated')).toHaveLength(0);
  });

  it('logs a display-case change alone', async () => {
    await request('PATCH', '/api/me', { username: 'ADA' });
    expect(reloadUser()).toMatchObject({ username: 'ada', displayUsername: 'ADA' });
    const row = securityLog().find((entry) => entry.action === 'user.profile_updated');
    expect(row?.changes).toEqual({ displayUsername: { from: 'ada', to: 'ADA' } });
  });

  it('refuses taken, reserved and malformed usernames', async () => {
    createUser(ctx.db, { username: 'grace' });
    const taken = await request('PATCH', '/api/me', { username: 'Grace' });
    expect(taken.status).toBe(409);
    expect(await errorOf(taken)).toMatchObject({ code: 'conflict', message: '@grace is taken' });

    const reserved = await request('PATCH', '/api/me', { username: 'Admin' });
    expect(reserved.status).toBe(400);
    expect((await errorOf(reserved)).message).toMatch(/reserved/);

    for (const username of ['ab', 'has space', 'dash-ed', 'x'.repeat(33)]) {
      const res = await request('PATCH', '/api/me', { username });
      expect(res.status, username).toBe(400);
    }
    expect(reloadUser()?.username).toBe('ada');
  });

  it('needs at least one field and a valid theme and name', async () => {
    expect((await request('PATCH', '/api/me', {})).status).toBe(400);
    expect((await request('PATCH', '/api/me', { theme: 'blue' })).status).toBe(400);
    expect((await request('PATCH', '/api/me', { name: '   ' })).status).toBe(400);
    expect((await request('PATCH', '/api/me', { name: 'x'.repeat(65) })).status).toBe(400);
  });

  it('works with an API key, attributed to the key', async () => {
    const { key, apiKey } = createApiKey(ctx.db, { userId: user.id, name: 'Claude' });
    const res = await ctx.app.request('/api/me', json('PATCH', { name: 'Ada' }, bearer(key)));
    expect(res.status).toBe(200);
    const row = securityLog().find((entry) => entry.action === 'user.profile_updated');
    expect(row).toMatchObject({ source: 'api', viaKeyId: apiKey.id, viaKeyName: 'Claude' });
  });

  it('requires a signed-in user and a same-origin browser request', async () => {
    const anonymous = await ctx.app.request('/api/me', json('PATCH', { name: 'X' }));
    expect(anonymous.status).toBe(401);
    const crossSite = await ctx.app.request(
      '/api/me',
      json('PATCH', { name: 'X' }, { Cookie: cookie, Origin: 'https://evil.example' }),
    );
    expect(crossSite.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe('avatar', () => {
  it('uploads an image, points the profile at it and serves it to other users', async () => {
    const res = await uploadAvatar();
    expect(res.status).toBe(200);
    const profile = profileResponseSchema.parse(await res.json());
    expect(profile.image).toMatch(/^\/api\/attachments\/[A-Z0-9]+\/me\.png$/);

    const rows = ctx.db.orm
      .select()
      .from(s.attachment)
      .where(eq(s.attachment.parentType, 'user_avatar'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teamId: null, parentId: user.id, mimeType: 'image/png' });
    expect(actions()).toContain('user.avatar_changed');

    const other = createUser(ctx.db);
    const { key } = createApiKey(ctx.db, { userId: other.id });
    const image = await ctx.app.request(profile.image ?? '', { headers: bearer(key) });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
  });

  it('replaces the previous avatar and deletes its file', async () => {
    await uploadAvatar();
    const [first] = ctx.db.orm.select().from(s.attachment).all();
    const firstFile = attachmentFilePath(ctx.dataDir, first?.storagePath ?? '');
    expect(fs.existsSync(firstFile)).toBe(true);

    await uploadAvatar(PNG, 'second.png');
    const rows = ctx.db.orm.select().from(s.attachment).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe('second.png');
    expect(fs.existsSync(firstFile)).toBe(false);
    expect(reloadUser()?.image).toContain('second.png');
  });

  it('refuses files that are not raster images, and empty or oversized ones', async () => {
    const svg = await uploadAvatar(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'a.svg',
    );
    expect(svg.status).toBe(400);
    expect((await errorOf(svg)).message).toBe('Use a PNG, JPEG, GIF or WebP image');

    // A text file named like a PNG is not trusted as one.
    const fake = await uploadAvatar(Buffer.from('not really a png'), 'fake.png');
    expect(fake.status).toBe(400);

    const empty = await uploadAvatar(Buffer.alloc(0), 'empty.png');
    expect(empty.status).toBe(400);

    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const oversized = await uploadAvatar(big, 'big.png');
    expect(oversized.status).toBe(413);

    const missing = await ctx.app.request('/api/me/avatar', {
      method: 'POST',
      headers: web(ctx, cookie),
      body: new FormData(),
    });
    expect(missing.status).toBe(400);
    expect(ctx.db.orm.select().from(s.attachment).all()).toHaveLength(0);
    expect(reloadUser()?.image).toBeNull();
  });

  it('removes the avatar and its file', async () => {
    await uploadAvatar();
    const [row] = ctx.db.orm.select().from(s.attachment).all();
    const res = await request('DELETE', '/api/me/avatar');
    expect(res.status).toBe(200);
    expect(profileResponseSchema.parse(await res.json()).image).toBeNull();
    expect(ctx.db.orm.select().from(s.attachment).all()).toHaveLength(0);
    expect(fs.existsSync(attachmentFilePath(ctx.dataDir, row?.storagePath ?? ''))).toBe(false);
    expect(actions()).toContain('user.avatar_removed');
  });

  it('clears an OAuth profile picture, and does nothing without one', async () => {
    ctx.db.orm
      .update(s.user)
      .set({ image: 'https://avatars.example/ada.png' })
      .where(eq(s.user.id, user.id))
      .run();
    await request('DELETE', '/api/me/avatar');
    expect(reloadUser()?.image).toBeNull();
    const logged = actions().filter((action) => action === 'user.avatar_removed').length;
    await request('DELETE', '/api/me/avatar');
    expect(actions().filter((action) => action === 'user.avatar_removed')).toHaveLength(logged);
  });
});

// ---------------------------------------------------------------------------------------------

describe('password', () => {
  it('changes the password after checking the current one', async () => {
    const res = await request('POST', '/api/me/password', {
      currentPassword: PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(res.status).toBe(200);
    expect(passwordResponseSchema.parse(await res.json())).toEqual({
      ok: true,
      revokedSessions: 0,
    });
    // Exactly one row: the service writes it, not Better Auth's hook as well.
    expect(actions().filter((action) => action === 'user.password_changed')).toHaveLength(1);

    const signInWith = (password: string) =>
      ctx.app.request(
        '/api/auth/sign-in/email',
        json('POST', { email: user.email, password }, { Origin: ctx.env.baseUrl }),
      );
    expect((await signInWith(PASSWORD)).status).toBe(401);
    expect((await signInWith('a brand new passphrase')).status).toBe(200);
  });

  it('rejects a wrong current password, a short new one and an unchanged one', async () => {
    const wrong = await request('POST', '/api/me/password', {
      currentPassword: 'not it at all',
      newPassword: 'a brand new passphrase',
    });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).details).toEqual({
      issues: [{ path: 'currentPassword', message: 'That isn’t your current password' }],
    });

    const short = await request('POST', '/api/me/password', {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(short.status).toBe(400);

    const same = await request('POST', '/api/me/password', {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(same.status).toBe(400);
    expect(actions()).not.toContain('user.password_changed');
  });

  it('signs out the other sessions on request, keeping this one', async () => {
    const other = addSession();
    const res = await request('POST', '/api/me/password', {
      currentPassword: PASSWORD,
      newPassword: 'a brand new passphrase',
      revokeOtherSessions: true,
    });
    expect(passwordResponseSchema.parse(await res.json()).revokedSessions).toBe(1);
    const remaining = ctx.db.orm
      .select()
      .from(s.session)
      .where(eq(s.session.userId, user.id))
      .all();
    expect(remaining.map((session) => session.id)).not.toContain(other.id);
    expect(remaining).toHaveLength(1);
    expect((await request('GET', '/api/me')).status).toBe(200);
    const row = securityLog().find((entry) => entry.action === 'user.password_changed');
    expect(row?.meta).toEqual({ revokedSessions: 1 });
  });

  it('points accounts without a password to set one, and sets it once', async () => {
    const oauth = createUser(ctx.db, { username: 'grace' });
    // Sign in through a session row: this account has no password to sign in with.
    const session = addSession(oauth.id);
    const signedToken = await sessionCookie(session.token);
    const headers = { Cookie: signedToken, Origin: ctx.env.baseUrl };

    const change = await request(
      'POST',
      '/api/me/password',
      { currentPassword: 'whatever it is', newPassword: 'a brand new passphrase' },
      headers,
    );
    expect(change.status).toBe(400);
    expect((await errorOf(change)).message).toMatch(/Set one instead/);

    const set = await request(
      'POST',
      '/api/me/password/set',
      { newPassword: 'a brand new passphrase' },
      headers,
    );
    expect(set.status).toBe(200);
    expect(actions(oauth.id)).toEqual(['user.password_set']);
    const signInRes = await ctx.app.request(
      '/api/auth/sign-in/email',
      json(
        'POST',
        { email: oauth.email, password: 'a brand new passphrase' },
        { Origin: ctx.env.baseUrl },
      ),
    );
    expect(signInRes.status).toBe(200);

    const again = await request(
      'POST',
      '/api/me/password/set',
      { newPassword: 'another passphrase' },
      headers,
    );
    expect(again.status).toBe(409);
  });

  it('is web only', async () => {
    const { key } = createApiKey(ctx.db, { userId: user.id });
    const res = await ctx.app.request(
      '/api/me/password',
      json(
        'POST',
        { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' },
        bearer(key),
      ),
    );
    expect(res.status).toBe(403);
  });
});

/** The signed cookie Better Auth expects for a raw session token. */
async function sessionCookie(token: string): Promise<string> {
  const { authCookies, secret } = await ctx.deps.auth.$context;
  const signature = await makeSignature(token, secret);
  return `${authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

// ---------------------------------------------------------------------------------------------

describe('sessions', () => {
  it('lists unexpired sessions with the current one first', async () => {
    const phone = addSession();
    addSession(user.id, { expiresAt: new Date(Date.now() - 1000) });
    const stranger = createUser(ctx.db);
    addSession(stranger.id);

    const res = await request('GET', '/api/me/sessions');
    const { items } = sessionListResponseSchema.parse(await res.json());
    expect(items).toHaveLength(2);
    expect(items[0]?.current).toBe(true);
    expect(items[1]).toMatchObject({
      id: phone.id,
      current: false,
      browser: 'Safari',
      os: 'iOS',
      device: 'mobile',
      ipAddress: '203.0.113.7',
    });
  });

  it('revokes another session, but not the current one or anyone else’s', async () => {
    const phone = addSession();
    const res = await request('DELETE', `/api/me/sessions/${phone.id}`);
    expect(res.status).toBe(200);
    expect(ctx.db.orm.select().from(s.session).where(eq(s.session.id, phone.id)).get()).toBe(
      undefined,
    );
    const row = securityLog().find((entry) => entry.action === 'user.session_revoked');
    expect(row?.meta).toEqual({ browser: 'Safari', os: 'iOS', ip: '203.0.113.7' });

    const { items } = sessionListResponseSchema.parse(
      await (await request('GET', '/api/me/sessions')).json(),
    );
    const current = items.find((item) => item.current);
    const self = await request('DELETE', `/api/me/sessions/${current?.id ?? ''}`);
    expect(self.status).toBe(400);

    const stranger = addSession(createUser(ctx.db).id);
    expect((await request('DELETE', `/api/me/sessions/${stranger.id}`)).status).toBe(404);
  });

  it('signs out every other session', async () => {
    addSession();
    addSession();
    const res = await request('POST', '/api/me/sessions/revoke-others');
    expect(await res.json()).toEqual({ revoked: 2 });
    expect(
      ctx.db.orm.select().from(s.session).where(eq(s.session.userId, user.id)).all(),
    ).toHaveLength(1);
    expect(securityLog().find((entry) => entry.action === 'user.sessions_revoked')?.meta).toEqual({
      count: 2,
    });

    const none = await request('POST', '/api/me/sessions/revoke-others');
    expect(await none.json()).toEqual({ revoked: 0 });
    expect(actions().filter((action) => action === 'user.sessions_revoked')).toHaveLength(1);
  });

  it('is web only', async () => {
    const { key } = createApiKey(ctx.db, { userId: user.id });
    expect((await ctx.app.request('/api/me/sessions', { headers: bearer(key) })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe('GET /api/me/connections', () => {
  function link(providerId: string, values: Partial<typeof s.account.$inferInsert> = {}) {
    const now = new Date();
    ctx.db.orm
      .insert(s.account)
      .values({
        id: newId(),
        accountId: `${providerId}-123`,
        providerId,
        userId: user.id,
        createdAt: now,
        updatedAt: now,
        ...values,
      })
      .run();
  }

  const idToken = (claims: Record<string, unknown>) =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

  it('lists the password and linked accounts with their email or login', async () => {
    link('google', { idToken: idToken({ email: 'ada@gmail.test' }) });
    link('github', { accessToken: 'gho_token' });
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ login: 'adalovelace' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await request('GET', '/api/me/connections');
    const body = connectionsResponseSchema.parse(await res.json());
    expect(body.hasPassword).toBe(true);
    expect(body.accounts).toEqual([
      expect.objectContaining({ provider: 'google', label: 'ada@gmail.test' }),
      expect.objectContaining({ provider: 'github', label: '@adalovelace' }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gho_token' }) as unknown,
      }),
    );
  });

  it('shows linked accounts without a label when the provider can’t be reached', async () => {
    link('github', { accessToken: 'gho_token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const body = connectionsResponseSchema.parse(
      await (await request('GET', '/api/me/connections')).json(),
    );
    expect(body.accounts).toEqual([expect.objectContaining({ provider: 'github', label: null })]);
  });

  it('disconnects a linked account, logging which provider', async () => {
    link('github', { accessToken: 'gho_token' });
    const res = await request('DELETE', '/api/me/connections/github');
    expect(res.status).toBe(200);
    expect(
      ctx.db.orm
        .select()
        .from(s.account)
        .where(and(eq(s.account.userId, user.id), eq(s.account.providerId, 'github')))
        .get(),
    ).toBeUndefined();
    const row = securityLog().find((entry) => entry.action === 'user.account_unlinked');
    expect(row?.meta).toEqual({ provider: 'github' });

    expect((await request('DELETE', '/api/me/connections/github')).status).toBe(404);
    expect((await request('DELETE', '/api/me/connections/twitter')).status).toBe(400);
  });

  it('never disconnects the last way to sign in', async () => {
    // Only Google: no password (the credential row of the fixture is removed).
    ctx.db.orm.delete(s.account).where(eq(s.account.userId, user.id)).run();
    link('google');
    const res = await request('DELETE', '/api/me/connections/google');
    expect(res.status).toBe(409);
    expect((await errorOf(res)).message).toMatch(/only way to sign in/);

    link('github');
    expect((await request('DELETE', '/api/me/connections/google')).status).toBe(200);
  });

  it('reads the email claim of an ID token', () => {
    expect(emailFromIdToken(idToken({ email: 'a@b.test' }))).toBe('a@b.test');
    expect(emailFromIdToken(idToken({ sub: '1' }))).toBeNull();
    expect(emailFromIdToken('garbage')).toBeNull();
    expect(emailFromIdToken(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('POST /api/me/delete', () => {
  it('is blocked while the user owns a team, including one in Trash', async () => {
    const { team } = createTeam(ctx.db, { ownerId: user.id, name: 'Acme' });
    const res = await request('POST', '/api/me/delete', { password: PASSWORD });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.message).toMatch(/You own Acme/);
    expect(error.details).toEqual({
      teams: [{ id: team.id, name: 'Acme', slug: team.slug, deleted: false }],
    });

    ctx.db.orm.update(s.team).set({ deletedAt: new Date() }).where(eq(s.team.id, team.id)).run();
    const trashed = await request('POST', '/api/me/delete', { password: PASSWORD });
    expect(trashed.status).toBe(409);
    expect((await errorOf(trashed)).message).toMatch(/purged/);
    expect(reloadUser()).toBeDefined();
  });

  it('needs the right password', async () => {
    const missing = await request('POST', '/api/me/delete', {});
    expect(missing.status).toBe(400);
    const wrong = await request('POST', '/api/me/delete', { password: 'nope nope nope' });
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).details).toEqual({
      issues: [{ path: 'password', message: 'That isn’t your password' }],
    });
    expect(reloadUser()).toBeDefined();
  });

  it('deletes the account and its access, keeping content as a deleted user', async () => {
    const owner = createUser(ctx.db);
    const { team, adminRole } = createTeam(ctx.db, { ownerId: owner.id });
    addMember(ctx.db, { teamId: team.id, userId: user.id, roleIds: [adminRole.id] });
    const { project } = createProject(ctx.db, { teamId: team.id });
    const issue = createIssue(ctx.db, { project, authorId: user.id });
    const { key } = createApiKey(ctx.db, { userId: user.id });
    await uploadAvatar();
    const [avatar] = ctx.db.orm.select().from(s.attachment).all();

    const res = await request('POST', '/api/me/delete', { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie().join('\n')).toMatch(/baton\.session_token=;/);

    expect(reloadUser()).toBeUndefined();
    expect(ctx.db.orm.select().from(s.session).where(eq(s.session.userId, user.id)).all()).toEqual(
      [],
    );
    expect(
      ctx.db.orm.select().from(s.teamMember).where(eq(s.teamMember.userId, user.id)).all(),
    ).toEqual([]);
    expect(
      ctx.db.orm.select().from(s.memberRole).where(eq(s.memberRole.userId, user.id)).all(),
    ).toEqual([]);
    expect(ctx.db.orm.select().from(s.issue).where(eq(s.issue.id, issue.id)).get()?.authorId).toBe(
      null,
    );
    expect(ctx.db.orm.select().from(s.attachment).all()).toEqual([]);
    expect(fs.existsSync(attachmentFilePath(ctx.dataDir, avatar?.storagePath ?? ''))).toBe(false);

    expect(actions()).toContain('user.deleted');
    const teamRow = ctx.db.orm
      .select()
      .from(s.activity)
      .where(and(eq(s.activity.teamId, team.id), eq(s.activity.action, 'member.account_deleted')))
      .get();
    expect(teamRow).toMatchObject({ entityType: 'member', entityId: user.id });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'member.left', teamId: team.id }),
    );

    expect((await request('GET', '/api/me')).status).toBe(401);
    expect((await ctx.app.request('/api/me', { headers: bearer(key) })).status).toBe(401);
  });

  it('asks accounts without a password to type their username', async () => {
    const oauth = createUser(ctx.db, { username: 'grace' });
    const session = addSession(oauth.id);
    const headers = { Cookie: await sessionCookie(session.token), Origin: ctx.env.baseUrl };

    const wrong = await request('POST', '/api/me/delete', { confirmUsername: 'ada' }, headers);
    expect(wrong.status).toBe(400);
    expect((await errorOf(wrong)).details).toEqual({
      issues: [{ path: 'confirmUsername', message: 'Type your username to confirm' }],
    });
    const ok = await request('POST', '/api/me/delete', { confirmUsername: 'Grace' }, headers);
    expect(ok.status).toBe(200);
    expect(reloadUser(oauth.id)).toBeUndefined();
  });

  it('is web only', async () => {
    const { key } = createApiKey(ctx.db, { userId: user.id });
    const res = await ctx.app.request(
      '/api/me/delete',
      json('POST', { password: PASSWORD }, bearer(key)),
    );
    expect(res.status).toBe(403);
    expect(reloadUser()).toBeDefined();
  });
});
