import { and, eq, isNull } from 'drizzle-orm';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { emailOTP, username } from 'better-auth/plugins';
import { LIMITS, OTP, RESERVED_USERNAMES, THEMES } from '@shared/constants';
import type { Database } from '../db';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { newId } from '../lib/ids';
import type { RateLimiter } from '../lib/rateLimit';
import type { Logger } from '../logger';
import { recordActivity } from '../services/activity';
import type { Mailer } from './mailer';

/**
 * Better Auth (SPEC §1.1), mounted at /api/auth/*: email + password with a required 6-digit email
 * verification code, password reset by code, usernames, Google/GitHub when configured, account
 * linking, 30-day rolling sessions. Security-relevant events land in the user's security log
 * (account-level `activity` rows).
 */

/** Request header carrying the client IP resolved by the app (see routes/auth.ts). */
export const CLIENT_IP_HEADER = 'x-baton-client-ip';

export interface AuthDeps {
  env: Env;
  db: Database;
  logger: Logger;
  mailer: Mailer;
  /** Token buckets backing Better Auth's per-path rate limits. */
  rateLimiter: RateLimiter;
}

const SESSION_DAYS = 30;
const DAY_SECONDS = 24 * 60 * 60;

export const USERNAME_PATTERN = /^[a-z0-9_]+$/;

/** SPEC username rules, applied to the lowercased value: `[a-z0-9_]`, 3–32 chars, not reserved. */
export function isValidUsername(value: string): boolean {
  return (
    value.length >= LIMITS.username.min &&
    value.length <= LIMITS.username.max &&
    USERNAME_PATTERN.test(value) &&
    !RESERVED_USERNAMES.has(value)
  );
}

/** How a session was created, for the security log. */
function signInMethod(path: string | undefined, providerId: unknown): string {
  switch (path) {
    case '/sign-in/email':
    case '/sign-in/username':
      return 'password';
    case '/email-otp/verify-email':
      return 'email_verification';
    case '/callback/:id':
      return typeof providerId === 'string' ? providerId : 'oauth';
    default:
      return path ?? 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyField(body: unknown, key: string): unknown {
  return isRecord(body) ? body[key] : undefined;
}

/** An attachment download path: `/api/attachments/<id>/<filename>`. */
const AVATAR_PATH_PATTERN = /^\/api\/attachments\/([A-Za-z0-9_-]{1,64})\/[^/?#]+$/;

/** Runs synchronous hook code as the promise Better Auth expects (throws become rejections). */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

export function createAuth(deps: AuthDeps) {
  const { env, db, logger, mailer } = deps;

  /**
   * Writes an account-level row to the user's security log. Better Auth has already committed the
   * change it describes (its adapter is async, our transactions are synchronous; see DECISIONS),
   * so a failure here must not fail the request: it is logged as an error instead.
   */
  function securityLog(userId: string, action: string, meta: Record<string, unknown> = {}): void {
    try {
      db.write((tx) =>
        recordActivity(
          tx,
          { userId, source: 'web', key: null },
          { teamId: null, entityType: 'user', entityId: userId, action, meta },
        ),
      );
    } catch (error) {
      logger.error({ err: error, userId, action }, 'security log row could not be written');
    }
  }

  function isVerifiedEmail(body: unknown): boolean {
    const email = bodyField(body, 'email');
    if (typeof email !== 'string') return false;
    const user = db.orm
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, email.trim().toLowerCase()))
      .get();
    return user?.emailVerified === true;
  }

  /**
   * Profile fields a client may set through Better Auth (`sign-up/email`, `update-user`): the
   * display name is trimmed and 1–64 characters; `displayUsername` is only ever the username in
   * the case the user typed it (it follows username changes); `image` can only be cleared or
   * point at the user's own uploaded avatar (OAuth avatars are set by the provider callback).
   */
  function checkProfileInput(
    body: unknown,
    user: { id: string; username?: string | null | undefined } | null,
  ): void {
    if (!isRecord(body)) return;
    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < LIMITS.displayName.min || name.length > LIMITS.displayName.max) {
        throw new APIError('BAD_REQUEST', {
          code: 'INVALID_NAME',
          message: `Names are ${LIMITS.displayName.min}–${LIMITS.displayName.max} characters`,
        });
      }
      body.name = name;
    }
    const username = typeof body.username === 'string' ? body.username.trim() : user?.username;
    if ('displayUsername' in body) {
      const display = body.displayUsername;
      if (typeof display !== 'string' || display.trim().toLowerCase() !== username?.toLowerCase()) {
        throw new APIError('BAD_REQUEST', {
          code: 'INVALID_DISPLAY_USERNAME',
          message: 'The display username must match your username',
        });
      }
      body.displayUsername = display.trim();
    } else if (typeof body.username === 'string') {
      body.displayUsername = username;
    }
    if ('image' in body && body.image !== null && body.image !== undefined) {
      if (user === null || !isOwnAvatar(body.image, user.id)) {
        throw new APIError('BAD_REQUEST', {
          code: 'INVALID_IMAGE',
          message: 'Upload your avatar from your profile settings',
        });
      }
    }
  }

  /** `/api/attachments/<id>/<name>` (or its absolute URL) of the user's own live avatar upload. */
  function isOwnAvatar(image: unknown, userId: string): boolean {
    if (typeof image !== 'string') return false;
    const path = image.startsWith(env.baseUrl) ? image.slice(env.baseUrl.length) : image;
    const id = AVATAR_PATH_PATTERN.exec(path)?.[1];
    if (!id) return false;
    const row = db.orm
      .select({ id: schema.attachment.id })
      .from(schema.attachment)
      .where(
        and(
          eq(schema.attachment.id, id),
          eq(schema.attachment.uploaderId, userId),
          eq(schema.attachment.parentType, 'user_avatar'),
          isNull(schema.attachment.deletedAt),
        ),
      )
      .get();
    return row !== undefined;
  }

  /** Users created during the current request, so their first account isn't logged as a link. */
  const newUserIds = new Set<string>();

  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {};
  if (env.google) {
    socialProviders.google = {
      clientId: env.google.clientId,
      clientSecret: env.google.clientSecret,
      disableSignUp: !env.signupsEnabled,
      prompt: 'select_account',
    };
  }
  if (env.github) {
    socialProviders.github = {
      clientId: env.github.clientId,
      clientSecret: env.github.clientSecret,
      disableSignUp: !env.signupsEnabled,
    };
  }

  return betterAuth({
    appName: 'Baton',
    baseURL: env.baseUrl,
    basePath: '/api/auth',
    secret: env.authSecret,
    trustedOrigins: [env.baseUrl],
    database: drizzleAdapter(db.orm, { provider: 'sqlite', schema, usePlural: false }),
    logger: {
      level: env.logLevel === 'debug' || env.logLevel === 'trace' ? 'debug' : 'warn',
      disabled: env.logLevel === 'silent',
      log: (level, message, ...args) => {
        const context = { component: 'better-auth', details: args.length > 0 ? args : undefined };
        if (level === 'error') logger.error(context, message);
        else if (level === 'warn') logger.warn(context, message);
        else logger.debug(context, message);
      },
    },

    emailAndPassword: {
      enabled: true,
      disableSignUp: !env.signupsEnabled,
      requireEmailVerification: true,
      minPasswordLength: LIMITS.password.min,
      maxPasswordLength: LIMITS.password.max,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: ({ user }) => {
        securityLog(user.id, 'user.password_reset');
        return Promise.resolve();
      },
    },
    emailVerification: {
      // The emailOTP plugin replaces the link with a 6-digit code.
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
    },
    socialProviders,
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google', 'github'],
        allowDifferentEmails: true,
      },
    },
    user: {
      additionalFields: {
        theme: {
          type: [...THEMES],
          required: true,
          defaultValue: 'system',
          input: false,
        },
      },
      validateUserInfo: async ({ user, source }, context) => {
        if (source.action === 'create-user' && !env.signupsEnabled) {
          return { error: 'signup_disabled', errorDescription: 'Sign-ups are disabled' };
        }
        // Linking an OAuth identity whose email the provider hasn't verified is only allowed when
        // the account owner started it (signed in). This keeps "trusted providers" from turning an
        // unverified provider email into a takeover of the account with that email.
        if (source.action === 'link-account' && user.emailVerified !== true) {
          const session = await getSessionFromCtx(context);
          if (session?.user.id !== user.id) {
            return {
              error: 'email_not_verified',
              errorDescription: 'Sign in first, then connect this account from settings',
            };
          }
        }
        return undefined;
      },
    },
    session: {
      expiresIn: SESSION_DAYS * DAY_SECONDS,
      // Rolling: the expiry moves forward at most once a day while the session is used.
      updateAge: DAY_SECONDS,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: {
        consume: (key, rule) => {
          const decision = deps.rateLimiter.consume(`better-auth:${key}`, {
            max: rule.max,
            windowMs: rule.window * 1000,
          });
          return Promise.resolve({
            allowed: decision.allowed,
            retryAfter: decision.allowed ? null : decision.retryAfterSeconds,
          });
        },
      },
      customRules: {
        // Resend cooldown for emailed codes.
        '/email-otp/send-verification-otp': { window: OTP.resendCooldownSeconds, max: 1 },
        '/email-otp/request-password-reset': { window: OTP.resendCooldownSeconds, max: 1 },
        '/forget-password/email-otp': { window: OTP.resendCooldownSeconds, max: 1 },
        // Wrong codes are capped per code (5 attempts); this only stops hammering.
        '/email-otp/verify-email': { window: 60, max: 10 },
        '/email-otp/reset-password': { window: 60, max: 10 },
        '/get-session': false,
      },
    },
    disabledPaths: [
      // Codes are only for verification and password reset, never for signing in.
      '/sign-in/email-otp',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
      '/change-email',
      // Account deletion goes through the account service (blocked while owning a team).
      '/delete-user',
    ],
    advanced: {
      cookiePrefix: 'baton',
      useSecureCookies: env.isProduction,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => newId() },
    },

    plugins: [
      username({
        minUsernameLength: LIMITS.username.min,
        maxUsernameLength: LIMITS.username.max,
        // Usernames are stored lowercase; accept any case on input and validate the stored form.
        usernameValidator: (value) => isValidUsername(value.toLowerCase()),
      }),
      emailOTP({
        otpLength: OTP.length,
        expiresIn: OTP.expiresInSeconds,
        allowedAttempts: OTP.maxAttempts,
        storeOTP: 'hashed',
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        sendVerificationOTP: ({ email, otp, type }) => {
          // Not awaited: response time must not reveal whether the address has an account.
          mailer.sendOtp(email, type, otp).catch((error: unknown) => {
            logger.error({ err: error, type }, 'failed to send one-time code email');
          });
          return Promise.resolve();
        },
      }),
    ],

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body: unknown = ctx.body;
        switch (ctx.path) {
          case '/sign-up/email': {
            // Email sign-up collects the username on the form (SPEC §1.1).
            const value = bodyField(body, 'username');
            if (typeof value !== 'string' || value.trim() === '') {
              throw new APIError('BAD_REQUEST', {
                code: 'USERNAME_REQUIRED',
                message: 'Choose a username',
              });
            }
            checkProfileInput(body, null);
            return undefined;
          }
          case '/update-user': {
            const session = await getSessionFromCtx(ctx);
            checkProfileInput(body, session?.user ?? null);
            return undefined;
          }
          case '/email-otp/send-verification-otp':
            // Verification codes go to unverified addresses only: verify-email signs the user in,
            // so a code for a verified address would be a password-less login. The answer is the
            // same either way, so it reveals nothing about the address.
            if (bodyField(body, 'type') !== 'email-verification' || isVerifiedEmail(body)) {
              return ctx.json({ success: true });
            }
            return undefined;
          case '/email-otp/verify-email':
            // Belt and braces for the rule above (e.g. a code sent before the address was verified
            // some other way): answered like a code that does not exist.
            if (isVerifiedEmail(body)) {
              throw new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'Invalid OTP' });
            }
            return undefined;
          default:
            return undefined;
        }
      }),
      after: createAuthMiddleware((ctx) =>
        settle(() => {
          if (isAPIError(ctx.context.returned)) return;
          const userId = ctx.context.session?.user.id;
          if (!userId) return;
          if (ctx.path === '/change-password') securityLog(userId, 'user.password_changed');
          if (ctx.path === '/unlink-account') {
            securityLog(userId, 'user.account_unlinked', {
              provider: bodyField(ctx.body, 'providerId') ?? null,
            });
          }
        }),
      ),
    },

    databaseHooks: {
      user: {
        create: {
          before: (user, context) =>
            settle(() => {
              if (!env.signupsEnabled) return false;
              // OAuth sign-ups arrive verified (SPEC §1.1).
              if (context?.path === '/callback/:id') {
                return { data: { ...user, emailVerified: true } };
              }
              return undefined;
            }),
          after: (user, context) =>
            settle(() => {
              newUserIds.add(user.id);
              const provider = context?.path === '/callback/:id' ? context.params?.id : undefined;
              securityLog(user.id, 'user.signed_up', {
                method: typeof provider === 'string' ? provider : 'email',
                ip: context?.request?.headers.get(CLIENT_IP_HEADER) ?? null,
              });
            }),
        },
      },
      account: {
        create: {
          after: (account, context) =>
            settle(() => {
              // The first account of a brand-new user is part of the sign-up, not a link.
              if (newUserIds.delete(account.userId)) return;
              if (account.providerId === 'credential') {
                // A reset by code creates the password of OAuth-only users; that is logged as a reset.
                if (context?.path !== '/email-otp/reset-password') {
                  securityLog(account.userId, 'user.password_set');
                }
                return;
              }
              securityLog(account.userId, 'user.account_linked', { provider: account.providerId });
            }),
        },
      },
      session: {
        create: {
          after: (session, context) =>
            settle(() => {
              securityLog(session.userId, 'user.signed_in', {
                method: signInMethod(context?.path, context?.params?.id),
                ip: session.ipAddress ?? null,
                userAgent: session.userAgent ?? null,
              });
            }),
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
