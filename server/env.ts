import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration (SPEC §5), validated with zod at startup. Development and tests get
 * safe defaults; production fails fast when a required variable is missing or invalid.
 * Every variable is documented in .env.example.
 */

const DEV_AUTH_SECRET = 'baton-development-only-secret-never-use-in-production';

/** Hosts that only this machine can reach: the development secret is tolerated only there. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(url).hostname);
}

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const optionalString = z.string().min(1).optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    DATA_DIR: z.string().min(1).default('./data'),
    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
    SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),
    MAIL_FROM: z.string().min(3).default('Baton <baton@localhost>'),
    SIGNUPS_ENABLED: booleanString.default(true),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(25),
    TEAM_STORAGE_QUOTA_MB: z.coerce.number().int().min(1).default(5120),
    TRUST_PROXY: z.enum(['none', 'cloudflare']).default('none'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    /** Test-only: also write every outgoing email as JSON into DATA_DIR/mailbox/. */
    E2E_MAILBOX: booleanString.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.BASE_URL)
        ctx.addIssue({ code: 'custom', path: ['BASE_URL'], message: 'required in production' });
      if (!env.BETTER_AUTH_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['BETTER_AUTH_SECRET'],
          message: 'required in production',
        });
      }
    } else if (!env.BETTER_AUTH_SECRET && env.BASE_URL && !isLoopbackUrl(env.BASE_URL)) {
      // Whatever NODE_ENV says, a server others can reach never signs sessions with the
      // publicly known development secret.
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'required when BASE_URL is not a localhost address',
      });
    }
    for (const provider of ['GOOGLE', 'GITHUB'] as const) {
      const id = env[`${provider}_CLIENT_ID`];
      const secret = env[`${provider}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [`${provider}_CLIENT_${id ? 'SECRET' : 'ID'}`],
          message: `set both ${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET, or neither`,
        });
      }
    }
  });

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Env {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  port: number;
  host: string;
  /** Public origin without trailing slash, e.g. `https://baton.example.com`. */
  baseUrl: string;
  /** Absolute path. */
  dataDir: string;
  authSecret: string;
  /** True when BETTER_AUTH_SECRET is unset and the public development secret is in use. */
  usesDevelopmentSecret: boolean;
  google: OAuthCredentials | null;
  github: OAuthCredentials | null;
  /** Null: emails are logged to the console instead of sent. */
  smtpUrl: string | null;
  mailFrom: string;
  signupsEnabled: boolean;
  maxUploadMb: number;
  teamStorageQuotaMb: number;
  trustProxy: 'none' | 'cloudflare';
  logLevel: LogLevel;
  /** Test-only: write outgoing emails as JSON files into `DATA_DIR/mailbox/` (e2e tests read them). */
  e2eMailbox: boolean;
}

export class EnvError extends Error {
  override name = 'EnvError';
}

function credentials(id: string | undefined, secret: string | undefined): OAuthCredentials | null {
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/**
 * Parses and validates environment variables. Empty strings count as unset.
 * Throws `EnvError` listing every problem.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    throw new EnvError(`Invalid environment configuration:\n${problems}`);
  }
  const env = result.data;
  const isProduction = env.NODE_ENV === 'production';
  // Development is used through the Vite dev server (port 5173), which proxies /api to us.
  const defaultBaseUrl =
    env.NODE_ENV === 'development' ? 'http://localhost:5173' : `http://localhost:${env.PORT}`;

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    host: env.HOST,
    baseUrl: (env.BASE_URL ?? defaultBaseUrl).replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR),
    authSecret: env.BETTER_AUTH_SECRET ?? DEV_AUTH_SECRET,
    usesDevelopmentSecret: env.BETTER_AUTH_SECRET === undefined,
    google: credentials(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: credentials(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    smtpUrl: env.SMTP_URL ?? null,
    mailFrom: env.MAIL_FROM,
    signupsEnabled: env.SIGNUPS_ENABLED,
    maxUploadMb: env.MAX_UPLOAD_MB,
    teamStorageQuotaMb: env.TEAM_STORAGE_QUOTA_MB,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    e2eMailbox: env.E2E_MAILBOX,
  };
}

/**
 * Loads `.env` from the working directory when present (development convenience). Variables
 * already set in the real environment win. Production sets variables via the systemd env file.
 */
export function loadDotEnv(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
