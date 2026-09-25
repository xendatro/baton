import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { emailOTPClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { useCallback } from 'react';
import { z } from 'zod';
import {
  configResponseSchema,
  meResponseSchema,
  type ConfigResponse,
  type MeResponse,
} from '@shared/schemas/core';
import { api } from './api';
import { queryKeys } from './queryKeys';

/**
 * Authentication on the web: the Better Auth client (email + password, email OTP, username,
 * social sign-in) and the queries every page builds on — the session, `GET /api/me` and
 * `GET /api/config`.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [emailOTPClient(), usernameClient()],
});

/** A failed Better Auth call. `code` is Better Auth's (e.g. `INVALID_EMAIL_OR_PASSWORD`). */
export class AuthRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'AuthRequestError';
    this.code = code;
    this.status = status;
  }
}

interface BetterAuthResult<T> {
  data: T | null;
  error: { code?: string | undefined; message?: string | undefined; status: number } | null;
}

const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match.',
  INVALID_USERNAME_OR_PASSWORD: 'That username and password don’t match.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with this email already exists.',
  USERNAME_IS_ALREADY_TAKEN: 'That username is taken.',
  INVALID_OTP: 'That code isn’t right. Check the email and try again.',
  OTP_EXPIRED: 'That code has expired. Send a new one.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Send a new code.',
  EMAIL_NOT_VERIFIED: 'Verify your email to continue.',
  PASSWORD_TOO_SHORT: 'The password is too short.',
  PASSWORD_TOO_LONG: 'The password is too long.',
};

/** Unwraps a Better Auth `{ data, error }` result, throwing `AuthRequestError` on failure. */
export function unwrapAuth<T>(result: BetterAuthResult<T>): T {
  if (result.error) {
    const code = result.error.code ?? (result.error.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN');
    const message =
      AUTH_MESSAGES[code] ??
      (result.error.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : (result.error.message ?? 'Something went wrong. Try again.'));
    throw new AuthRequestError(code, result.error.status, message);
  }
  return result.data as T;
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** The parts of Better Auth's `get-session` response the web app relies on. */
export const sessionSchema = z
  .object({
    session: z.object({ id: z.string(), expiresAt: z.coerce.date() }),
    user: z.object({
      id: z.string(),
      email: z.string(),
      emailVerified: z.boolean(),
      name: z.string(),
      username: z.string().nullish(),
    }),
  })
  .nullable();
export type Session = NonNullable<z.infer<typeof sessionSchema>>;

export function fetchSession(): Promise<Session | null> {
  return api.get('/api/auth/get-session', { schema: sessionSchema, routeAuthErrors: false });
}

/** Current session, or null when signed out. */
export function useSession(): UseQueryResult<Session | null> {
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: fetchSession,
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------------------------
// Me & config
// ---------------------------------------------------------------------------------------------

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  return api.get('/api/me', { schema: meResponseSchema, signal });
}

/** `GET /api/me`: the user, their teams (with projects and permissions) and the unread count. */
export function useMe(options: { enabled?: boolean } = {}): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: ({ signal }) => fetchMe(signal),
    enabled: options.enabled ?? true,
  });
}

/** `GET /api/config`: public server configuration (enabled providers, limits). */
export function useConfig(): UseQueryResult<ConfigResponse> {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: ({ signal }) => api.get('/api/config', { schema: configResponseSchema, signal }),
    staleTime: Infinity,
  });
}

/** Signs out, drops every cached query and returns to the login page. */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      queryClient.clear();
      queryClient.setQueryData(queryKeys.session(), null);
      window.location.assign('/login');
    }
  }, [queryClient]);
}

/** Refetches the session and profile after signing in, verifying or onboarding. */
export async function refreshAuth(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
  await queryClient.invalidateQueries({ queryKey: queryKeys.me() });
}

/** Placeholder origin for resolving `?next=` values; only its equality matters. */
const NEXT_BASE = 'https://baton.invalid';

const AUTH_PATHS: ReadonlySet<string> = new Set([
  '/login',
  '/signup',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
]);

/** Control characters and whitespace, which URL parsers strip or reinterpret (`/\t/evil`). */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Sanitises a `?next=` value: only same-origin app paths are allowed (no protocol-relative or
 * absolute URLs, nothing a URL parser would resolve to another origin), and auth pages fall back
 * to the dashboard. The result is the normalised path, query and hash.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith('/') || hasControlOrSpace(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, NEXT_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== NEXT_BASE || AUTH_PATHS.has(url.pathname)) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}
