import { z } from 'zod';
import { LIMITS, STATUS_CATEGORIES } from '../constants';
import { PROJECT_KEY_PATTERN } from '../refs';
import { emojiSchema, hexColorSchema, idSchema, projectKeySchema, timestampSchema } from './common';
import { userSummarySchema } from './core';

/**
 * Wire contracts of the projects module (SPEC §1.4–1.6): projects, their task statuses and labels.
 * Request schemas validate REST bodies, MCP inputs and web forms; response schemas document (and
 * in tests verify) what the server returns. `path` fields are relative web-app paths.
 */

/** Per-project caps that keep boards and pickers usable. */
export const PROJECT_LIMITS = { statuses: 50, labels: 200 } as const;

// ---------------------------------------------------------------------------------------------
// Project keys
// ---------------------------------------------------------------------------------------------

const KEY_MAX = LIMITS.projectKey.max;

/** Latin letters and digits of a name, with accents dropped (`Café` → `Cafe`). */
function asciiWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Suggests a project key from its name (SPEC §1.4): the initials of several words (`Customer
 * support portal` → `CSP`), or the start of a single word (`Baton` → `BAT`). Always matches
 * `[A-Z][A-Z0-9]{1,5}`; `PRJ` when the name has nothing usable.
 */
export function deriveProjectKey(name: string): string {
  // A key must start with a letter: drop leading digits of the first word (`3D` → `D`).
  const words = asciiWords(name)
    .map((word, index) => (index === 0 ? word.replace(/^[0-9]+/, '') : word))
    .filter(Boolean);
  const [first] = words;
  if (!first) return 'PRJ';
  const key =
    words.length === 1
      ? first.slice(0, 3)
      : words
          .map((word) => word[0])
          .join('')
          .slice(0, 4);
  // A one-letter name (`X`) still needs a second character.
  return key.length < 2 ? `${key}X` : key;
}

/**
 * `base`, then `base2`, `base3`, … (trimmed so the key stays within 6 characters): the candidates
 * tried when the derived key is taken.
 */
export function projectKeyCandidates(base: string, count = 50): string[] {
  const candidates = [base];
  for (let n = 2; candidates.length < count; n++) {
    const suffix = String(n);
    candidates.push(`${base.slice(0, KEY_MAX - suffix.length)}${suffix}`);
  }
  return candidates.filter((key) => PROJECT_KEY_PATTERN.test(key));
}

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

export const projectNameSchema = z
  .string()
  .trim()
  .min(LIMITS.projectName.min, 'Required')
  .max(LIMITS.projectName.max, `At most ${LIMITS.projectName.max} characters`);

export const projectDescriptionSchema = z
  .string()
  .trim()
  .max(LIMITS.projectDescription.max, `At most ${LIMITS.projectDescription.max} characters`);

export const readmeSchema = z
  .string()
  .max(LIMITS.readme.max, `At most ${LIMITS.readme.max.toLocaleString('en-US')} characters`);

export const statusNameSchema = z
  .string()
  .trim()
  .min(LIMITS.statusName.min, 'Required')
  .max(LIMITS.statusName.max, `At most ${LIMITS.statusName.max} characters`);

export const labelNameSchema = z
  .string()
  .trim()
  .min(LIMITS.labelName.min, 'Required')
  .max(LIMITS.labelName.max, `At most ${LIMITS.labelName.max} characters`);

export const labelDescriptionSchema = z
  .string()
  .trim()
  .max(LIMITS.labelDescription.max, `At most ${LIMITS.labelDescription.max} characters`);

export const statusCategorySchema = z.enum(STATUS_CATEGORIES);

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const statusSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
  /** `done` statuses count as finished (overdue logic, progress, claims, issue auto-resolution). */
  category: statusCategorySchema,
  /** Column order, ascending from 0. */
  position: z.number().int().nonnegative(),
  /** New tasks start here. Exactly one status per project is the default. */
  isDefault: z.boolean(),
  /** Tasks currently in this status (not counting deleted ones). */
  taskCount: z.number().int().nonnegative(),
});
export type Status = z.infer<typeof statusSchema>;

export const labelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
  /** Issues and tasks carrying the label (not counting deleted ones). */
  issueCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
});
export type Label = z.infer<typeof labelSchema>;

export const projectCountsSchema = z.object({
  /** Tasks in an `open`-category status. */
  openTasks: z.number().int().nonnegative(),
  /** Tasks in a `done`-category status. */
  doneTasks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  resolvedIssues: z.number().int().nonnegative(),
});
export type ProjectCounts = z.infer<typeof projectCountsSchema>;

/** A project as listed (team home, pickers, `list_projects`). */
export const projectSummarySchema = z.object({
  id: z.string(),
  teamId: z.string(),
  teamSlug: z.string(),
  name: z.string(),
  /** `[A-Z][A-Z0-9]{1,5}`, unique per team. */
  key: z.string(),
  /** `team-slug/KEY`. */
  ref: z.string(),
  /** Short description (≤ 280 characters). */
  description: z.string(),
  /** Emoji, or null for the colored initial. */
  icon: z.string().nullable(),
  color: z.string(),
  counts: projectCountsSchema,
  /** Relative web-app path of the overview page. */
  path: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** A project with everything its overview and settings need. */
export const projectSchema = projectSummarySchema.extend({
  /** Markdown. */
  readme: z.string(),
  createdBy: userSummarySchema.nullable(),
  /** Previous keys that still resolve (old refs and links). */
  keyAliases: z.array(z.string()),
  /** In column order. */
  statuses: z.array(statusSchema),
  /** Alphabetical. */
  labels: z.array(labelSchema),
});
export type Project = z.infer<typeof projectSchema>;

export const projectListResponseSchema = z.object({ items: z.array(projectSummarySchema) });
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const statusListResponseSchema = z.object({ items: z.array(statusSchema) });
export type StatusListResponse = z.infer<typeof statusListResponseSchema>;

export const labelListResponseSchema = z.object({ items: z.array(labelSchema) });
export type LabelListResponse = z.infer<typeof labelListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Projects: requests
// ---------------------------------------------------------------------------------------------

export const createProjectInputSchema = z.object({
  name: projectNameSchema,
  /** Derived from the name when omitted (made unique within the team). */
  key: projectKeySchema.optional(),
  description: projectDescriptionSchema.optional(),
  readme: readmeSchema.optional(),
  icon: emojiSchema.nullable().optional(),
  color: hexColorSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .object({
    name: projectNameSchema.optional(),
    /** The old key keeps resolving (refs, links) through the key aliases. */
    key: projectKeySchema.optional(),
    description: projectDescriptionSchema.optional(),
    readme: readmeSchema.optional(),
    /** null removes the icon. */
    icon: emojiSchema.nullable().optional(),
    color: hexColorSchema.optional(),
    /**
     * Pending uploads to attach to the project (README images and files). Images referenced by
     * the new README are attached automatically.
     */
    attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerItem).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const restoreProjectInputSchema = z.object({
  /** A new key, when another project has taken this one's key since it was deleted. */
  key: projectKeySchema.optional(),
});
export type RestoreProjectInput = z.infer<typeof restoreProjectInputSchema>;

/** `GET /api/teams/:teamId/projects/key-check`. */
export const projectKeyCheckQuerySchema = z.object({
  key: z.string().trim().max(32),
  /** The project being edited (its own key and aliases count as available). */
  projectId: idSchema.optional(),
});
export type ProjectKeyCheckQuery = z.infer<typeof projectKeyCheckQuerySchema>;

export const projectKeyCheckResponseSchema = z.object({
  /** The key as it would be stored (trimmed, uppercase). */
  key: z.string(),
  valid: z.boolean(),
  available: z.boolean(),
  /** Why the key can't be used, or null. */
  message: z.string().nullable(),
  /** A free key close to the requested one (or to the derived key). */
  suggestion: z.string(),
});
export type ProjectKeyCheckResponse = z.infer<typeof projectKeyCheckResponseSchema>;

/** `GET /api/projects/resolve?ref=team-slug/KEY` (old keys resolve to the project). */
export const resolveProjectQuerySchema = z.object({
  ref: z.string().trim().min(1).max(64),
});
export type ResolveProjectQuery = z.infer<typeof resolveProjectQuerySchema>;

// ---------------------------------------------------------------------------------------------
// Statuses: requests
// ---------------------------------------------------------------------------------------------

export const createStatusInputSchema = z.object({
  name: statusNameSchema,
  color: hexColorSchema.optional(),
  category: statusCategorySchema.default('open'),
  /** Make it the default status for new tasks. */
  isDefault: z.boolean().optional(),
});
export type CreateStatusInput = z.infer<typeof createStatusInputSchema>;

export const updateStatusInputSchema = z
  .object({
    name: statusNameSchema.optional(),
    color: hexColorSchema.optional(),
    /** Recategorizing marks its tasks completed (done) or not completed (open). */
    category: statusCategorySchema.optional(),
    /** Only `true`: make another status the default to unset this one. */
    isDefault: z.literal(true).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateStatusInput = z.infer<typeof updateStatusInputSchema>;

export const reorderStatusesInputSchema = z.object({
  /** Every status id of the project, in the new order. */
  statusIds: z.array(idSchema).min(1).max(PROJECT_LIMITS.statuses),
});
export type ReorderStatusesInput = z.infer<typeof reorderStatusesInputSchema>;

export const deleteStatusQuerySchema = z.object({
  /** Status that receives the deleted status's tasks (and its default flag). */
  moveTo: idSchema,
});
export type DeleteStatusQuery = z.infer<typeof deleteStatusQuerySchema>;

export const deleteStatusResponseSchema = z.object({
  ok: z.literal(true),
  /** Tasks moved to the `moveTo` status. */
  movedTasks: z.number().int().nonnegative(),
});
export type DeleteStatusResponse = z.infer<typeof deleteStatusResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Labels: requests
// ---------------------------------------------------------------------------------------------

export const createLabelInputSchema = z.object({
  name: labelNameSchema,
  color: hexColorSchema.optional(),
  description: labelDescriptionSchema.optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelInputSchema>;

export const updateLabelInputSchema = z
  .object({
    name: labelNameSchema.optional(),
    color: hexColorSchema.optional(),
    description: labelDescriptionSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateLabelInput = z.infer<typeof updateLabelInputSchema>;

export const deleteLabelResponseSchema = z.object({
  ok: z.literal(true),
  /** Items the label was removed from. */
  removedFrom: z.object({
    issues: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  }),
});
export type DeleteLabelResponse = z.infer<typeof deleteLabelResponseSchema>;
