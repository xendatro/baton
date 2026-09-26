import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiErrorSchema } from '@shared/schemas/common';
import { configResponseSchema } from '@shared/schemas/core';
import { errors } from './lib/errors';
import { validateJson } from './lib/validate';
import {
  bearer,
  createApiKey,
  createTestContext,
  createUser,
  json,
  type TestContext,
} from './test/helpers';
import { VERSION } from './version';

let ctx: TestContext | undefined;
const tempDirs: string[] = [];

afterEach(() => {
  ctx?.close();
  ctx = undefined;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options?: Parameters<typeof createTestContext>[0]): TestContext {
  ctx = createTestContext(options);
  return ctx;
}

/** An API key's Authorization header (every /api endpoint but /api/config needs a signed-in user). */
function signedIn(context: TestContext): Record<string, string> {
  return bearer(createApiKey(context.db, { userId: createUser(context.db).id }).key);
}

async function errorOf(res: Response) {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('GET /healthz', () => {
  it('reports ok and the version', async () => {
    const res = await setup().app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });
});

describe('GET /api/config', () => {
  it('returns the public config with providers disabled by default', async () => {
    const res = await setup().app.request('/api/config');
    expect(res.status).toBe(200);
    expect(configResponseSchema.parse(await res.json())).toEqual({
      version: VERSION,
      signupsEnabled: true,
      providers: { google: false, github: false },
      maxUploadMb: 25,
    });
  });

  it('reflects the environment', async () => {
    const res = await setup({
      env: {
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        SIGNUPS_ENABLED: 'false',
        MAX_UPLOAD_MB: '10',
      },
    }).app.request('/api/config');
    expect(await res.json()).toMatchObject({
      signupsEnabled: false,
      providers: { google: false, github: true },
      maxUploadMb: 10,
    });
  });
});

describe('errors', () => {
  it('returns a JSON 404 for unknown API routes (401 before signing in)', async () => {
    const context = setup();
    const headers = signedIn(context);
    for (const [method, url] of [
      ['GET', '/api/nope'],
      ['POST', '/api/teams/x/nope'],
      ['GET', '/mcp/nope'],
    ] as const) {
      const res = await context.app.request(url, { method, headers });
      expect(res.status, url).toBe(404);
      expect((await errorOf(res)).code).toBe('not_found');
    }
    const anonymous = await context.app.request('/api/nope');
    expect(anonymous.status).toBe(401);
    expect((await errorOf(anonymous)).code).toBe('unauthorized');
  });

  it('maps AppError, validation errors and unexpected errors to the error envelope', async () => {
    const context = setup();
    const { app } = context;
    const headers = signedIn(context);
    app.get('/api/test/conflict', () => {
      throw errors.conflict('Already taken', { field: 'slug' });
    });
    app.post('/api/test/validate', validateJson(z.object({ name: z.string().min(2) })), (c) =>
      c.json(c.req.valid('json')),
    );
    app.get('/api/test/crash', () => {
      throw new Error('secret internals');
    });

    const conflict = await app.request('/api/test/conflict', { headers });
    expect(conflict.status).toBe(409);
    expect(await errorOf(conflict)).toEqual({
      code: 'conflict',
      message: 'Already taken',
      details: { field: 'slug' },
    });

    const invalid = await app.request('/api/test/validate', json('POST', { name: 'x' }, headers));
    expect(invalid.status).toBe(400);
    const invalidError = await errorOf(invalid);
    expect(invalidError.code).toBe('validation_failed');
    expect(invalidError.details).toEqual({
      issues: [{ path: 'name', message: expect.any(String) as unknown }],
    });

    const malformed = await app.request('/api/test/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{nope',
    });
    expect(malformed.status).toBe(400);
    expect((await errorOf(malformed)).code).toBe('validation_failed');

    const valid = await app.request('/api/test/validate', json('POST', { name: 'ok' }, headers));
    expect(await valid.json()).toEqual({ name: 'ok' });

    const crash = await app.request('/api/test/crash', { headers });
    expect(crash.status).toBe(500);
    expect(await errorOf(crash)).toEqual({ code: 'internal', message: 'Something went wrong' });
  });
});

describe('security headers', () => {
  it('sets CSP and friends, without HSTS outside production', async () => {
    const res = await setup().app.request('/healthz');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('sends HSTS in production', async () => {
    const res = await setup({
      env: {
        NODE_ENV: 'production',
        BASE_URL: 'https://baton.example.com',
        BETTER_AUTH_SECRET: 'x'.repeat(32),
        LOG_LEVEL: 'silent',
      },
    }).app.request('/healthz');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});

describe('SPA serving', () => {
  function webBuild(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-web-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'theme-init.js'), '/* theme */');
    return dir;
  }

  it('serves static files with cache headers and falls back to index.html', async () => {
    const { app } = setup({ webDir: webBuild() });

    const asset = await app.request('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const script = await app.request('/theme-init.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('cache-control')).toBe('no-cache');

    for (const route of ['/', '/t/acme/p/BAT/tasks', '/settings/profile']) {
      const page = await app.request(route);
      expect(page.status, route).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('<div id="root">');
    }
  });

  it('never falls back to the SPA for API, MCP or health paths', async () => {
    const { app } = setup({ webDir: webBuild() });
    for (const [route, status] of [
      ['/api/unknown', 401],
      ['/mcp/x', 404],
      ['/healthz/x', 404],
    ] as const) {
      const res = await app.request(route);
      expect(res.status, route).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it('serves the API only when the build is missing', async () => {
    const { app } = setup({ webDir: path.join(os.tmpdir(), 'baton-no-such-build') });
    expect((await app.request('/some/page')).status).toBe(404);
  });
});
