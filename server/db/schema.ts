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
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ACTIVITY_ENTITY_TYPES,
  AGENT_JOB_KINDS,
  AGENT_JOB_STATUSES,
  AGENT_JOB_TARGET_TYPES,
  AGENT_ACTION_STATUSES,
  AGENT_ACTIONS,
  AGENT_NOTIFICATION_LEVELS,
  ACTOR_SOURCES,
  ATTACHMENT_PARENT_TYPES,
  ISSUE_LINK_KINDS,
  NOTIFICATION_TYPES,
  REACTION_TARGET_TYPES,
  REPLY_PARENT_TYPES,
  STATUS_CATEGORIES,
  STATUS_ICONS,
  SUBSCRIBABLE_TYPES,
  THEMES,
  USER_KINDS,
  type PriorityValue,
} from '../../shared/constants';
import type { Permission } from '../../shared/permissions';
import type { AgentActionPayload } from '../../shared/schemas/agentActions';
import type { PrincipalRule } from '../../shared/principals';
import type {
  ApprovalDecision,
  ApprovalsRule,
  ExitCriterion,
  Handoff,
  MoveBy,
  OnEnterRules,
} from '../../shared/schemas/pipelines';
import type { ReadmeSource } from '../../shared/schemas/github';
import type {
  DefaultMapping,
  HarnessInfo,
  JobSources,
  ProjectMapping,
} from '../../shared/schemas/agentRunner';
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
  /** `agent`: the AI member of `agentOwnerId` (docs/design/agents-and-pipelines.md §1). */
  kind: text('kind', { enum: USER_KINDS }).default('human').notNull(),
  /** For agents: the human who owns it (one agent per human). */
  agentOwnerId: text('agent_owner_id').unique(),
  /** Humans: when they paused their agent (its writes are refused while set). */
  agentPausedAt: integer('agent_paused_at', { mode: 'timestamp_ms' }),
  /** Humans: how much of their agent's activity reaches their inbox. */
  agentNotifications: text('agent_notifications', { enum: AGENT_NOTIFICATION_LEVELS })
    .default('needs_me')
    .notNull(),
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
    /** "Pause all agents": agent members' writes in the team are refused while set. */
    agentsPausedAt: timestamp('agents_paused_at'),
    /**
     * "Agents need human sign-off for destructive actions" (design §6): an agent member's
     * destructive operation becomes an `agent_action_request` its owner approves or denies.
     */
    agentSignoff: bool('agent_signoff').notNull().default(true),
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
    /** Members with the role are listed in its own section of the Members tab (design §7). */
    hoist: bool('hoist').notNull().default(false),
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
// GitHub
// =============================================================================================

/** A GitHub App installation a team connected (repository READMEs). */
export const githubInstallation = sqliteTable(
  'github_installation',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    /** GitHub's installation id. */
    installationId: integer('installation_id').notNull(),
    accountLogin: text('account_login').notNull(),
    /** `User` or `Organization`. */
    accountType: text('account_type').notNull(),
    createdById: text('created_by_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex('github_installation_team_unique').on(t.teamId, t.installationId),
    index('github_installation_created_by_idx').on(t.createdById),
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
    /** The project's code repository (optional): the desktop app checks mapped folders against it. */
    repoUrl: text('repo_url'),
    /** Show a GitHub file or folder instead of `readme` (null: `readme`). */
    readmeSource: text('readme_source', { mode: 'json' }).$type<ReadmeSource>(),
    icon: text('icon'),
    color: text('color').notNull(),
    /** Last issue number handed out. */
    issueSeq: integer('issue_seq').notNull().default(0),
    /** Last task number handed out. */
    taskSeq: integer('task_seq').notNull().default(0),
    createdById: text('created_by_id').references(() => user.id, { onDelete: 'set null' }),
    /** "Pause all agents" of the project: agent members' writes in it are refused while set. */
    agentsPausedAt: timestamp('agents_paused_at'),
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

/**
 * Project roles (docs/design/agents-and-pipelines.md §3): per-project groups of members (people
 * or agents). They carry no permissions themselves; overrides for them do.
 */
export const projectRole = sqliteTable(
  'project_role',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    /** Higher ranks higher. */
    position: integer('position').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [uniqueIndex('project_role_project_slug_unique').on(t.projectId, t.slug)],
);

export const projectRoleMember = sqliteTable(
  'project_role_member',
  {
    projectRoleId: text('project_role_id')
      .notNull()
      .references(() => projectRole.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.projectRoleId, t.userId] }),
    index('project_role_member_user_idx').on(t.userId),
  ],
);

export const PERMISSION_OVERRIDE_SUBJECTS = ['team_role', 'project_role', 'user'] as const;
export type PermissionOverrideSubject = (typeof PERMISSION_OVERRIDE_SUBJECTS)[number];

/**
 * A pipeline of a project (BAT-25): an ordered set of stages (statuses) with their rules. Every
 * project has one default pipeline (its statuses before BAT-25); more can be added, each with
 * optional who-rules for who sees it, who creates tasks in it and who edits it (null: everyone in
 * the project).
 */
export const pipeline = sqliteTable(
  'pipeline',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    color: text('color'),
    icon: text('icon'),
    position: integer('position').notNull(),
    isDefault: bool('is_default').notNull().default(false),
    viewRule: text('view_rule', { mode: 'json' }).$type<PrincipalRule>(),
    createRule: text('create_rule', { mode: 'json' }).$type<PrincipalRule>(),
    manageRule: text('manage_rule', { mode: 'json' }).$type<PrincipalRule>(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ...softDeleteColumns(),
  },
  (t) => [
    uniqueIndex('pipeline_project_slug_active_unique')
      .on(t.projectId, t.slug)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('pipeline_project_default_unique')
      .on(t.projectId)
      .where(sql`${t.isDefault} = 1`),
    index('pipeline_project_idx').on(t.projectId),
  ],
);

/**
 * Per-project permission overrides of a team role, a project role or a member (project-level
 * permissions only). The subject has no foreign key (three tables); services delete the rows of
 * deleted roles and departed members.
 */
export const projectPermissionOverride = sqliteTable(
  'project_permission_override',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type', { enum: PERMISSION_OVERRIDE_SUBJECTS }).notNull(),
    subjectId: text('subject_id').notNull(),
    allow: text('allow', { mode: 'json' })
      .$type<Permission[]>()
      .notNull()
      .default(sql`'[]'`),
    deny: text('deny', { mode: 'json' })
      .$type<Permission[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex('project_permission_override_subject_unique').on(
      t.projectId,
      t.subjectType,
      t.subjectId,
    ),
    index('project_permission_override_subject_idx').on(t.subjectType, t.subjectId),
  ],
);

export const status = sqliteTable(
  'status',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /**
     * The pipeline it's a stage of (BAT-25). Required: the column is added without a table rebuild
     * (see migration 0017), and triggers refuse nulls.
     */
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => pipeline.id),
    name: text('name').notNull(),
    color: text('color').notNull(),
    /**
     * Legacy (open/done before 2026-09-27): unused. Kept so old databases migrate without
     * rebuilding the table; new rows get 'open'.
     */
    category: text('category', { enum: STATUS_CATEGORIES })
      .notNull()
      .$defaultFn(() => 'open'),
    /** Icon shape, drawn in `color`. */
    icon: text('icon', { enum: STATUS_ICONS }).notNull().default('circle'),
    /** Column order, ascending. */
    position: integer('position').notNull(),
    isDefault: bool('is_default').notNull().default(false),
    // Pipeline rules (docs/design/agents-and-pipelines.md §5); the defaults change nothing.
    /** Markdown: what to do in this stage. */
    instructions: text('instructions').notNull().default(''),
    /** On enter: who gets the task (null: keep the assignees). */
    handoff: text('handoff', { mode: 'json' }).$type<Handoff>(),
    /** On enter: who is notified. */
    notify: text('notify', { mode: 'json' }).$type<PrincipalRule>(),
    /** On enter: resolve fixed issues, release the claim, tell the author (null: none). */
    onEnter: text('on_enter', { mode: 'json' }).$type<Partial<OnEnterRules>>(),
    /** Tasks here still block the tasks waiting on them. */
    blocksDependents: bool('blocks_dependents').notNull().default(true),
    /** `claim_next_task` / `claim_task` may take tasks here. */
    claimable: bool('claimable').notNull().default(true),
    /** To leave forward: each needs evidence. */
    exitCriteria: text('exit_criteria', { mode: 'json' })
      .$type<ExitCriterion[]>()
      .notNull()
      .default(sql`'[]'`),
    /** To leave forward: its assignees and/or claimer may move it out (null: neither). */
    moveBy: text('move_by', { mode: 'json' }).$type<MoveBy>(),
    /** To leave forward: who may move it out (null: whoever may move tasks). */
    moveRule: text('move_rule', { mode: 'json' }).$type<PrincipalRule>(),
    /** To leave forward: approvals needed. */
    approvals: text('approvals', { mode: 'json' }).$type<ApprovalsRule>(),
    autoAdvance: bool('auto_advance').notNull().default(false),
    /** The next stage (null: the next column). */
    nextStatusId: text('next_status_id').references((): AnySQLiteColumn => status.id, {
      onDelete: 'set null',
    }),
    allowSendBack: bool('allow_send_back').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    // Names and the default stage are per pipeline (BAT-25).
    uniqueIndex('status_pipeline_name_unique').on(t.pipelineId, t.name),
    uniqueIndex('status_pipeline_default_unique')
      .on(t.pipelineId)
      .where(sql`${t.isDefault} = 1`),
    index('status_project_idx').on(t.projectId),
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

/** Difficulty levels of a project (BAT-24), easiest first. */
export const difficulty = sqliteTable(
  'difficulty',
  {
    id: idColumn(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    /** Order, easiest first. */
    position: integer('position').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex('difficulty_project_name_unique').on(t.projectId, t.name),
    index('difficulty_project_idx').on(t.projectId),
  ],
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
    /** Difficulty level (BAT-24); null: none. */
    difficultyId: text('difficulty_id').references(() => difficulty.id, { onDelete: 'set null' }),
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
    /**
     * Set when the task enters a stage that doesn't block its dependents (`blocks_dependents` 0),
     * cleared when it enters one that does.
     */
    completedAt: timestamp('completed_at'),
    /**
     * Who may claim it while it waits in a `pool` hand-off stage (design §5); cleared when it is
     * claimed, assigned or leaves the stage.
     */
    poolRule: text('pool_rule', { mode: 'json' }).$type<PrincipalRule>(),
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

/**
 * Assignments belong to a task and a stage: a task's current assignees are its rows for its
 * current status; rows of other statuses are who held it there (history, `stage_holder`, and
 * restored when it returns to that stage).
 */
export const taskAssigneeUser = sqliteTable(
  'task_assignee_user',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.statusId, t.userId] }),
    index('task_assignee_user_user_idx').on(t.userId),
    index('task_assignee_user_status_idx').on(t.statusId),
  ],
);

export const taskAssigneeRole = sqliteTable(
  'task_assignee_role',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.statusId, t.roleId] }),
    index('task_assignee_role_role_idx').on(t.roleId),
    index('task_assignee_role_status_idx').on(t.statusId),
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
// Pipelines (docs/design/agents-and-pipelines.md §5)
// =============================================================================================

/**
 * One visit of a task to a stage: when it entered, who moved it, whom the hand-off assigned, and
 * (once it left) who held it then (`stage_holder` hand-offs and round-robin read these).
 */
export const taskStageEntry = sqliteTable(
  'task_stage_entry',
  {
    id: idColumn(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'cascade' }),
    enteredAt: timestamp('entered_at').notNull(),
    enteredById: text('entered_by_id').references(() => user.id, { onDelete: 'set null' }),
    enteredViaKeyId: text('entered_via_key_id').references(() => apiKey.id, {
      onDelete: 'set null',
    }),
    /** The hand-off mode applied on entry. */
    handoffMode: text('handoff_mode'),
    /** Users the hand-off assigned on entry. */
    assignedUserIds: text('assigned_user_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    leftAt: timestamp('left_at'),
    /** The task's user assignees when it left the stage. */
    holderUserIds: text('holder_user_ids', { mode: 'json' }).$type<string[]>(),
  },
  (t) => [
    index('task_stage_entry_task_idx').on(t.taskId, t.statusId, t.enteredAt),
    index('task_stage_entry_status_idx').on(t.statusId, t.enteredAt),
    index('task_stage_entry_entered_by_idx').on(t.enteredById),
    index('task_stage_entry_via_key_idx').on(t.enteredViaKeyId),
  ],
);

/** Evidence for an exit criterion of a stage; editable only while the task is in that stage. */
export const taskStageEvidence = sqliteTable(
  'task_stage_evidence',
  {
    id: idColumn(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'cascade' }),
    criterionId: text('criterion_id').notNull(),
    text: text('text').notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex('task_stage_evidence_unique').on(t.taskId, t.statusId, t.criterionId),
    index('task_stage_evidence_status_idx').on(t.statusId),
    index('task_stage_evidence_user_idx').on(t.userId),
    index('task_stage_evidence_via_key_idx').on(t.viaKeyId),
  ],
);

/**
 * An Approve / Request changes decision on a task's stage. Only non-dismissed rows of the stage the
 * task is in count; entering a stage dismisses leftovers of an earlier visit.
 */
export const taskApproval = sqliteTable(
  'task_approval',
  {
    id: idColumn(),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    statusId: text('status_id')
      .notNull()
      .references(() => status.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    decision: text('decision').$type<ApprovalDecision>().notNull(),
    comment: text('comment'),
    createdAt: createdAtColumn(),
    dismissedAt: timestamp('dismissed_at'),
  },
  (t) => [
    index('task_approval_task_idx').on(t.taskId, t.statusId),
    index('task_approval_status_idx').on(t.statusId),
    index('task_approval_user_idx').on(t.userId),
    index('task_approval_via_key_idx').on(t.viaKeyId),
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
    /**
     * The reply this one answers (BAT-13), on the same item; null for a top-level comment. Purging
     * a deleted parent from Trash turns its replies into top-level comments.
     */
    parentReplyId: text('parent_reply_id'),
    authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
    viaKeyId: text('via_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    /** Markdown. */
    body: text('body').notNull(),
    /** "No further discussion needed at this time" (the agents' done handshake, design §4). */
    closing: bool('closing').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    editedAt: timestamp('edited_at'),
    ...softDeleteColumns(),
  },
  (t) => [
    index('reply_parent_idx').on(t.parentType, t.parentId, t.createdAt),
    foreignKey({
      name: 'reply_parent_reply_fk',
      columns: [t.parentReplyId],
      foreignColumns: [t.id],
    }).onDelete('set null'),
    index('reply_parent_reply_idx').on(t.parentReplyId),
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
 * Work waiting for an agent member (docs/design/agents-and-pipelines.md §4): a mention, an
 * assignment, a reply in its thread, a pool hand-off, an approval, an action result. Its listener
 * session claims it (`start_listener`) and holds it until it completes or releases it; jobs of a
 * session that disappeared go back to `pending`. Targets are referenced by type and id without a
 * foreign key (like replies' parents).
 */
export const agentJob = sqliteTable(
  'agent_job',
  {
    id: idColumn(),
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: AGENT_JOB_KINDS }).notNull(),
    targetType: text('target_type', { enum: AGENT_JOB_TARGET_TYPES }).notNull(),
    targetId: text('target_id').notNull(),
    /** The reply that caused the job (mentions and thread replies in replies). */
    triggerReplyId: text('trigger_reply_id').references(() => reply.id, { onDelete: 'set null' }),
    /** Extra context from the job's source, e.g. a stage's instructions. */
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    /** Triggered by another agent's closing reply (the done handshake). */
    closing: bool('closing').notNull().default(false),
    /** Who caused it (the mention's, reply's or move's author); null for system sources. */
    triggeredById: text('triggered_by_id').references((): AnySQLiteColumn => user.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: AGENT_JOB_STATUSES }).notNull().default('pending'),
    /**
     * Caused by someone outside the owner's job sources (BAT-24): the desktop app runs it only
     * after the owner's OK ("Waiting for your OK"). Manual listeners still get it.
     */
    needsOk: bool('needs_ok').notNull().default(false),
    /** The listener session holding a claimed job. */
    sessionId: text('session_id').references(() => agentSession.id, { onDelete: 'set null' }),
    createdAt: createdAtColumn(),
    claimedAt: timestamp('claimed_at'),
    completedAt: timestamp('completed_at'),
  },
  (t) => [
    index('agent_job_agent_status_idx').on(t.agentUserId, t.status, t.createdAt),
    index('agent_job_target_idx').on(t.targetType, t.targetId),
    index('agent_job_session_idx').on(t.sessionId),
    index('agent_job_team_idx').on(t.teamId),
    index('agent_job_project_idx').on(t.projectId),
    index('agent_job_trigger_reply_idx').on(t.triggerReplyId),
  ],
);

/**
 * A listener of an agent member (`start_listener`): the key it runs with and the projects it
 * listens to. Seen at every listener call; while it waits it counts as seen. Not seen for 90 s:
 * gone (its claimed jobs are put back), and the agent is offline unless another session lives.
 */
export const agentSession = sqliteTable(
  'agent_session',
  {
    id: idColumn(),
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    keyId: text('key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    projectIds: text('project_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** `runner`: the desktop app on a machine (BAT-24); `listener`: an MCP `start_listener`. */
    kind: text('kind', { enum: ['listener', 'runner'] })
      .notNull()
      .default('listener'),
    /** Runners: the app's stable id for the machine, and its name. */
    machineId: text('machine_id'),
    machineName: text('machine_name'),
    /** Runners: harnesses installed there. */
    harnesses: text('harnesses', { mode: 'json' })
      .$type<HarnessInfo[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Runners: jobs running now (from the last heartbeat). */
    running: integer('running').notNull().default(0),
    startedAt: createdAtColumn(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  (t) => [
    index('agent_session_agent_idx').on(t.agentUserId, t.lastSeenAt),
    index('agent_session_key_idx').on(t.keyId),
  ],
);

/**
 * Agent state of a task's or issue's thread (design §4): when the loop guard tripped (the last
 * replies were all by agents) and when agents agreed nothing more is needed (the done
 * handshake). Either stops jobs from agent replies there until a person replies, which deletes
 * the row.
 */
export const agentThread = sqliteTable(
  'agent_thread',
  {
    parentType: text('parent_type', { enum: REPLY_PARENT_TYPES }).notNull(),
    parentId: text('parent_id').notNull(),
    loopGuardAt: timestamp('loop_guard_at'),
    closedAt: timestamp('closed_at'),
  },
  (t) => [primaryKey({ columns: [t.parentType, t.parentId] })],
);

/**
 * A destructive action an agent member asked for, waiting for its owner's sign-off (design §6).
 * On approval the server runs it again from `payload.input` (as the agent, re-checking its
 * permissions; owner-only actions as the owner) and stores the outcome in `result` / `error`.
 * Pending requests expire after 7 days.
 */
export const agentActionRequest = sqliteTable(
  'agent_action_request',
  {
    id: idColumn(),
    teamId: text('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The agent's owner: the only one who may approve or deny. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    action: text('action', { enum: AGENT_ACTIONS }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<AgentActionPayload>().notNull(),
    /**
     * How the agent asked (`mcp` or `api`) and through which key, for the action's audit row. No
     * foreign key on the key, like `activity.via_key_id`: a snapshot for attribution only.
     */
    source: text('source', { enum: ACTOR_SOURCES }).notNull(),
    viaKeyId: text('via_key_id'),
    viaKeyName: text('via_key_name'),
    viaAgentName: text('via_agent_name'),
    status: text('status', { enum: AGENT_ACTION_STATUSES }).notNull().default('pending'),
    /** What the action returned (approved), as JSON. */
    result: text('result', { mode: 'json' }).$type<unknown>(),
    /** Why the approved action failed: `{ code, message }`. */
    error: text('error', { mode: 'json' }).$type<{ code: string; message: string }>(),
    createdAt: createdAtColumn(),
    decidedAt: timestamp('decided_at'),
    decidedById: text('decided_by_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('agent_action_request_owner_idx').on(t.ownerId, t.createdAt),
    index('agent_action_request_status_idx').on(t.status, t.createdAt),
    index('agent_action_request_agent_idx').on(t.agentUserId),
    index('agent_action_request_team_idx').on(t.teamId),
    index('agent_action_request_project_idx').on(t.projectId),
    index('agent_action_request_key_idx').on(t.viaKeyId),
    index('agent_action_request_decided_by_idx').on(t.decidedById),
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
    /**
     * Snapshot of the key's agent ("Claude") at the time of the action (BAT-10). Null for rows
     * written before it existed; readers fall back to the key's current agent.
     */
    viaAgentName: text('via_agent_name'),
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

// =============================================================================================
// Automatic agents (BAT-24): settings, model mappings, harness sessions, usage
// =============================================================================================

/** A person's automatic-agent settings: whose jobs run, and the default model mapping. */
export const agentSettings = sqliteTable('agent_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  jobSources: text('job_sources', { mode: 'json' }).$type<JobSources>(),
  defaultMapping: text('default_mapping', { mode: 'json' }).$type<DefaultMapping>(),
  updatedAt: updatedAtColumn(),
});

/** A person's model mapping for one project: difficulty level id → chain. */
export const agentProjectMapping = sqliteTable(
  'agent_project_mapping',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    levels: text('levels', { mode: 'json' })
      .$type<ProjectMapping['levels']>()
      .notNull()
      .default(sql`'{}'`),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    index('agent_project_mapping_project_idx').on(t.projectId),
  ],
);

/** The harness session a task ran in on a machine, so the next job there resumes it. */
export const agentHarnessSession = sqliteTable(
  'agent_harness_session',
  {
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    machineId: text('machine_id').notNull(),
    harness: text('harness').notNull(),
    sessionId: text('session_id').notNull(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.agentUserId, t.taskId, t.machineId, t.harness] }),
    index('agent_harness_session_task_idx').on(t.taskId),
  ],
);

/** What one harness run of a job cost (reported by the desktop app). */
export const agentUsage = sqliteTable(
  'agent_usage',
  {
    id: idColumn(),
    /** The human whose agent ran it. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    agentUserId: text('agent_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => agentJob.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => project.id, { onDelete: 'set null' }),
    /** The task's level when it ran (name, kept if the level is renamed or deleted). */
    difficulty: text('difficulty'),
    harness: text('harness').notNull(),
    model: text('model').notNull().default(''),
    effort: text('effort').notNull().default(''),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    /** Micro-dollars (integer). */
    costMicros: integer('cost_micros').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    outcome: text('outcome').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('agent_usage_owner_created_idx').on(t.ownerId, t.createdAt),
    index('agent_usage_job_idx').on(t.jobId),
    index('agent_usage_agent_idx').on(t.agentUserId),
    index('agent_usage_project_idx').on(t.projectId),
  ],
);
