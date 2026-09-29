import { z } from 'zod';
import { CONVERSATION_MODES, ISSUE_LINK_KINDS, LIMITS, STATUS_ICONS } from '../constants';
import {
  cursorPaginationSchema,
  idSchema,
  markdownSchema,
  paginatedSchema,
  timestampSchema,
  titleSchema,
} from './common';
import { attachmentSchema, reactionSummarySchema, userSummarySchema, viaKeySchema } from './core';

/**
 * Wire contracts of the issues module (SPEC §1.7): forum-style issues, numbered per project
 * (`KEY#51`). Request schemas validate REST bodies, MCP inputs and web forms; response schemas
 * document (and in tests verify) what the server returns. `path` fields are relative web-app paths.
 */

export const ISSUE_STATES = ['open', 'resolved', 'all'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

export const ISSUE_SORTS = ['latest-activity', 'newest', 'oldest', 'most-replies'] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export const ISSUE_SORT_LABELS: Readonly<Record<IssueSort, string>> = {
  'latest-activity': 'Latest activity',
  newest: 'Newest',
  oldest: 'Oldest',
  'most-replies': 'Most replies',
};

/** How several label filters combine: an issue carries any of them, or all of them. */
export const LABEL_MATCHES = ['any', 'all'] as const;
export type LabelMatch = (typeof LABEL_MATCHES)[number];

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const issueLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
});
export type IssueLabel = z.infer<typeof issueLabelSchema>;

/** An issue as listed (issue list rows, `list_issues`). */
export const issueSummarySchema = z.object({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  number: z.number().int().positive(),
  /** `KEY#51`. */
  ref: z.string(),
  title: z.string(),
  resolved: z.boolean(),
  resolvedAt: timestampSchema.nullable(),
  /** Alphabetical. */
  labels: z.array(issueLabelSchema),
  /** Null for deleted accounts. */
  author: userSummarySchema.nullable(),
  /** The API key the issue was opened through ("ethan via Claude on laptop"). */
  via: viaKeySchema.nullable(),
  replyCount: z.number().int().nonnegative(),
  /** Latest reply, edit, label change, resolve or reopen (the default sort). */
  lastActivityAt: timestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** When the title or body was last edited, or null. */
  editedAt: timestampSchema.nullable(),
  /** Relative web-app path of the issue page. */
  path: z.string(),
  /**
   * The viewer's unread notifications about the issue and its replies (BAT-16). Sent with the
   * issue list.
   */
  unreadCount: z.number().int().nonnegative().optional(),
});
export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** A task addressing the issue (`task_issue_link`), shown as "Addressed by". */
export const linkedTaskSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  /** `KEY-12`. */
  ref: z.string(),
  title: z.string(),
  /**
   * `fixes`: the issue resolves when the task enters a stage that resolves fixed issues;
   * `relates`: no automation.
   */
  kind: z.enum(ISSUE_LINK_KINDS),
  status: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    icon: z.enum(STATUS_ICONS),
  }),
  path: z.string(),
});
export type LinkedTask = z.infer<typeof linkedTaskSchema>;

/** Everything the issue page needs. */
export const issueSchema = issueSummarySchema.extend({
  /** Markdown. */
  body: z.string(),
  attachments: z.array(attachmentSchema),
  resolvedBy: userSummarySchema.nullable(),
  /** Live tasks linked to the issue, by number. */
  linkedTasks: z.array(linkedTaskSchema),
  /** Emoji reactions on the issue post (BAT-14). */
  reactions: z.array(reactionSummarySchema),
  /** Is the viewer subscribed to reply notifications? */
  subscribed: z.boolean(),
  /** How the replies are shown: `chat` or `forum` (absent in older fixtures: forum). */
  conversationMode: z.enum(CONVERSATION_MODES).optional(),
});
export type Issue = z.infer<typeof issueSchema>;

export const issueCountsSchema = z.object({
  open: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
});
export type IssueCounts = z.infer<typeof issueCountsSchema>;

export const issueListResponseSchema = paginatedSchema(issueSummarySchema).extend({
  /** Issues matching every filter except the state, per state (the Open/Resolved/All tabs). */
  counts: issueCountsSchema,
});
export type IssueListResponse = z.infer<typeof issueListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/** Comma-separated ids in a query string (`a,b`): trimmed, deduplicated, at most 100. */
const idListSchema = z
  .string()
  .max(10_000)
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(idSchema).max(LIMITS.bulkIds));

/** `GET /api/projects/:projectId/issues`. */
export const listIssuesQuerySchema = cursorPaginationSchema.extend({
  state: z.enum(ISSUE_STATES).default('open'),
  /** Label ids, comma-separated. */
  labels: idListSchema.optional(),
  labelMatch: z.enum(LABEL_MATCHES).default('any'),
  /** Author user id. */
  author: idSchema.optional(),
  /** Full-text search over titles, bodies and replies; `#12` or `12` also matches that number. */
  q: z.string().trim().max(LIMITS.searchQuery.max).optional(),
  sort: z.enum(ISSUE_SORTS).default('latest-activity'),
});
export type ListIssuesQuery = z.infer<typeof listIssuesQuerySchema>;
export type ListIssuesQueryInput = z.input<typeof listIssuesQuerySchema>;

const labelIdsSchema = z.array(idSchema).max(LIMITS.bulkIds);

export const createIssueInputSchema = z.object({
  title: titleSchema,
  /** Markdown; may be empty. */
  body: markdownSchema.optional(),
  /** Label ids of the project. */
  labelIds: labelIdsSchema.optional(),
  /** Pending uploads to attach (files; images linked from the body are attached automatically). */
  attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerItem).optional(),
  /** Response style: `chat` (default) or `forum`. */
  conversationMode: z.enum(CONVERSATION_MODES).optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueInputSchema>;

/** Label changes: replace the whole set, or add and/or remove some. */
export const issueLabelsChangeSchema = z
  .object({
    set: labelIdsSchema.optional(),
    add: labelIdsSchema.optional(),
    remove: labelIdsSchema.optional(),
  })
  .refine((value) => value.set === undefined || (!value.add && !value.remove), {
    message: 'Pass either set, or add/remove',
  })
  .refine((value) => value.set !== undefined || value.add || value.remove, {
    message: 'Pass set, add or remove',
  });
export type IssueLabelsChange = z.infer<typeof issueLabelsChangeSchema>;

export const updateIssueInputSchema = z
  .object({
    title: titleSchema.optional(),
    body: markdownSchema.optional(),
    labels: issueLabelsChangeSchema.optional(),
    /** Pending uploads to attach (images linked from a new body are attached automatically). */
    attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerItem).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateIssueInput = z.infer<typeof updateIssueInputSchema>;
