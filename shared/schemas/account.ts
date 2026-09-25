import { z } from 'zod';
import { LIMITS, RESERVED_USERNAMES } from '../constants';
import { displayNameSchema, passwordSchema, timestampSchema } from './common';
import { meUserSchema, themeSchema } from './core';

/**
 * Wire contracts of the account module (docs/API.md → Account): profile, avatar, password,
 * sessions, linked sign-in methods and account deletion. Shared by the REST routes, the MCP tools
 * and the settings pages.
 */

// ---------------------------------------------------------------------------------------------
// Profile: PATCH /api/me
// ---------------------------------------------------------------------------------------------

/**
 * A username as typed: any case, trimmed. The account is stored under the lowercase form (which
 * must satisfy `usernameSchema`); the typed form is kept as the display username.
 */
export const usernameInputSchema = z
  .string()
  .trim()
  .min(LIMITS.username.min, `At least ${LIMITS.username.min} characters`)
  .max(LIMITS.username.max, `At most ${LIMITS.username.max} characters`)
  .regex(/^[A-Za-z0-9_]+$/, 'Only letters, digits and underscores')
  .refine((value) => !RESERVED_USERNAMES.has(value.toLowerCase()), 'This username is reserved');

export const updateProfileInputSchema = z
  .object({
    name: displayNameSchema.optional(),
    username: usernameInputSchema.optional(),
    theme: themeSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.username !== undefined || value.theme !== undefined,
    { message: 'Pass at least one of name, username or theme' },
  );
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/** `PATCH /api/me`, `POST|DELETE /api/me/avatar`: the updated profile (as in `GET /api/me`). */
export const profileResponseSchema = meUserSchema;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/** Largest avatar accepted (never more than MAX_UPLOAD_MB either). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Raster formats accepted as avatars (checked against the file's bytes on the server). */
export const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

// ---------------------------------------------------------------------------------------------
// Password: POST /api/me/password, POST /api/me/password/set
// ---------------------------------------------------------------------------------------------

export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1, 'Required').max(LIMITS.password.max),
  newPassword: passwordSchema,
  /** Sign out every other session (this one stays signed in). */
  revokeOtherSessions: z.boolean().default(false),
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

/** For accounts without a password yet (OAuth sign-ups). */
export const setPasswordInputSchema = z.object({
  newPassword: passwordSchema,
  revokeOtherSessions: z.boolean().default(false),
});
export type SetPasswordInput = z.infer<typeof setPasswordInputSchema>;

export const passwordResponseSchema = z.object({
  ok: z.literal(true),
  /** How many other sessions were signed out. */
  revokedSessions: z.number().int().nonnegative(),
});
export type PasswordResponse = z.infer<typeof passwordResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Sessions: /api/me/sessions
// ---------------------------------------------------------------------------------------------

export const accountSessionSchema = z.object({
  id: z.string(),
  /** The session making this request. */
  current: z.boolean(),
  /** "Chrome", "Firefox", …; null when the user agent is unknown. */
  browser: z.string().nullable(),
  /** "macOS", "Windows", "iOS", …; null when unknown. */
  os: z.string().nullable(),
  device: z.enum(['desktop', 'mobile', 'tablet']),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: timestampSchema,
  /** Last time the session was refreshed (sessions are extended at most once a day). */
  lastActiveAt: timestampSchema,
  expiresAt: timestampSchema,
});
export type AccountSession = z.infer<typeof accountSessionSchema>;

export const sessionListResponseSchema = z.object({ items: z.array(accountSessionSchema) });
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const revokeSessionsResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Sign-in methods: GET /api/me/connections
// ---------------------------------------------------------------------------------------------

export const SOCIAL_PROVIDERS = ['google', 'github'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export const linkedAccountSchema = z.object({
  /** Better Auth account row id. */
  id: z.string(),
  provider: z.enum(SOCIAL_PROVIDERS),
  /** The provider's user id. */
  accountId: z.string(),
  /** Email (Google) or login (GitHub) of the linked identity, when the provider tells us. */
  label: z.string().nullable(),
  connectedAt: timestampSchema,
});
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

export const connectionsResponseSchema = z.object({
  /** The account has an email + password sign-in. */
  hasPassword: z.boolean(),
  accounts: z.array(linkedAccountSchema),
});
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Deletion: POST /api/me/delete
// ---------------------------------------------------------------------------------------------

export const deleteAccountInputSchema = z.object({
  /** Current password (accounts with a password). */
  password: z.string().min(1).max(LIMITS.password.max).optional(),
  /** The username, typed out (accounts that sign in only with Google or GitHub). */
  confirmUsername: z.string().trim().min(1).max(LIMITS.username.max).optional(),
});
export type DeleteAccountInput = z.infer<typeof deleteAccountInputSchema>;

/** `details` of the `conflict` returned while the user still owns teams. */
export const ownedTeamsConflictSchema = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      /** In Trash (restorable for 30 days, and still owned until purged). */
      deleted: z.boolean(),
    }),
  ),
});
export type OwnedTeamsConflict = z.infer<typeof ownedTeamsConflictSchema>;
