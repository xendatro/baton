import { z } from 'zod';
import { LIMITS } from '../constants';
import { PERMISSIONS } from '../permissions';
import { emojiSchema, hexColorSchema, idSchema, teamSlugSchema, timestampSchema } from './common';
import { userSummarySchema } from './core';

/**
 * Wire contracts of the teams module (SPEC §1.3): teams, members, roles and invite links.
 * Request schemas validate REST bodies, MCP tool input and web forms; response schemas document
 * (and in tests verify) what the server returns.
 */

// ---------------------------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------------------------

/**
 * URL slug from a name: accents dropped, lowercase letters and digits, single dashes between
 * words, at most `maxLength` characters. May be empty (e.g. for an emoji-only name).
 */
export function slugify(name: string, maxLength: number = LIMITS.teamSlug.max): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

/** The slug a new team named `name` gets when none is given (before de-duplication). */
export function teamSlugFromName(name: string): string {
  const slug = slugify(name);
  if (slug.length >= LIMITS.teamSlug.min) return slug;
  return slug ? `team-${slug}` : 'team';
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

export const teamNameSchema = z
  .string()
  .trim()
  .min(LIMITS.teamName.min, 'Required')
  .max(LIMITS.teamName.max, `At most ${LIMITS.teamName.max} characters`);

export const teamDescriptionSchema = z
  .string()
  .trim()
  .max(LIMITS.teamDescription.max, `At most ${LIMITS.teamDescription.max} characters`);

export const teamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  /** Emoji, or null for the colored initial. */
  icon: z.string().nullable(),
  color: z.string(),
  ownerId: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Team = z.infer<typeof teamSchema>;

/** A team with its owner and size (`GET /api/teams/:teamId`, `GET /api/teams`). */
export const teamDetailSchema = teamSchema.extend({
  owner: userSummarySchema.nullable(),
  memberCount: z.number().int().nonnegative(),
});
export type TeamDetail = z.infer<typeof teamDetailSchema>;

export const teamListResponseSchema = z.object({ items: z.array(teamDetailSchema) });
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;

export const createTeamInputSchema = z.object({
  name: teamNameSchema,
  /** Derived from the name when omitted (with a numeric suffix if it is taken). */
  slug: teamSlugSchema.optional(),
  description: teamDescriptionSchema.optional(),
  icon: emojiSchema.nullable().optional(),
  color: hexColorSchema.optional(),
});
export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

export const updateTeamInputSchema = z.object({
  name: teamNameSchema.optional(),
  slug: teamSlugSchema.optional(),
  description: teamDescriptionSchema.optional(),
  icon: emojiSchema.nullable().optional(),
  color: hexColorSchema.optional(),
});
export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;

export const transferOwnershipInputSchema = z.object({
  /** The member who becomes the owner. */
  userId: idSchema,
});
export type TransferOwnershipInput = z.infer<typeof transferOwnershipInputSchema>;

/** A project card on the team home page. */
export const teamProjectCardSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  /** Tasks in an open-category status. */
  openTasks: z.number().int().nonnegative(),
  /** Unresolved issues. */
  openIssues: z.number().int().nonnegative(),
});
export type TeamProjectCard = z.infer<typeof teamProjectCardSchema>;

/** `GET /api/teams/:teamId/overview`: what the team home page shows besides the members. */
export const teamOverviewSchema = z.object({
  team: teamDetailSchema,
  projects: z.array(teamProjectCardSchema),
});
export type TeamOverview = z.infer<typeof teamOverviewSchema>;

/** Deleted teams contract (consumed by the account module). */
export const deletedTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  deletedAt: timestampSchema,
  /** When the daily purge removes the team for good (deletedAt + 30 days). */
  purgeAt: timestampSchema,
});
export type DeletedTeam = z.infer<typeof deletedTeamSchema>;

export const deletedTeamsResponseSchema = z.object({ items: z.array(deletedTeamSchema) });
export type DeletedTeamsResponse = z.infer<typeof deletedTeamsResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

export const permissionSchema = z.enum(PERMISSIONS);

export const roleNameSchema = z
  .string()
  .trim()
  .min(LIMITS.roleName.min, 'Required')
  .max(LIMITS.roleName.max, `At most ${LIMITS.roleName.max} characters`)
  .refine((value) => !value.startsWith('@'), 'Role names can’t start with @');

export const roleSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  /** Unique per team; mentioned as `@&slug`. */
  slug: z.string(),
  color: z.string().nullable(),
  /** Higher ranks higher; `@everyone` is always 0. */
  position: z.number().int().nonnegative(),
  permissions: z.array(permissionSchema),
  mentionable: z.boolean(),
  isEveryone: z.boolean(),
  /** Members holding the role (every member for `@everyone`). */
  memberCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Role = z.infer<typeof roleSchema>;

/** Highest position first; `@everyone` last. */
export const roleListResponseSchema = z.object({ items: z.array(roleSchema) });
export type RoleListResponse = z.infer<typeof roleListResponseSchema>;

const permissionListSchema = z.array(permissionSchema).max(PERMISSIONS.length);

export const createRoleInputSchema = z.object({
  name: roleNameSchema,
  color: hexColorSchema.nullable().optional(),
  mentionable: z.boolean().optional(),
  permissions: permissionListSchema.optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleInputSchema>;

/** `@everyone` only accepts `permissions`. */
export const updateRoleInputSchema = z.object({
  name: roleNameSchema.optional(),
  color: hexColorSchema.nullable().optional(),
  mentionable: z.boolean().optional(),
  /** Replaces the role's permissions. */
  permissions: permissionListSchema.optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleInputSchema>;

export const reorderRolesInputSchema = z.object({
  /** Every role except `@everyone`, highest first. */
  roleIds: z.array(idSchema).max(250),
});
export type ReorderRolesInput = z.infer<typeof reorderRolesInputSchema>;

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

export const memberRoleSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  position: z.number().int().nonnegative(),
});
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const memberSchema = z.object({
  user: userSummarySchema,
  joinedAt: timestampSchema,
  isOwner: z.boolean(),
  /** Explicit roles, highest first (`@everyone` is implicit). */
  roles: z.array(memberRoleSchema),
  /** Name color: the highest-positioned role that has a color. */
  color: z.string().nullable(),
});
export type Member = z.infer<typeof memberSchema>;

/** Owner first, then by display name. */
export const memberListResponseSchema = z.object({ items: z.array(memberSchema) });
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------------------------

/** Expiry choices offered when creating an invite link. */
export const INVITE_EXPIRY_OPTIONS = ['30m', '1h', '6h', '12h', '1d', '7d', 'never'] as const;
export type InviteExpiry = (typeof INVITE_EXPIRY_OPTIONS)[number];

export const INVITE_EXPIRY_MS: Readonly<Record<Exclude<InviteExpiry, 'never'>, number>> = {
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export const INVITE_EXPIRY_LABELS: Readonly<Record<InviteExpiry, string>> = {
  '30m': '30 minutes',
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': '1 day',
  '7d': '7 days',
  never: 'Never',
};

/** Max-uses choices offered by the web app (null = unlimited). The API accepts any 1–10000. */
export const INVITE_MAX_USES_OPTIONS = [null, 1, 5, 10, 25, 50, 100] as const;

export const INVITE_STATUSES = ['active', 'expired', 'used_up'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const inviteSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  code: z.string(),
  /** Relative join URL: `/join/<code>`. */
  url: z.string(),
  createdBy: userSummarySchema.nullable(),
  /** Null = unlimited. */
  maxUses: z.number().int().positive().nullable(),
  uses: z.number().int().nonnegative(),
  /** Null = never expires. */
  expiresAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  status: z.enum(INVITE_STATUSES),
});
export type Invite = z.infer<typeof inviteSchema>;

/** Newest first; revoked invites are not listed. */
export const inviteListResponseSchema = z.object({ items: z.array(inviteSchema) });
export type InviteListResponse = z.infer<typeof inviteListResponseSchema>;

export const createInviteInputSchema = z.object({
  expiresIn: z.enum(INVITE_EXPIRY_OPTIONS).default('7d'),
  maxUses: z
    .number()
    .int()
    .min(LIMITS.inviteMaxUses.min)
    .max(LIMITS.inviteMaxUses.max)
    .nullable()
    .default(null),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

/** 10 base62 characters (codes are case-sensitive). */
export const inviteCodeSchema = z.string().regex(/^[0-9A-Za-z]{10}$/, 'Not an invite code');

/** Why an invite link can't be used; sent as `error.details.reason` with a 404. */
export const INVITE_ERROR_REASONS = ['invalid', 'expired', 'revoked', 'used_up'] as const;
export type InviteErrorReason = (typeof INVITE_ERROR_REASONS)[number];

export const invitePreviewSchema = z.object({
  code: z.string(),
  team: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    color: z.string(),
    memberCount: z.number().int().nonnegative(),
  }),
  inviter: userSummarySchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  /** The viewer already belongs to the team (accepting just opens it). */
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const acceptInviteResponseSchema = z.object({
  team: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  /** True when the caller was already a member (nothing changed). */
  alreadyMember: z.boolean(),
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
