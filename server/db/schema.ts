/**
 * Database schema (SPEC §4). SQLite via Drizzle; migrations are generated with
 * `npm run db:generate` into ./migrations and committed.
 *
 * Conventions: text ULID primary keys (`newId`), integer-ms timestamps (`Date` in TypeScript),
 * snake_case column names, an index on every foreign key, soft-deletable rows carry
 * `deletedAt`/`deletedById`/`deletedViaKeyId`. Author/actor references use `ON DELETE SET NULL`
 * so content survives account deletion ("deleted user"). The `activity` table deliberately has no
 * foreign keys: the audit log is append-only and must outlive purged entities.
 * The FTS5 `search_index` table lives in a custom SQL migration and is queried with raw SQL.
 *
 * Imports here are relative (not `@shared/…`) because drizzle-kit loads this file directly.
 */
import { relations, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTOR_SOURCES,
  ATTACHMENT_PARENT_TYPES,
  ISSUE_LINK_KINDS,
  NOTIFICATION_TYPES,
  REACTION_TARGET_TYPES,
  REPLY_PARENT_TYPES,
  STATUS_CATEGORIES,
  SUBSCRIBABLE_TYPES,
  THEMES,
  type PriorityValue,
} from '../../shared/constants';
import type { Permission } from '../../shared/permissions';
import type { FieldChange } from '../../shared/schemas/core';
import { newId } from '../lib/ids';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const idColumn = () => text('id').primaryKey().$defaultFn(newId);
const createdAtColumn = () =>
  timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date());
const updatedAtColumn = () =>
  timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// =============================================================================================
// Better Auth tables — generated with the Better Auth CLI (username + emailOTP plugins, additional
// user field `theme`). Keep in sync with the auth config in server/auth/auth.ts:
//   user.additionalFields.theme = { type: ['system','light','dark'], required: true,
//                                   defaultValue: 'system', input: false }
// =============================================================================================

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
  username: text('username').unique(),
  displayUsername: text('display_username'),
  theme: text('theme', { enum: THEMES }).default('system').notNull(),
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_userId_idx').on(t.userId)],
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_userId_idx').on(t.userId)],
);

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// =============================================================================================
// API keys
// =============================================================================================

export const apiKey = sqliteTable(
  'api_key',
  {
    id: idColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters after `bat_`, kept in clear for display. */
    prefix: text('prefix').notNull(),
    /** SHA-256 hex of the full key. */
    hash: text('hash').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    /**
     * The agent last seen using the key ("Claude", "Codex"), from the MCP client's `initialize`
     * (BAT-6). Shown as "Claude via Ethan's <key>" and used for @claude mentions.
     */
    agentName: text('agent_name'),
    createdAt: createdAtColumn(),
  },
  (t) => [uniqueIndex('api_key_hash_unique').on(t.hash), index('api_key_user_idx').on(t.userId)],
);

/** Soft-delete columns shared by teams, projects, issues, tasks, replies and attachments. */
const softDeleteColumns = () => ({
  deletedAt: timestamp('deleted_at'),
  deletedById: text('deleted_by_id').references(() => user.id, { onDelete: 'set null' }),
  deletedViaKeyId: text('deleted_via_key_id').references(() => apiKey.id, {
    onDelete: 'set null',
  }),
});

// =============================================================================================
// Teams, members, roles, invites
// =============================================================================================

export const team = sqliteTable(
  'team',
  {
    id: idColumn(),
    name: text('name').notNull(),
    /** Lowercase; unique among non-deleted teams. */
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    /** Emoji. */
    icon: text('icon'),
    color: text('color').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ...softDeleteColumns(),
  },
  (t) => [
    uniqueIndex('team_slug_active_unique')
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('team_owner_idx').on(t.ownerId),
    index('team_deleted_by_idx').on(t.deletedById),
    index('team_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

export const teamMember = sqliteTable(
  'team_member',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_member_user_idx').on(t.userId),
  ],
);

export const role = sqliteTable(
  'role',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    /** Higher ranks higher; `@everyone` is always 0. */
    position: integer('position').notNull(),
    permissions: text('permissions', { mode: 'json' })
      .$type<Permission[]>()
      .notNull()
      .default(sql`'[]'`),
    mentionable: bool('mentionable').notNull().default(false),
    isEveryone: bool('is_everyone').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex('role_team_slug_unique').on(t.teamId, t.slug),
    uniqueIndex('role_team_everyone_unique')
      .on(t.teamId)
      .where(sql`${t.isEveryone} = 1`),
  ],
);

export const memberRole = sqliteTable(
  'member_role',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    foreignKey({
      name: 'member_role_member_fk',
      columns: [t.teamId, t.userId],
      foreignColumns: [teamMember.teamId, teamMember.userId],
    }).onDelete('cascade'),
    index('member_role_role_idx').on(t.roleId),
    index('member_role_member_idx').on(t.teamId, t.userId),
  ],
);

export const invite = sqliteTable(
  'invite',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    /** 10 chars base62. */
    code: text('code').notNull(),
    createdById: text('created_by_id').references(() => user.id, { onDelete: 'set null' }),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex('invite_code_unique').on(t.code),
    index('invite_team_idx').on(t.teamId),
    index('invite_created_by_idx').on(t.createdById),
  ],
);

// =============================================================================================
// Projects, statuses, labels
// =============================================================================================

export const project = sqliteTable(
  'project',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `[A-Z][A-Z0-9]{1,5}`; unique per team among non-deleted projects. */
    key: text('key').notNull(),
    description: text('description').notNull().default(''),
    /** Markdown. */
    readme: text('readme').notNull().default(''),
    icon: text('icon'),
    color: text('color').notNull(),
    /** Last issue number handed out. */
    issueSeq: integer('issue_seq').notNull().default(0),
    /** Last task number handed out. */
    taskSeq: integer('task_seq').notNull().default(0),
    createdById: text('created_by_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ...softDeleteColumns(),
  },
  (t) => [
    uniqueIndex('project_team_key_active_unique')
      .on(t.teamId, t.key)
      .where(sql`${t.deletedAt} is null`),
    index('project_team_idx').on(t.teamId),
    index('project_created_by_idx').on(t.createdById),
    index('project_deleted_by_idx').on(t.deletedById),
    index('project_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

/** Previous keys of a project, so old refs (`OLD-12`) keep resolving after a key change. */
export const projectKeyAlias = sqliteTable(
  'project_key_alias',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.key] }),
    index('project_key_alias_team_key_idx').on(t.teamId, t.key),
  ],
);

export const status = sqliteTable(
  'status',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    category: text('category', { enum: STATUS_CATEGORIES }).notNull(),
    /** Column order, ascending. */
    position: integer('position').notNull(),
    isDefault: bool('is_default').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex('status_project_name_unique').on(t.projectId, t.name),
    uniqueIndex('status_project_default_unique')
      .on(t.projectId)
      .where(sql`${t.isDefault} = 1`),
  ],
);

export const label = sqliteTable(
  'label',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    description: text('description').notNull().default(''),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex('label_project_name_unique').on(t.projectId, t.name)],
);

// =============================================================================================
// Issues
// =============================================================================================

export const issue = sqliteTable(
  'issue',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Markdown. */
    body: text('body').notNull().default(''),
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    resolved: bool('resolved').notNull().default(false),
    resolvedAt: timestamp('resolved_at'),
    resolvedById: text('resolved_by_id').references(() => user.id, { onDelete: 'set null' }),
    replyCount: integer('reply_count').notNull().default(0),
    lastActivityAt: timestamp('last_activity_at')
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    editedAt: timestamp('edited_at'),
    ...softDeleteColumns(),
  },
  (t) => [
    uniqueIndex('issue_project_number_unique').on(t.projectId, t.number),
    index('issue_project_activity_idx').on(t.projectId, t.lastActivityAt),
    index('issue_team_idx').on(t.teamId),
    index('issue_author_idx').on(t.authorId),
    index('issue_via_key_idx').on(t.viaKeyId),
    index('issue_resolved_by_idx').on(t.resolvedById),
    index('issue_deleted_by_idx').on(t.deletedById),
    index('issue_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

export const issueLabel = sqliteTable(
  'issue_label',
  {
    issueId: text('issue_id')
      .notNull()
      .references(() => issue.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => label.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    index('issue_label_label_idx').on(t.labelId),
  ],
);

// =============================================================================================
// Tasks
// =============================================================================================

export const task = sqliteTable(
  'task',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** Markdown. */
    description: text('description').notNull().default(''),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'restrict' }),
    /** 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
    priority: integer('priority').$type<PriorityValue>().notNull().default(0),
    /** `YYYY-MM-DD`. */
    dueDate: text('due_date'),
    /** Fractional-index key, ordered within the status column. */
    position: text('position').notNull(),
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    claimedById: text('claimed_by_id').references(() => user.id, { onDelete: 'set null' }),
    claimedViaKeyId: text('claimed_via_key_id').references(() => apiKey.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp('claimed_at'),
    claimExpiresAt: timestamp('claim_expires_at'),
    /** Set when the task enters a `done` status, cleared when it leaves. */
    completedAt: timestamp('completed_at'),
    replyCount: integer('reply_count').notNull().default(0),
    lastActivityAt: timestamp('last_activity_at')
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    editedAt: timestamp('edited_at'),
    ...softDeleteColumns(),
  },
  (t) => [
    uniqueIndex('task_project_number_unique').on(t.projectId, t.number),
    index('task_status_position_idx').on(t.statusId, t.position),
    index('task_team_idx').on(t.teamId),
    index('task_author_idx').on(t.authorId),
    index('task_via_key_idx').on(t.viaKeyId),
    index('task_claimed_by_idx').on(t.claimedById),
    index('task_claimed_via_key_idx').on(t.claimedViaKeyId),
    index('task_claim_expires_idx').on(t.claimExpiresAt),
    index('task_deleted_by_idx').on(t.deletedById),
    index('task_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

export const taskLabel = sqliteTable(
  'task_label',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    labelId: text('label_id')
      .notNull()
      .references(() => label.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    index('task_label_label_idx').on(t.labelId),
  ],
);

export const taskAssigneeUser = sqliteTable(
  'task_assignee_user',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    index('task_assignee_user_user_idx').on(t.userId),
  ],
);

export const taskAssigneeRole = sqliteTable(
  'task_assignee_role',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.roleId] }),
    index('task_assignee_role_role_idx').on(t.roleId),
  ],
);

export const taskIssueLink = sqliteTable(
  'task_issue_link',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    issueId: text('issue_id')
      .notNull()
      .references(() => issue.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ISSUE_LINK_KINDS }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.issueId] }),
    index('task_issue_link_issue_idx').on(t.issueId),
  ],
);

/** `taskId` is blocked by `blockedByTaskId` (same project; cycles rejected by the service). */
export const taskDependency = sqliteTable(
  'task_dependency',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    blockedByTaskId: text('blocked_by_task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.blockedByTaskId] }),
    index('task_dependency_blocked_by_idx').on(t.blockedByTaskId),
    check('task_dependency_not_self', sql`${t.taskId} <> ${t.blockedByTaskId}`),
  ],
);

// =============================================================================================
// Replies, attachments, subscriptions, notifications
// =============================================================================================

export const reply = sqliteTable(
  'reply',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    parentType: text('parent_type', { enum: REPLY_PARENT_TYPES }).notNull(),
    parentId: text('parent_id').notNull(),
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    /** Markdown. */
    body: text('body').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    editedAt: timestamp('edited_at'),
    ...softDeleteColumns(),
  },
  (t) => [
    index('reply_parent_idx').on(t.parentType, t.parentId, t.createdAt),
    index('reply_team_idx').on(t.teamId),
    index('reply_project_idx').on(t.projectId),
    index('reply_author_idx').on(t.authorId),
    index('reply_via_key_idx').on(t.viaKeyId),
    index('reply_deleted_by_idx').on(t.deletedById),
    index('reply_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

export const attachment = sqliteTable(
  'attachment',
  {
    id: idColumn(),
    /** Null only for `user_avatar` uploads, which belong to no team. */
    teamId: text('team_id').references(() => team.id, { onDelete: 'cascade' }),
    uploaderId: text('uploader_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    parentType: text('parent_type', { enum: ATTACHMENT_PARENT_TYPES }).notNull(),
    /** Null while `pending` (uploaded, not yet attached). */
    parentId: text('parent_id'),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Path relative to DATA_DIR/uploads. */
    storagePath: text('storage_path').notNull(),
    createdAt: createdAtColumn(),
    ...softDeleteColumns(),
  },
  (t) => [
    index('attachment_parent_idx').on(t.parentType, t.parentId),
    index('attachment_team_idx').on(t.teamId),
    index('attachment_uploader_idx').on(t.uploaderId),
    index('attachment_via_key_idx').on(t.viaKeyId),
    index('attachment_deleted_by_idx').on(t.deletedById),
    index('attachment_deleted_via_key_idx').on(t.deletedViaKeyId),
  ],
);

/** Reply-notification subscriptions. `subscribed = false` records an explicit unsubscribe. */
export const subscription = sqliteTable(
  'subscription',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    entityType: text('entity_type', { enum: SUBSCRIBABLE_TYPES }).notNull(),
    entityId: text('entity_id').notNull(),
    subscribed: bool('subscribed').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.entityType, t.entityId] }),
    index('subscription_entity_idx').on(t.entityType, t.entityId),
  ],
);

export const notification = sqliteTable(
  'notification',
  {
    id: idColumn(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    type: text('type', { enum: NOTIFICATION_TYPES }).notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyName: text('via_key_name'),
    /** The key's agent at the time ("Claude"), when the action came through one. */
    viaAgentName: text('via_agent_name'),
    title: text('title').notNull(),
    snippet: text('snippet').notNull().default(''),
    /** Relative app URL. */
    url: text('url').notNull(),
    readAt: timestamp('read_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('notification_user_created_idx').on(t.userId, t.createdAt),
    index('notification_user_read_idx').on(t.userId, t.readAt),
    index('notification_team_idx').on(t.teamId),
    index('notification_actor_idx').on(t.actorId),
  ],
);

/**
 * An @agent mention waiting for its agent (BAT-6): a reply naming the agent of an API key
 * (`@claude`) on a task or issue that key replied to or created. `wait_for_mentions` hands it
 * to the agent once and sets `deliveredAt`.
 */
export const agentMention = sqliteTable(
  'agent_mention',
  {
    id: idColumn(),
    keyId: text('key_id')
      .notNull()
      .references(() => apiKey.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    replyId: text('reply_id')
      .notNull()
      .references(() => reply.id, { onDelete: 'cascade' }),
    parentType: text('parent_type', { enum: ['issue', 'task'] }).notNull(),
    parentId: text('parent_id').notNull(),
    deliveredAt: timestamp('delivered_at'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('agent_mention_key_idx').on(t.keyId, t.deliveredAt),
    uniqueIndex('agent_mention_key_reply_unique').on(t.keyId, t.replyId),
  ],
);

/**
 * An emoji reaction (BAT-14): one row per (target, person, emoji). Targets are referenced by type
 * and id without a foreign key (like replies' parents); the trash purge removes orphans.
 */
export const reaction = sqliteTable(
  'reaction',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    targetType: text('target_type', { enum: REACTION_TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    emoji: text('emoji').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex('reaction_target_user_emoji_unique').on(
      t.targetType,
      t.targetId,
      t.userId,
      t.emoji,
    ),
    index('reaction_team_idx').on(t.teamId),
    index('reaction_user_idx').on(t.userId),
    index('reaction_via_key_idx').on(t.viaKeyId),
  ],
);

// =============================================================================================
// Audit log (append-only; no foreign keys by design)
// =============================================================================================

export const activity = sqliteTable(
  'activity',
  {
    id: idColumn(),
    /** Null for account-level entries (the per-user security log). */
    teamId: text('team_id'),
    projectId: text('project_id'),
    /** Null for system actions. */
    actorId: text('actor_id'),
    source: text('source', { enum: ACTOR_SOURCES }).notNull(),
    viaKeyId: text('via_key_id'),
    /** Snapshot of the key name at the time of the action. */
    viaKeyName: text('via_key_name'),
    entityType: text('entity_type', { enum: ACTIVITY_ENTITY_TYPES }).notNull(),
    entityId: text('entity_id').notNull(),
    /** e.g. `task.created`, `task.status_changed`, `role.permissions_changed`. */
    action: text('action').notNull(),
    changes: text('changes', { mode: 'json' })
      .$type<Record<string, FieldChange>>()
      .notNull()
      .default(sql`'{}'`),
    meta: text('meta', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('activity_team_created_idx').on(t.teamId, t.createdAt),
    index('activity_entity_created_idx').on(t.entityType, t.entityId, t.createdAt),
    index('activity_actor_created_idx').on(t.actorId, t.createdAt),
  ],
);

/** What an `activity_facet` row lists: one of the audit log's filter menus. */
export const ACTIVITY_FACET_KINDS = [
  'actor',
  'source',
  'entity_type',
  'action',
  'project',
  'key',
] as const;
export type ActivityFacetKind = (typeof ACTIVITY_FACET_KINDS)[number];

/**
 * The distinct values of a team's audit log (actors, sources, entity types, actions, projects and
 * API keys) for its filter menus, kept by `recordActivity` in the same transaction as each row, so
 * reading them never scans the (append-only, unbounded) log. Key rows also carry the key's latest
 * name snapshot, owner and last use. No foreign keys, like `activity`.
 */
export const activityFacet = sqliteTable(
  'activity_facet',
  {
    teamId: text('team_id').notNull(),
    kind: text('kind', { enum: ACTIVITY_FACET_KINDS }).notNull(),
    value: text('value').notNull(),
    /** `key` rows: the key name as last recorded. */
    keyName: text('key_name'),
    /** `key` rows: the key's owner (the actor of its latest row). */
    actorId: text('actor_id'),
    /** `key` rows: when the key was last used in the team. */
    lastAt: timestamp('last_at'),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.kind, t.value] })],
);

// =============================================================================================
// Relations (for db.query.* relational queries)
// =============================================================================================

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  apiKeys: many(apiKey),
  memberships: many(teamMember),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const apiKeyRelations = relations(apiKey, ({ one }) => ({
  user: one(user, { fields: [apiKey.userId], references: [user.id] }),
}));

export const teamRelations = relations(team, ({ one, many }) => ({
  owner: one(user, { fields: [team.ownerId], references: [user.id] }),
  members: many(teamMember),
  roles: many(role),
  invites: many(invite),
  projects: many(project),
}));

export const teamMemberRelations = relations(teamMember, ({ one, many }) => ({
  team: one(team, { fields: [teamMember.teamId], references: [team.id] }),
  user: one(user, { fields: [teamMember.userId], references: [user.id] }),
  memberRoles: many(memberRole),
}));

export const roleRelations = relations(role, ({ one, many }) => ({
  team: one(team, { fields: [role.teamId], references: [team.id] }),
  memberRoles: many(memberRole),
}));

export const memberRoleRelations = relations(memberRole, ({ one }) => ({
  role: one(role, { fields: [memberRole.roleId], references: [role.id] }),
  member: one(teamMember, {
    fields: [memberRole.teamId, memberRole.userId],
    references: [teamMember.teamId, teamMember.userId],
  }),
}));

export const inviteRelations = relations(invite, ({ one }) => ({
  team: one(team, { fields: [invite.teamId], references: [team.id] }),
  createdBy: one(user, { fields: [invite.createdById], references: [user.id] }),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  team: one(team, { fields: [project.teamId], references: [team.id] }),
  statuses: many(status),
  labels: many(label),
  issues: many(issue),
  tasks: many(task),
  keyAliases: many(projectKeyAlias),
}));

export const projectKeyAliasRelations = relations(projectKeyAlias, ({ one }) => ({
  project: one(project, { fields: [projectKeyAlias.projectId], references: [project.id] }),
}));

export const statusRelations = relations(status, ({ one, many }) => ({
  project: one(project, { fields: [status.projectId], references: [project.id] }),
  tasks: many(task),
}));

export const labelRelations = relations(label, ({ one }) => ({
  project: one(project, { fields: [label.projectId], references: [project.id] }),
}));

export const issueRelations = relations(issue, ({ one, many }) => ({
  project: one(project, { fields: [issue.projectId], references: [project.id] }),
  author: one(user, { fields: [issue.authorId], references: [user.id] }),
  viaKey: one(apiKey, { fields: [issue.viaKeyId], references: [apiKey.id] }),
  labels: many(issueLabel),
  taskLinks: many(taskIssueLink),
}));

export const issueLabelRelations = relations(issueLabel, ({ one }) => ({
  issue: one(issue, { fields: [issueLabel.issueId], references: [issue.id] }),
  label: one(label, { fields: [issueLabel.labelId], references: [label.id] }),
}));

export const taskRelations = relations(task, ({ one, many }) => ({
  project: one(project, { fields: [task.projectId], references: [project.id] }),
  status: one(status, { fields: [task.statusId], references: [status.id] }),
  author: one(user, { fields: [task.authorId], references: [user.id] }),
  viaKey: one(apiKey, { fields: [task.viaKeyId], references: [apiKey.id] }),
  labels: many(taskLabel),
  assigneeUsers: many(taskAssigneeUser),
  assigneeRoles: many(taskAssigneeRole),
  issueLinks: many(taskIssueLink),
  blockedBy: many(taskDependency, { relationName: 'blocked' }),
  blocking: many(taskDependency, { relationName: 'blocker' }),
}));

export const taskLabelRelations = relations(taskLabel, ({ one }) => ({
  task: one(task, { fields: [taskLabel.taskId], references: [task.id] }),
  label: one(label, { fields: [taskLabel.labelId], references: [label.id] }),
}));

export const taskAssigneeUserRelations = relations(taskAssigneeUser, ({ one }) => ({
  task: one(task, { fields: [taskAssigneeUser.taskId], references: [task.id] }),
  user: one(user, { fields: [taskAssigneeUser.userId], references: [user.id] }),
}));

export const taskAssigneeRoleRelations = relations(taskAssigneeRole, ({ one }) => ({
  task: one(task, { fields: [taskAssigneeRole.taskId], references: [task.id] }),
  role: one(role, { fields: [taskAssigneeRole.roleId], references: [role.id] }),
}));

export const taskIssueLinkRelations = relations(taskIssueLink, ({ one }) => ({
  task: one(task, { fields: [taskIssueLink.taskId], references: [task.id] }),
  issue: one(issue, { fields: [taskIssueLink.issueId], references: [issue.id] }),
}));

export const taskDependencyRelations = relations(taskDependency, ({ one }) => ({
  task: one(task, {
    fields: [taskDependency.taskId],
    references: [task.id],
    relationName: 'blocked',
  }),
  blockedBy: one(task, {
    fields: [taskDependency.blockedByTaskId],
    references: [task.id],
    relationName: 'blocker',
  }),
}));

export const replyRelations = relations(reply, ({ one }) => ({
  author: one(user, { fields: [reply.authorId], references: [user.id] }),
  viaKey: one(apiKey, { fields: [reply.viaKeyId], references: [apiKey.id] }),
}));

export const attachmentRelations = relations(attachment, ({ one }) => ({
  uploader: one(user, { fields: [attachment.uploaderId], references: [user.id] }),
  viaKey: one(apiKey, { fields: [attachment.viaKeyId], references: [apiKey.id] }),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
  actor: one(user, { fields: [notification.actorId], references: [user.id] }),
}));
