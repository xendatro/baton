import { z } from 'zod';
import { LIMITS, THEMES } from '@shared/constants';
import { updateProfileInputSchema, usernameInputSchema } from '@shared/schemas/account';
import { displayNameSchema } from '@shared/schemas/common';
import { parseInput } from '../../lib/validate';
import { consumeRateLimit } from '../../middleware/rateLimit';
import { listSecurityLog } from '../../services/activity';
import { removeAvatar, setAvatarFromBase64, updateProfile } from '../../services/account';
import { withAbsoluteUrls } from '../util';
import { defineTool, type McpTool } from './define';

/**
 * Account MCP tools (SPEC §5.1 [account]): the profile of the user the API key acts for. Password,
 * sign-in methods, sessions, API keys and account deletion are web-only (SPEC §1.14).
 */

const updateProfileTool = defineTool({
  name: 'update_profile',
  title: 'Update profile',
  description:
    'Changes your own display name, username and/or theme (pass only what should change). Usernames are 3–32 letters, digits or underscores, unique and stored lowercase; teammates @mention you with it, and existing @mentions of the old username stop pointing at you. Returns the updated profile.',
  input: z.object({
    name: displayNameSchema.optional().describe('New display name (1–64 characters)'),
    username: usernameInputSchema
      .optional()
      .describe('New username, e.g. "ada_l" (the typed case is kept for display)'),
    theme: z.enum(THEMES).optional().describe('Web app theme: system, light or dark'),
  }),
  handler: (ctx, input) =>
    updateProfile(ctx.deps, ctx.actor, parseInput(updateProfileInputSchema, input)),
});

const setAvatarTool = defineTool({
  name: 'set_avatar',
  title: 'Set avatar',
  description:
    'Replaces your profile picture with an image (PNG, JPEG, GIF or WebP, at most 5 MB), sent as base64. It is shown as a circle, so a square image works best. Counts against the per-user upload rate limit (30 per minute).',
  input: z.object({
    filename: z.string().min(1).max(LIMITS.filename.max).describe('File name, e.g. avatar.png'),
    contentBase64: z
      .string()
      .min(1)
      .describe('Image bytes, base64-encoded (a data: URL prefix is accepted)'),
  }),
  handler: (ctx, input) => {
    consumeRateLimit(ctx.deps.rateLimiter, 'uploads', ctx.actor.userId);
    return setAvatarFromBase64(ctx.deps, ctx.actor, input);
  },
});

const removeAvatarTool = defineTool({
  name: 'remove_avatar',
  title: 'Remove avatar',
  description:
    'Removes your profile picture; your initials are shown instead. Returns the updated profile.',
  input: z.object({}),
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: (ctx) => removeAvatar(ctx.deps, ctx.actor),
});

const getSecurityLogTool = defineTool({
  name: 'get_security_log',
  title: 'Get security log',
  description:
    'Your account security log, newest first: sign-ins (method, IP, browser), password changes, API keys created or revoked, Google/GitHub accounts linked or unlinked, sessions signed out and profile changes. Paginated with nextCursor.',
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.page.maxSize)
      .default(50)
      .describe('Page size (1–100)'),
    cursor: z.string().min(1).optional().describe('nextCursor from a previous call'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const page = listSecurityLog(ctx.deps, ctx.actor, input);
    return { items: withAbsoluteUrls(ctx.deps, page.items), nextCursor: page.nextCursor };
  },
});

export const accountTools: McpTool[] = [
  updateProfileTool,
  setAvatarTool,
  removeAvatarTool,
  getSecurityLogTool,
];
