import { z } from 'zod';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTOR_SOURCES,
  ATTACHMENT_PARENT_TYPES,
  LIMITS,
  MAX_ANY_USERNAME_LENGTH,
  NOTIFICATION_TYPES,
  REACTION_TARGET_TYPES,
  REPLY_PARENT_TYPES,
  SEARCH_ENTITY_TYPES,
  SUBSCRIBABLE_TYPES,
  THEMES,
  TRASHABLE_TYPES,
  USER_KINDS,
} from '../constants';
import { PERMISSIONS } from '../permissions';
import { suggestedModelSchema } from './agentRunner';
import {
  cursorPaginationSchema,
  idSchema,
  paginatedSchema,
  reactionEmojiSchema,
  timestampSchema,
} from './common';

/**
 * Wire contracts of the core API (docs/API.md). Request schemas validate input on the server and
 * in web forms; response schemas document (and in tests verify) what the server returns.
 */

// ---------------------------------------------------------------------------------------------
// Shared entity shapes
// ---------------------------------------------------------------------------------------------

const basicUserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  /** Display name. */
  name: z.string(),
  image: z.string().nullable(),
});

/**
 * A person or an agent member. Agents (docs/design/agents-and-pipelines.md §1) carry
 * `kind: 'agent'` and their owner; `kind` is left out for people.
 */
export const userSummarySchema = basicUserSummarySchema.extend({
  kind: z.enum(USER_KINDS).optional(),
  /** For agents: the person the agent works for. */
  agentOwner: basicUserSummarySchema.nullable().optional(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * The API key a write was made through ("ethan via Claude on laptop"), and the agent last seen
 * using it ("Claude"; null before an MCP client introduced itself), shown as "Claude via Ethan's
 * <key>" (BAT-6).
 */
export const viaKeySchema = z.object({
  keyId: z.string(),
  keyName: z.string(),
  agentName: z.string().nullable().optional(),
});
export type ViaKey = z.infer<typeof viaKeySchema>;

/** Who did something. `user` is null for system actions and deleted accounts. */
export const actorRefSchema = z.object({
  user: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  source: z.enum(ACTOR_SOURCES),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

export const roleSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  /** Null only for avatars. */
  teamId: z.string().nullable(),
  parentType: z.enum(ATTACHMENT_PARENT_TYPES),
  parentId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  /** True for raster images rendered inline (never SVG). */
  isImage: z.boolean(),
  /** Relative download URL: `/api/attachments/:id/:filename`. */
  url: z.string(),
  uploader: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  createdAt: timestampSchema,
});
export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * The newest live reply of an issue or task, as the item rail shows it ("Caden: sounds good · 2m",
 * BAT-44). Sent by the issue and task lists when asked for with `latestReply=true`.
 */
export const latestReplySchema = z.object({
  id: z.string(),
  /** Null for deleted accounts. */
  author: userSummarySchema.nullable(),
  /** One line of plain text. */
  excerpt: z.string(),
  createdAt: timestampSchema,
});
export type LatestReply = z.infer<typeof latestReplySchema>;

/** `latestReply=true` in a list's query string. */
export const latestReplyFlagSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** Someone who reacted, and the API key they reacted through ("Claude via Ethan's MSI"). */
export const reactorSchema = userSummarySchema.extend({ via: viaKeySchema.nullable() });
export type Reactor = z.infer<typeof reactorSchema>;

/** One emoji on a reply, task or issue, with everyone who reacted with it (BAT-14). */
export const reactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().positive(),
  /** Did the viewer react with this emoji? */
  reactedByMe: z.boolean(),
  /** Oldest reaction first. */
  users: z.array(reactorSchema),
});
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

export const replySchema = z.object({
  id: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  parentType: z.enum(REPLY_PARENT_TYPES),
  parentId: z.string(),
  /** The reply this one answers (BAT-13); null for a top-level comment. */
  parentReplyId: z.string().nullable(),
  /** Markdown. */
  body: z.string(),
  /**
   * The author meant "no further discussion needed at this time" (agents' done handshake, design
   * §4). Optional so older fixtures still parse.
   */
  closing: z.boolean().optional(),
  author: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  attachments: z.array(attachmentSchema),
  /** In order of each emoji's first reaction. */
  reactions: z.array(reactionSummarySchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  editedAt: timestampSchema.nullable(),
});
export type Reply = z.infer<typeof replySchema>;

export const notificationSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  entityType: z.string(),
  entityId: z.string(),
  actor: userSummarySchema.nullable(),
  viaKeyName: z.string().nullable(),
  /** The agent behind the key ("Claude"), when known (BAT-6). */
  viaAgentName: z.string().nullable().optional(),
  title: z.string(),
  snippet: z.string(),
  /** Relative app URL to open. */
  url: z.string(),
  readAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

/** Field-level change: human-readable values (status names, usernames — not ids). */
export const fieldChangeSchema = z.object({ from: z.unknown(), to: z.unknown() });
export type FieldChange = z.infer<typeof fieldChangeSchema>;

export const activityEntrySchema = z.object({
  id: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string().nullable(),
  actor: actorRefSchema,
  entityType: z.enum(ACTIVITY_ENTITY_TYPES),
  entityId: z.string(),
  /** Dotted action, e.g. `task.status_changed`, `role.permissions_changed`. */
  action: z.string(),
  changes: z.record(z.string(), fieldChangeSchema),
  meta: z.record(z.string(), z.unknown()),
  /** Relative app URL of the entity, when it can still be opened. */
  url: z.string().nullable(),
  createdAt: timestampSchema,
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const searchResultSchema = z.object({
  entityType: z.enum(SEARCH_ENTITY_TYPES),
  entityId: z.string(),
  teamId: z.string(),
  projectId: z.string(),
  /** `KEY-12` / `KEY#51`; for replies, the ref of the parent item. */
  ref: z.string(),
  /** Item title; for replies, the parent's title. */
  title: z.string(),
  /** Plain-text excerpt around the match. */
  snippet: z.string(),
  url: z.string(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

// ---------------------------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------------------------

export const configResponseSchema = z.object({
  version: z.string(),
  signupsEnabled: z.boolean(),
  providers: z.object({ google: z.boolean(), github: z.boolean() }),
  /** A GitHub App is configured: projects can show READMEs from repositories. */
  githubReadmes: z.boolean().optional(),
  maxUploadMb: z.number(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

// ---------------------------------------------------------------------------------------------
// GET /api/me
// ---------------------------------------------------------------------------------------------

export const themeSchema = z.enum(THEMES);

export const meUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /** Null until an OAuth user completes `/onboarding/username`. */
  username: z.string().nullable(),
  displayUsername: z.string().nullable(),
  name: z.string(),
  image: z.string().nullable(),
  theme: themeSchema,
});
export type MeUser = z.infer<typeof meUserSchema>;

export const meProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  /**
   * The viewer's effective permissions in the project: team-level ones from team roles plus the
   * project-level ones after its overrides (design §3). The server always sends it; clients treat
   * a missing list as the team's permissions.
   */
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});
export type MeProject = z.infer<typeof meProjectSchema>;

export const meTeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
  isOwner: z.boolean(),
  /** Effective permissions (full list for owners and administrators). */
  permissions: z.array(z.enum(PERMISSIONS)),
  projects: z.array(meProjectSchema),
  /** Its project list is folded in your sidebar (missing: false). */
  collapsed: z.boolean().optional(),
});
export type MeTeam = z.infer<typeof meTeamSchema>;

/** `PUT /api/me/teams/order`: every one of your teams exactly once, top first. */
export const reorderMyTeamsInputSchema = z.object({
  teamIds: z.array(idSchema).max(500),
});
export type ReorderMyTeamsInput = z.infer<typeof reorderMyTeamsInputSchema>;

/**
 * `PATCH /api/me/teams/:teamId`: fold or unfold a team in your sidebar. (Teams are no longer
 * pinned: projects are, see `pinnedProjectIds`.)
 */
export const updateMyTeamInputSchema = z.object({ collapsed: z.boolean() });
export type UpdateMyTeamInput = z.infer<typeof updateMyTeamInputSchema>;

/**
 * `PUT /api/me/teams/:teamId/projects/order` (BAT#27): the team's projects you can see, top first,
 * each at most once. Projects only move within their team; any left out follow, by name.
 */
export const reorderMyProjectsInputSchema = z.object({
  projectIds: z
    .array(idSchema)
    .min(1)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A project is listed twice' }),
});
export type ReorderMyProjectsInput = z.infer<typeof reorderMyProjectsInputSchema>;

/** `PUT /api/me/pinned-projects/order`: your pinned projects, top first, each once. */
export const reorderPinnedProjectsInputSchema = z.object({
  projectIds: z
    .array(idSchema)
    .max(1000)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'A project is listed twice' }),
});
export type ReorderPinnedProjectsInput = z.infer<typeof reorderPinnedProjectsInputSchema>;

export const meResponseSchema = z.object({
  user: meUserSchema,
  teams: z.array(meTeamSchema),
  /**
   * Your pinned projects, top first: the Pinned section of your sidebar. Only projects you can
   * see (each is in `teams[].projects`). The server always sends it; missing: none.
   */
  pinnedProjectIds: z.array(z.string()).optional(),
  unreadNotifications: z.number().int().nonnegative(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// ---------------------------------------------------------------------------------------------
// API keys: /api/me/api-keys
// ---------------------------------------------------------------------------------------------

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters after `bat_`, shown as `bat_abcd1234…`. */
  prefix: z.string(),
  lastUsedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const apiKeyListResponseSchema = z.object({ apiKeys: z.array(apiKeySchema) });
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(LIMITS.apiKeyName.min, 'Required').max(LIMITS.apiKeyName.max),
  expiresInDays: z
    .number()
    .int()
    .min(LIMITS.apiKeyExpiryDays.min)
    .max(LIMITS.apiKeyExpiryDays.max)
    .optional(),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

export const createApiKeyResponseSchema = z.object({
  /** Plaintext key. Returned exactly once. */
  key: z.string(),
  apiKey: apiKeySchema,
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Notifications: /api/notifications
// ---------------------------------------------------------------------------------------------

export const listNotificationsQuerySchema = cursorPaginationSchema.extend({
  unread: z.enum(['1', '0']).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationListResponseSchema = paginatedSchema(notificationSchema);
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const unreadCountResponseSchema = z.object({ count: z.number().int().nonnegative() });
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

/** A task or issue: `item` marks every notification about it and its replies (BAT-15). */
export const notificationItemSchema = z.object({
  type: z.enum(REPLY_PARENT_TYPES),
  id: idSchema,
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const markNotificationsReadInputSchema = z
  .object({
    ids: z.array(idSchema).min(1).max(LIMITS.bulkIds).optional(),
    all: z.literal(true).optional(),
    item: notificationItemSchema.optional(),
  })
  .refine(
    (value) =>
      [value.ids, value.all, value.item].filter((field) => field !== undefined).length === 1,
    { message: 'Pass one of ids, all: true or item' },
  );
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadInputSchema>;

export const markNotificationsReadResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
});
export type MarkNotificationsReadResponse = z.infer<typeof markNotificationsReadResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Attachments: /api/attachments
// ---------------------------------------------------------------------------------------------

/** Multipart fields accompanying `file` in `POST /api/attachments`. */
export const uploadAttachmentFieldsSchema = z
  .object({
    teamId: idSchema,
    parentType: z.enum(ATTACHMENT_PARENT_TYPES).default('pending'),
    parentId: idSchema.optional(),
  })
  .refine((value) => (value.parentType === 'pending') === (value.parentId === undefined), {
    message: 'parentId is required unless parentType is pending',
    path: ['parentId'],
  });
export type UploadAttachmentFields = z.infer<typeof uploadAttachmentFieldsSchema>;

/** Parents whose attachments can be listed (`GET /api/attachments`). */
export const ATTACHMENT_LIST_PARENT_TYPES = ['issue', 'task', 'reply', 'project'] as const;

export const listAttachmentsQuerySchema = z.object({
  parentType: z.enum(ATTACHMENT_LIST_PARENT_TYPES),
  parentId: idSchema,
});
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsQuerySchema>;

export const attachmentListResponseSchema = z.object({ items: z.array(attachmentSchema) });
export type AttachmentListResponse = z.infer<typeof attachmentListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Replies: /api/replies
// ---------------------------------------------------------------------------------------------

/** Reddit's defaults for a comment tree: comments on first load, and levels shown. */
export const REPLY_TREE = { limit: 200, maxLimit: 1000, depth: 10, maxExpand: 50 } as const;

/** Comma-separated ids in a query string. */
const idListSchema = z
  .string()
  .transform((value) => value.split(',').filter(Boolean))
  .pipe(z.array(idSchema).max(REPLY_TREE.maxExpand));

export const listRepliesQuerySchema = z.object({
  parentType: z.enum(REPLY_PARENT_TYPES),
  parentId: idSchema,
  /** Show only this reply and its answers ("Continue this thread"). */
  root: idSchema.optional(),
  /** Comments to include, oldest first (default 200). */
  limit: z.coerce.number().int().min(1).max(REPLY_TREE.maxLimit).optional(),
  /** Replies whose answers are all wanted ("N more replies"), comma-separated. */
  expand: idListSchema.optional(),
  /**
   * Replies to load with their ancestors whatever the limits, comma-separated: a `#reply-<id>`
   * link, replies the viewer just posted.
   */
  include: idListSchema.optional(),
});
export type ListRepliesQuery = z.infer<typeof listRepliesQuerySchema>;

/**
 * A comment in a reply tree: a live reply, or a `deleted` placeholder (empty body, no author) kept
 * because answers to it are still there.
 */
export const replyNodeSchema = replySchema.extend({
  deleted: z.boolean(),
  /** Answers shown in the tree (live replies and placeholders), loaded or not. */
  replyCount: z.number().int(),
  /** Level below the tree's root: 0 for top-level comments (or the `root` reply). */
  depth: z.number().int(),
});
export type ReplyNode = z.infer<typeof replyNodeSchema>;

export const replyListResponseSchema = z.object({
  /** Parents before their answers; siblings oldest first. */
  items: z.array(replyNodeSchema),
  /** Comments in the tree (or under `root`), loaded or not. */
  total: z.number().int(),
  /** Top-level comments (answers to `root`), loaded or not. */
  topLevelCount: z.number().int(),
  /** Ancestors of `root`, outermost first (empty without `root`). */
  ancestors: z.array(z.string()),
});
export type ReplyListResponse = z.infer<typeof replyListResponseSchema>;

export const createReplyInputSchema = z
  .object({
    parentType: z.enum(REPLY_PARENT_TYPES),
    parentId: idSchema,
    /** The reply this one answers, on the same item; omit for a top-level comment. */
    parentReplyId: idSchema.optional(),
    /** Markdown; may be empty only when files are attached (a chat message of files). */
    body: z.string().trim().max(LIMITS.replyBody.max),
    /** Pending uploads to attach to the new reply. */
    attachmentIds: z.array(idSchema).max(LIMITS.attachmentsPerItem).optional(),
    /** No further discussion needed at this time (agents' done handshake, design §4). */
    closing: z.boolean().optional(),
    /**
     * A model to suggest to the agents this reply starts (mentions, thread replies): only a
     * suggestion, each owner's agent runs it when one of their computers has it.
     */
    suggestedModel: suggestedModelSchema.nullable().optional(),
  })
  .refine(
    (value) => value.body.length >= LIMITS.replyBody.min || (value.attachmentIds?.length ?? 0) > 0,
    { message: 'Required', path: ['body'] },
  );
export type CreateReplyInput = z.infer<typeof createReplyInputSchema>;

export const updateReplyInputSchema = z.object({
  body: z.string().trim().min(LIMITS.replyBody.min, 'Required').max(LIMITS.replyBody.max),
});
export type UpdateReplyInput = z.infer<typeof updateReplyInputSchema>;

// ---------------------------------------------------------------------------------------------
// Reactions: /api/reactions (BAT-14)
// ---------------------------------------------------------------------------------------------

/** `PUT /api/reactions` (body) and `DELETE /api/reactions` (query string). */
export const reactionInputSchema = z.object({
  targetType: z.enum(REACTION_TARGET_TYPES),
  targetId: idSchema,
  emoji: reactionEmojiSchema,
});
export type ReactionInput = z.infer<typeof reactionInputSchema>;

/** The target's reactions after the change. */
export const reactionListResponseSchema = z.object({
  targetType: z.enum(REACTION_TARGET_TYPES),
  targetId: z.string(),
  reactions: z.array(reactionSummarySchema),
});
export type ReactionListResponse = z.infer<typeof reactionListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Activity & audit log
// ---------------------------------------------------------------------------------------------

export const entityActivityQuerySchema = z.object({
  entityType: z.enum(ACTIVITY_ENTITY_TYPES),
  entityId: idSchema,
});
export type EntityActivityQuery = z.infer<typeof entityActivityQuerySchema>;

export const activityListResponseSchema = z.object({ items: z.array(activityEntrySchema) });
export type ActivityListResponse = z.infer<typeof activityListResponseSchema>;

export const auditLogQuerySchema = cursorPaginationSchema.extend({
  actorId: idSchema.optional(),
  keyId: idSchema.optional(),
  source: z.enum(ACTOR_SOURCES).optional(),
  entityType: z.enum(ACTIVITY_ENTITY_TYPES).optional(),
  /** Exact action (`task.created`) or a prefix ending in a dot (`task.`). */
  action: z.string().trim().min(1).max(64).optional(),
  projectId: idSchema.optional(),
  /** Inclusive lower bound, ISO 8601. */
  from: timestampSchema.optional(),
  /** Exclusive upper bound, ISO 8601. */
  to: timestampSchema.optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogResponseSchema = paginatedSchema(activityEntrySchema);
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Mentionables: /api/teams/:teamId/mentionables
// ---------------------------------------------------------------------------------------------

/** Comma-separated names (`alice,bob`): trimmed, lowercased, deduplicated, at most 100. */
const nameListSchema = z
  .string()
  .max(10_000)
  .transform((value) => [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(z.string().max(MAX_ANY_USERNAME_LENGTH)).max(LIMITS.bulkIds));

export const mentionablesQuerySchema = z.object({
  /** Autocomplete: members and mentionable roles matching this text. */
  q: z.string().trim().max(MAX_ANY_USERNAME_LENGTH).optional(),
  /**
   * Lookup instead of autocomplete (rendering mention chips): exactly these usernames and role
   * slugs. Roles are looked up whether or not the caller may mention them.
   */
  usernames: nameListSchema.optional(),
  roles: nameListSchema.optional(),
});
export type MentionablesQuery = z.infer<typeof mentionablesQuerySchema>;

export const mentionablesResponseSchema = z.object({
  users: z.array(userSummarySchema),
  /** Only roles the caller may mention. */
  roles: z.array(roleSummarySchema),
});
export type MentionablesResponse = z.infer<typeof mentionablesResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Search: /api/search
// ---------------------------------------------------------------------------------------------

export const searchQuerySchema = z.object({
  q: z.string().trim().min(LIMITS.searchQuery.min).max(LIMITS.searchQuery.max),
  teamId: idSchema.optional(),
  projectId: idSchema.optional(),
  /** Comma-separated subset of `task,issue,reply`; default all. */
  types: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === '') return [...SEARCH_ENTITY_TYPES];
      const parts = value.split(',').map((part) => part.trim());
      const types = SEARCH_ENTITY_TYPES.filter((type) => parts.includes(type));
      if (types.length !== parts.length) {
        ctx.addIssue({
          code: 'custom',
          message: `types must be a subset of ${SEARCH_ENTITY_TYPES.join(',')}`,
        });
        return z.NEVER;
      }
      return types;
    }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({ results: z.array(searchResultSchema) });
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Subscriptions: /api/subscriptions
// ---------------------------------------------------------------------------------------------

export const subscriptionQuerySchema = z.object({
  entityType: z.enum(SUBSCRIBABLE_TYPES),
  entityId: idSchema,
});
export type SubscriptionQuery = z.infer<typeof subscriptionQuerySchema>;

export const setSubscriptionInputSchema = subscriptionQuerySchema.extend({
  subscribed: z.boolean(),
});
export type SetSubscriptionInput = z.infer<typeof setSubscriptionInputSchema>;

export const subscriptionResponseSchema = z.object({ subscribed: z.boolean() });
export type SubscriptionResponse = z.infer<typeof subscriptionResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Trash (service: core; routes: admin)
// ---------------------------------------------------------------------------------------------

export const trashItemSchema = z.object({
  type: z.enum(TRASHABLE_TYPES),
  id: z.string(),
  teamId: z.string(),
  projectId: z.string().nullable(),
  /** Title snapshot: item title, project name, file name, or a reply excerpt. */
  title: z.string(),
  /** `KEY-12` / `KEY#51` for tasks and issues, the parent's ref for replies, else null. */
  ref: z.string().nullable(),
  /** Author, uploader or creator of the item. */
  author: userSummarySchema.nullable(),
  deletedBy: userSummarySchema.nullable(),
  via: viaKeySchema.nullable(),
  deletedAt: timestampSchema,
  /** Whole days until the daily purge removes it for good. */
  daysLeft: z.number().int().nonnegative(),
});
export type TrashItem = z.infer<typeof trashItemSchema>;

export const trashListResponseSchema = z.object({ items: z.array(trashItemSchema) });
export type TrashListResponse = z.infer<typeof trashListResponseSchema>;

export const trashItemRefSchema = z.object({
  type: z.enum(TRASHABLE_TYPES),
  id: idSchema,
});
export type TrashItemRef = z.infer<typeof trashItemRefSchema>;

// ---------------------------------------------------------------------------------------------
// Security log: GET /api/me/security-log
// ---------------------------------------------------------------------------------------------

export const securityLogQuerySchema = cursorPaginationSchema;
export type SecurityLogQuery = z.infer<typeof securityLogQuerySchema>;

export const securityLogResponseSchema = paginatedSchema(activityEntrySchema);
export type SecurityLogResponse = z.infer<typeof securityLogResponseSchema>;

/**
 * BAT#42: the agent members working on a task or issue right now: a desktop runner reports its
 * harness running a job about the item, or a live MCP listener claimed one (a job only queued,
 * waiting for usage or held doesn't count). Null when no agent is working on it.
 */
export const agentWorkingSchema = z.object({
  agentIds: z.array(z.string()),
  /** Display names, in the order of `agentIds` ("Ethan AI"). */
  names: z.array(z.string()),
});
export type AgentWorking = z.infer<typeof agentWorkingSchema>;
