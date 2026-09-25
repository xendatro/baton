import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from './env';

describe('parseEnv', () => {
  it('provides development defaults', () => {
    const env = parseEnv({});
    expect(env).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      port: 3000,
      host: '127.0.0.1',
      baseUrl: 'http://localhost:5173',
      dataDir: path.resolve('./data'),
      google: null,
      github: null,
      smtpUrl: null,
      signupsEnabled: true,
      maxUploadMb: 25,
      teamStorageQuotaMb: 5120,
      trustProxy: 'none',
      logLevel: 'info',
    });
    expect(env.authSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('defaults tests to a silent logger and the server port as base URL', () => {
    expect(parseEnv({ NODE_ENV: 'test', PORT: '4000' })).toMatchObject({
      logLevel: 'silent',
      baseUrl: 'http://localhost:4000',
    });
  });

  it('parses and normalises values', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      BASE_URL: 'https://baton.example.com/',
      BETTER_AUTH_SECRET: 's'.repeat(40),
      SIGNUPS_ENABLED: 'false',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      SMTP_URL: 'smtps://user:pass@mail.example.com:465',
      TRUST_PROXY: 'cloudflare',
      LOG_LEVEL: 'debug',
    });
    expect(env).toMatchObject({
      isProduction: true,
      baseUrl: 'https://baton.example.com',
      signupsEnabled: false,
      google: { clientId: 'gid', clientSecret: 'gsecret' },
      smtpUrl: 'smtps://user:pass@mail.example.com:465',
      trustProxy: 'cloudflare',
      logLevel: 'debug',
    });
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ SMTP_URL: '', GITHUB_CLIENT_ID: ' ', PORT: '' })).toMatchObject({
      smtpUrl: null,
      github: null,
      port: 3000,
    });
  });

  it('fails fast in production without BASE_URL and BETTER_AUTH_SECRET', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(EnvError);
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/BASE_URL.*\n.*BETTER_AUTH_SECRET/s);
  });

  // Regression (SEC-10): without NODE_ENV a public deployment silently used the dev secret.
  it('refuses the development secret for a BASE_URL others can reach', () => {
    expect(() => parseEnv({ BASE_URL: 'https://baton.example.com', PORT: '3000' })).toThrow(
      /BETTER_AUTH_SECRET: required when BASE_URL is not a localhost address/,
    );
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:3000']) {
      expect(parseEnv({ BASE_URL: url }).usesDevelopmentSecret).toBe(true);
    }
    const env = parseEnv({
      BASE_URL: 'https://baton.example.com',
      BETTER_AUTH_SECRET: 's'.repeat(40),
    });
    expect(env.usesDevelopmentSecret).toBe(false);
  });

  it('rejects invalid values and half-configured providers', () => {
    expect(() => parseEnv({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => parseEnv({ BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => parseEnv({ TRUST_PROXY: 'nginx' })).toThrow(/TRUST_PROXY/);
    expect(() => parseEnv({ SMTP_URL: 'http://mail' })).toThrow(/SMTP_URL/);
    expect(() => parseEnv({ GOOGLE_CLIENT_ID: 'only-id' })).toThrow(/GOOGLE_CLIENT_SECRET/);
  });
});
