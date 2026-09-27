import { z } from 'zod';
import { LIMITS, REACTION_LIMITS, RESERVED_USERNAMES } from '../constants';
import { PROJECT_KEY_PATTERN, TEAM_SLUG_PATTERN } from '../refs';

/** Error codes of the JSON error envelope (SPEC §5). */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'email_not_verified',
  'username_required',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** `{ "error": { "code", "message", "details"? } }` — every non-2xx JSON response. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Entity ids: ULIDs for app tables; kept permissive so any stored id round-trips. */
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid id');

/** ISO 8601 timestamp as sent on the wire (all `…At` fields). */
export const timestampSchema = z.iso.datetime({ offset: true });

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(LIMITS.username.min, `At least ${LIMITS.username.min} characters`)
  .max(LIMITS.username.max, `At most ${LIMITS.username.max} characters`)
  .regex(/^[a-z0-9_]+$/, 'Only lowercase letters, digits and underscores')
  .refine((value) => !RESERVED_USERNAMES.has(value), 'This username is reserved');

export const displayNameSchema = z
  .string()
  .trim()
  .min(LIMITS.displayName.min, 'Required')
  .max(LIMITS.displayName.max);

export const emailSchema = z.email().max(LIMITS.email.max).toLowerCase();

export const passwordSchema = z
  .string()
  .min(LIMITS.password.min, `At least ${LIMITS.password.min} characters`)
  .max(LIMITS.password.max);

export const teamSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(LIMITS.teamSlug.min)
  .max(LIMITS.teamSlug.max)
  .regex(TEAM_SLUG_PATTERN, 'Lowercase letters, digits and single dashes');

export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PROJECT_KEY_PATTERN, '2–6 characters: a letter, then letters or digits');

export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'A color like #6366f1')
  .transform((value) => value.toLowerCase());

// Pictographs, flags, skin tones, ZWJ / variation-selector / keycap joiners, tag sequences.
const EMOJI_PATTERN =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3|[#*0-9]|[\u{e0020}-\u{e007f}])+$/u;
const PICTOGRAPH_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/** A single emoji (including ZWJ sequences, skin tones, keycaps and flags). */
export const emojiSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine(
    (value) => EMOJI_PATTERN.test(value) && PICTOGRAPH_PATTERN.test(value),
    'Must be an emoji',
  );

/** UTF-8 length of `value`, without `TextEncoder` (shared code has no DOM or Node APIs). */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Number of user-perceived characters (grapheme clusters) in `value`. */
export function graphemeCount(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
}

/** A reaction (BAT-14): exactly one emoji grapheme, at most `REACTION_LIMITS.emojiBytes` bytes. */
export const reactionEmojiSchema = emojiSchema.refine(
  (value) => utf8Bytes(value) <= REACTION_LIMITS.emojiBytes && graphemeCount(value) === 1,
  'Must be a single emoji',
);

/** Calendar date `YYYY-MM-DD` (no time zone). */
export const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-01-31')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'Not a valid date');

export const titleSchema = z
  .string()
  .trim()
  .min(LIMITS.title.min, 'Required')
  .max(LIMITS.title.max);

/** Markdown document (issue/task bodies, READMEs). May be empty. */
export const markdownSchema = z.string().max(LIMITS.body.max);

/** Boolean in a query string: `1`/`true` or `0`/`false`. */
export const queryBooleanSchema = z
  .enum(['1', '0', 'true', 'false'])
  .transform((value) => value === '1' || value === 'true');

/** Cursor pagination input (query string). `cursor` is opaque; pass back `nextCursor`. */
export const cursorPaginationSchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.page.maxSize).default(LIMITS.page.defaultSize),
});

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

/** Cursor-paginated list response. `nextCursor` is null on the last page. */
export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;
