/**
 * Product-wide constants shared by the server, the MCP tools and the web app.
 * Keep this file free of Node- or browser-only imports.
 */

/** Field length and count limits. Zod schemas in `shared/schemas/*` are built from these. */
export const LIMITS = {
  username: { min: 3, max: 32 },
  displayName: { min: 1, max: 64 },
  email: { max: 254 },
  password: { min: 8, max: 128 },
  teamName: { min: 1, max: 64 },
  teamSlug: { min: 2, max: 40 },
  teamDescription: { max: 500 },
  projectName: { min: 1, max: 64 },
  projectKey: { min: 2, max: 6 },
  projectDescription: { max: 280 },
  readme: { max: 200_000 },
  roleName: { min: 1, max: 32 },
  statusName: { min: 1, max: 32 },
  labelName: { min: 1, max: 32 },
  labelDescription: { max: 200 },
  title: { min: 1, max: 200 },
  /** Markdown bodies of issues, tasks and replies. */
  body: { max: 100_000 },
  replyBody: { min: 1, max: 100_000 },
  releaseNote: { max: 10_000 },
  apiKeyName: { min: 1, max: 64 },
  apiKeyExpiryDays: { min: 1, max: 365 },
  apiKeysPerUser: 50,
  inviteMaxUses: { min: 1, max: 10_000 },
  inviteExpiryHours: { min: 1, max: 24 * 365 },
  searchQuery: { min: 1, max: 200 },
  filename: { max: 255 },
  /** Max items accepted by bulk inputs (ids to mark read, labels to set, …). */
  bulkIds: 100,
  attachmentsPerItem: 50,
  page: { defaultSize: 50, maxSize: 100 },
} as const;

/** API keys look like `bat_` + 40 base62 characters. Only a SHA-256 hash is stored. */
export const API_KEY = {
  prefix: 'bat_',
  randomLength: 40,
  /** Characters after `bat_` kept in clear (`api_key.prefix`) so users can recognise a key. */
  displayPrefixLength: 8,
} as const;

export const INVITE_CODE_LENGTH = 10;

/** Emailed one-time codes (verification and password reset). */
export const OTP = {
  length: 6,
  expiresInSeconds: 10 * 60,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
} as const;

/** Task claim leases, in minutes. */
export const CLAIM_LEASE = { defaultMinutes: 30, minMinutes: 5, maxMinutes: 240 } as const;

export const TRASH_RETENTION_DAYS = 30;
export const PENDING_UPLOAD_TTL_HOURS = 24;
export const BACKUP_RETENTION_COUNT = 14;

export const SSE = { heartbeatMs: 25_000, retryMs: 3_000 } as const;

/** In-memory token-bucket rate limits (requests per minute). */
export const RATE_LIMITS = {
  authPerIp: 10,
  writesPerUser: 120,
  mcpPerKey: 300,
  uploadsPerUser: 30,
} as const;

/** Usernames that can never be registered (compared lowercase). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'anonymous',
  'api',
  'auth',
  'baton',
  'bot',
  'dashboard',
  'deleted',
  'everyone',
  'ghost',
  'guest',
  'help',
  'here',
  'inbox',
  'join',
  'login',
  'logout',
  'mcp',
  'me',
  'moderator',
  'new',
  'null',
  'onboarding',
  'owner',
  'root',
  'security',
  'settings',
  'signup',
  'staff',
  'support',
  'system',
  'team',
  'teams',
  'undefined',
  'user',
  'users',
  'www',
  // @agent mention handles (BAT-6, shared/agents.ts).
  'claude',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'windsurf',
]);

/** The 12-color palette offered for labels, statuses, roles, teams and projects. */
export const COLOR_PALETTE = [
  { name: 'Gray', hex: '#6b7280' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Lime', hex: '#84cc16' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Sky', hex: '#0ea5e9' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
] as const;

export const DEFAULT_TEAM_COLOR = '#6366f1';
export const DEFAULT_PROJECT_COLOR = '#6366f1';
export const DEFAULT_LABEL_COLOR = '#6b7280';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Where a mutation came from (stored on every `activity` row). */
export const ACTOR_SOURCES = ['web', 'mcp', 'api', 'system'] as const;
export type ActorSource = (typeof ACTOR_SOURCES)[number];

export const STATUS_CATEGORIES = ['open', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Statuses every new project starts with. Exactly one is the default. */
export const DEFAULT_STATUSES: ReadonlyArray<{
  name: string;
  color: string;
  category: StatusCategory;
  isDefault: boolean;
}> = [
  { name: 'Open', color: '#6b7280', category: 'open', isDefault: true },
  { name: 'Done', color: '#22c55e', category: 'done', isDefault: false },
];

export const PRIORITY_VALUES = [0, 1, 2, 3, 4] as const;
export type PriorityValue = (typeof PRIORITY_VALUES)[number];
export const PRIORITY_KEYS = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type PriorityKey = (typeof PRIORITY_KEYS)[number];

/** Task priorities, stored as integers 0–4 (higher is more urgent). */
export const PRIORITIES: ReadonlyArray<{
  value: PriorityValue;
  key: PriorityKey;
  label: string;
  color: string;
}> = [
  { value: 0, key: 'none', label: 'No priority', color: '#6b7280' },
  { value: 1, key: 'low', label: 'Low', color: '#0ea5e9' },
  { value: 2, key: 'medium', label: 'Medium', color: '#f59e0b' },
  { value: 3, key: 'high', label: 'High', color: '#f97316' },
  { value: 4, key: 'urgent', label: 'Urgent', color: '#ef4444' },
];

export function priorityByKey(key: PriorityKey): PriorityValue {
  return PRIORITY_KEYS.indexOf(key) as PriorityValue;
}

export function priorityKey(value: PriorityValue): PriorityKey {
  return PRIORITY_KEYS[value];
}

export const ISSUE_LINK_KINDS = ['fixes', 'relates'] as const;
export type IssueLinkKind = (typeof ISSUE_LINK_KINDS)[number];

export const REPLY_PARENT_TYPES = ['issue', 'task'] as const;
export type ReplyParentType = (typeof REPLY_PARENT_TYPES)[number];

export const ATTACHMENT_PARENT_TYPES = [
  'issue',
  'task',
  'reply',
  'project',
  'user_avatar',
  'pending',
] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

/** Entities a user can subscribe to for reply notifications. */
export const SUBSCRIBABLE_TYPES = ['issue', 'task'] as const;
export type SubscribableType = (typeof SUBSCRIBABLE_TYPES)[number];

export const NOTIFICATION_TYPES = [
  'mention',
  'role_mention',
  'assigned',
  'reply',
  'issue_resolved',
  'issue_reopened',
  'task_done',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Entity types indexed by full-text search (`search_index.entity_type`). */
export const SEARCH_ENTITY_TYPES = ['task', 'issue', 'reply'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/** Entity types that can appear in `activity.entity_type`. */
export const ACTIVITY_ENTITY_TYPES = [
  'user',
  'api_key',
  'team',
  'member',
  'role',
  'invite',
  'project',
  'status',
  'label',
  'issue',
  'task',
  'reply',
  'attachment',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/** Items that can be soft-deleted and restored from Trash. */
export const TRASHABLE_TYPES = ['team', 'project', 'issue', 'task', 'reply', 'attachment'] as const;
export type TrashableType = (typeof TRASHABLE_TYPES)[number];
