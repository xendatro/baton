import { z } from 'zod';
import { AGENT_NOTIFICATION_LEVELS, type NotificationType } from '../constants';
import { chainSchema, defaultMappingSchema } from './agentRunner';
import { idSchema } from './common';

/**
 * Your settings for one project (BAT-29), like Discord's per-server settings: that project's
 * notifications and your models by difficulty there. Personal: anyone who can see the project
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

/** `GET /api/projects/:projectId/my-settings`. */
export const myProjectSettingsSchema = z.object({
  projectId: z.string(),
  /** Null: "Use my defaults" (the account's notifications). */
  notifications: projectNotificationsSchema.nullable(),
  /** Your agent's activity in this project; null: the account's level. */
  agentNotifications: agentLevelSchema.nullable(),
  /** Your models by this project's difficulty level ids; a level left out uses your defaults. */
  models: z.object({ levels: z.record(z.string(), chainSchema) }),
  /** What "Use my defaults" means for each part. */
  defaults: z.object({
    notifications: projectNotificationsSchema,
    agentNotifications: agentLevelSchema,
    models: defaultMappingSchema,
  }),
});
export type MyProjectSettings = z.infer<typeof myProjectSettingsSchema>;

/** `PUT /api/projects/:projectId/my-settings`: the parts given are replaced (null = defaults). */
export const updateMyProjectSettingsInputSchema = z.object({
  notifications: projectNotificationsSchema.nullable().optional(),
  agentNotifications: agentLevelSchema.nullable().optional(),
  /** Level id → chain; an empty chain (or a level left out) uses your defaults. */
  models: z.object({ levels: z.record(idSchema, chainSchema) }).optional(),
});
export type UpdateMyProjectSettingsInput = z.input<typeof updateMyProjectSettingsInputSchema>;
