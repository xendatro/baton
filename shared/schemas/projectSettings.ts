import { z } from 'zod';
import { AGENT_NOTIFICATION_LEVELS, type NotificationType } from '../constants';
import { chainSchema, defaultMappingSchema } from './agentRunner';

/**
 * Your settings for one project (BAT-29), like Discord's per-server settings: that project's
 * notifications and your agent's default model there. Personal: anyone who can see the project
 * has their own. Everything left unset falls back to the account's settings.
 */

/** How much of a project reaches your inbox. */
export const PROJECT_NOTIFY_LEVELS = ['all', 'mentions', 'none'] as const;
export type ProjectNotifyLevel = (typeof PROJECT_NOTIFY_LEVELS)[number];

export const PROJECT_NOTIFY_LEVEL_LABELS: Record<ProjectNotifyLevel, string> = {
  all: 'All activity',
  mentions: 'Mentions & assignments only',
  none: 'Nothing',
};

/**
 * Per-kind switches under "All activity". Mentions of you and assignments always come through
 * (unless the level is "Nothing"), and so do your agent's sign-off requests.
 */
export const PROJECT_NOTIFY_KINDS = ['replies', 'roleMentions', 'issueStatus', 'stages'] as const;
export type ProjectNotifyKind = (typeof PROJECT_NOTIFY_KINDS)[number];

export const PROJECT_NOTIFY_KIND_TYPES: Record<ProjectNotifyKind, readonly NotificationType[]> = {
  replies: ['reply'],
  roleMentions: ['role_mention'],
  issueStatus: ['issue_resolved', 'issue_reopened'],
  stages: ['task_done', 'stage_entered'],
};

export const PROJECT_NOTIFY_KIND_LABELS: Record<
  ProjectNotifyKind,
  { label: string; hint: string }
> = {
  replies: { label: 'Replies', hint: 'New replies on tasks and issues you follow' },
  roleMentions: { label: 'Role and @everyone mentions', hint: 'Mentions of a role you have' },
  issueStatus: { label: 'Issues resolved or reopened', hint: 'Issues you follow' },
  stages: { label: 'Pipeline stages', hint: 'A task reached a stage that notifies you' },
};

export const projectNotifyKindsSchema = z.object({
  replies: z.boolean().default(true),
  roleMentions: z.boolean().default(true),
  issueStatus: z.boolean().default(true),
  stages: z.boolean().default(true),
});
export type ProjectNotifyKinds = z.infer<typeof projectNotifyKindsSchema>;

export const projectNotificationsSchema = z.object({
  level: z.enum(PROJECT_NOTIFY_LEVELS),
  kinds: projectNotifyKindsSchema.default({
    replies: true,
    roleMentions: true,
    issueStatus: true,
    stages: true,
  }),
});
export type ProjectNotifications = z.infer<typeof projectNotificationsSchema>;

/** The account's notifications, which a project without an override uses: everything. */
export const ACCOUNT_NOTIFICATIONS: ProjectNotifications = {
  level: 'all',
  kinds: { replies: true, roleMentions: true, issueStatus: true, stages: true },
};

const agentLevelSchema = z.enum(AGENT_NOTIFICATION_LEVELS);

/** Where "Use my defaults" in a project leads: your team's override, or your account. */
export const NOTIFICATION_DEFAULT_SOURCES = ['team', 'account'] as const;

/** `GET /api/projects/:projectId/my-settings`. */
export const myProjectSettingsSchema = z.object({
  projectId: z.string(),
  /** Null: "Use my defaults" (the account's notifications). */
  notifications: projectNotificationsSchema.nullable(),
  /** Your agent's activity in this project; null: the account's level. */
  agentNotifications: agentLevelSchema.nullable(),
  /** Your agent's default chain in this project; empty: your account default. */
  models: z.object({ chain: chainSchema }),
  /** What "Use my defaults" means for each part. */
  defaults: z.object({
    notifications: projectNotificationsSchema,
    agentNotifications: agentLevelSchema,
    models: defaultMappingSchema,
  }),
  /**
   * Where each notification default comes from (BAT-34): the team's override, or the account's
   * settings. Absent from older servers: the account's.
   */
  inherited: z
    .object({
      notifications: z.enum(NOTIFICATION_DEFAULT_SOURCES),
      agentNotifications: z.enum(NOTIFICATION_DEFAULT_SOURCES),
    })
    .optional(),
});
export type MyProjectSettings = z.infer<typeof myProjectSettingsSchema>;

/** `PUT /api/projects/:projectId/my-settings`: the parts given are replaced (null = defaults). */
export const updateMyProjectSettingsInputSchema = z.object({
  notifications: projectNotificationsSchema.nullable().optional(),
  agentNotifications: agentLevelSchema.nullable().optional(),
  /** This project's default chain; an empty chain uses your account default. */
  models: z.object({ chain: chainSchema }).optional(),
});
export type UpdateMyProjectSettingsInput = z.input<typeof updateMyProjectSettingsInputSchema>;

// ---------------------------------------------------------------------------------------------
// Your settings for one team (BAT-34): /api/teams/:teamId/my-settings
// ---------------------------------------------------------------------------------------------

/**
 * `GET /api/teams/:teamId/my-settings`: your notification overrides for the whole team. A project
 * override wins over these; whatever is unset here uses the account's settings.
 */
export const myTeamSettingsSchema = z.object({
  teamId: z.string(),
  /** Null: "Use my defaults" (the account's notifications). */
  notifications: projectNotificationsSchema.nullable(),
  /** Your agent's activity in this team; null: the account's level. */
  agentNotifications: agentLevelSchema.nullable(),
  /** What "Use my defaults" means (the account's settings). */
  defaults: z.object({
    notifications: projectNotificationsSchema,
    agentNotifications: agentLevelSchema,
  }),
});
export type MyTeamSettings = z.infer<typeof myTeamSettingsSchema>;

/** `PUT /api/teams/:teamId/my-settings`: the parts given are replaced (null = defaults). */
export const updateMyTeamSettingsInputSchema = z.object({
  notifications: projectNotificationsSchema.nullable().optional(),
  agentNotifications: agentLevelSchema.nullable().optional(),
});
export type UpdateMyTeamSettingsInput = z.input<typeof updateMyTeamSettingsInputSchema>;
