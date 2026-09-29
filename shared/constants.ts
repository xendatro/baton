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

/** Longest username of anyone: agent members are `<username>-ai` (shared/principals.ts). */
export const MAX_ANY_USERNAME_LENGTH = LIMITS.username.max + '-ai'.length;

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

/**
 * Difficulty levels every new project starts with (BAT-24), easiest first. A task's level picks
 * which model runs it, through each person's own model mapping.
 */
export const DEFAULT_DIFFICULTIES: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Easy', color: '#22c55e' },
  { name: 'Normal', color: '#3b82f6' },
  { name: 'Hard', color: '#ef4444' },
];

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * How much of their agent member's activity reaches an owner's inbox (`user.agent_notifications`,
 * docs/design/agents-and-pipelines.md §1): `all` — whenever the agent's action notifies anyone;
 * `needs_me` — only when it mentions, assigns or answers the owner; `none` — never.
 */
export const AGENT_NOTIFICATION_LEVELS = ['all', 'needs_me', 'none'] as const;
export type AgentNotificationLevel = (typeof AGENT_NOTIFICATION_LEVELS)[number];

/**
 * Agent jobs (docs/design/agents-and-pipelines.md §4): what wakes an agent member's listener.
 * `mention` — its username in a reply, task or issue; `assigned` — a task assigned to it;
 * `thread_reply` — someone else replied where it authored, replied or is assigned; `pool` — a
 * task it may claim entered a stage (pipelines); `approval` — it may approve a task's stage;
 * `action_result` — a person decided on an action it asked for (sign-off); `catch_up` — its owner
 * asked it to summarize a chat's recent messages for them (private, `catch_up_summary`);
 * `draft_task` — its owner asked it to turn an issue or chat messages into a task title and
 * description for them to review (private, stored on the job; never creates the task).
 */
export const AGENT_JOB_KINDS = [
  'mention',
  'assigned',
  'thread_reply',
  'pool',
  'approval',
  'action_result',
  'catch_up',
  'draft_task',
] as const;
export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

export const AGENT_JOB_STATUSES = ['pending', 'claimed', 'done', 'cancelled'] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export const AGENT_JOB_TARGET_TYPES = ['task', 'issue', 'reply', 'action_request'] as const;
export type AgentJobTargetType = (typeof AGENT_JOB_TARGET_TYPES)[number];

/** Listener and presence timings (design §4). */
export const AGENT_LISTENER = {
  /** Longest `start_listener` wait (below common MCP client timeouts). */
  maxWaitSeconds: 110,
  defaultWaitSeconds: 50,
  /** Jobs handed out by one `start_listener` call at most. */
  maxJobsPerCall: 10,
  /** Projects one listener session may cover. */
  maxProjects: 50,
  /** A session not seen for this long has disappeared: its claimed jobs go back to the queue. */
  sessionTimeoutMs: 90_000,
  /** The loop guard: no reply-triggered jobs once this many latest replies are all by agents. */
  loopGuardReplies: 5,
} as const;

/** A person is online while a live-updates request of theirs was seen this recently. */
export const PERSON_PRESENCE_TIMEOUT_MS = 60_000;

/**
 * Destructive actions an agent member must get its owner's sign-off for (`agent_action_request`,
 * docs/design/agents-and-pipelines.md §6) while its team's "Agents need human sign-off" is on.
 * Deleting a reply or attachment needs it only when someone else wrote it.
 */
export const AGENT_ACTIONS = [
  'delete_task',
  'delete_issue',
  'delete_project',
  'delete_status',
  'delete_label',
  'delete_reply',
  'delete_attachment',
  'delete_role',
  'remove_member',
  'revoke_invite',
  'delete_team',
  'restore_team',
  'transfer_team_ownership',
] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/**
 * Actions only a team's owner may take. Agents never own teams, so these always need the sign-off
 * of an owner who owns the team (whatever the team setting) and run as the owner once approved.
 */
export const OWNER_ONLY_AGENT_ACTIONS: ReadonlySet<AgentAction> = new Set([
  'delete_team',
  'restore_team',
  'transfer_team_ownership',
]);

export const AGENT_ACTION_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'failed',
] as const;
export type AgentActionStatus = (typeof AGENT_ACTION_STATUSES)[number];

/** Pending sign-off requests expire after this many days. */
export const AGENT_ACTION_REQUEST_TTL_DAYS = 7;

/** Kinds of users: people, and the agent member every person has. */
export const USER_KINDS = ['human', 'agent'] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Where a mutation came from (stored on every `activity` row). */
export const ACTOR_SOURCES = ['web', 'mcp', 'api', 'system'] as const;
export type ActorSource = (typeof ACTOR_SOURCES)[number];

/**
 * Legacy (before 2026-09-27 "stages"): statuses were `open` or `done`. The `status.category` column
 * is kept only so old databases migrate; nothing reads it. Old clients may still send `category`,
 * which is accepted and ignored.
 */
export const STATUS_CATEGORIES = ['open', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Shapes a status's icon can take (drawn in the status's color). */
export const STATUS_ICONS = [
  'circle',
  'dashed-circle',
  'half-circle',
  'dot-circle',
  'check-circle',
  'x-circle',
  'pause-circle',
  'square',
  'triangle',
  'diamond',
  'star',
  'flag',
] as const;
export type StatusIconShape = (typeof STATUS_ICONS)[number];
export const DEFAULT_STATUS_ICON: StatusIconShape = 'circle';

/**
 * The rules of the seeded "Done" stage (and of every former `done` status after migration 0012):
 * entering it resolves the issues the task fixes, releases the claim and tells the author; nobody
 * is assigned there, it doesn't block the tasks waiting on it and it can't be claimed.
 */
export const FINISHED_STAGE_RULES = {
  handoff: { mode: 'nobody' as const },
  onEnter: {
    resolveIssues: true,
    releaseClaim: true,
    notifyAuthor: true,
    notifyAssignees: true,
    notifyPreviousHolder: true,
  },
  blocksDependents: false,
  claimable: false,
};

/** A seeded stage: its look and the rules that differ from the plain defaults. */
export interface StatusSeed {
  name: string;
  color: string;
  icon: StatusIconShape;
  isDefault: boolean;
  /** Rules besides the plain defaults (`allowCreate` defaults to `isDefault`). */
  rules: (Partial<typeof FINISHED_STAGE_RULES> & { allowCreate?: boolean }) | null;
}

/**
 * Stages every new pipeline (and so every new project) starts with, 2026-09-27: ordinary stages
 * that can be renamed, recolored, reordered or deleted. They are deliberately plain so a team can
 * use the board by hand at once: nobody is assigned automatically, nothing gates moving on, and
 * each stage can send tasks back to every earlier one. New tasks can start in Backlog (the default)
 * and To do; Done is the finishing stage. Existing projects keep their stages.
 */
export const DEFAULT_STATUSES: ReadonlyArray<StatusSeed> = [
  { name: 'Backlog', color: '#6b7280', icon: 'dashed-circle', isDefault: true, rules: null },
  {
    name: 'To do',
    color: '#3b82f6',
    icon: 'circle',
    isDefault: false,
    rules: { allowCreate: true },
  },
  { name: 'In progress', color: '#f59e0b', icon: 'half-circle', isDefault: false, rules: null },
  { name: 'In review', color: '#8b5cf6', icon: 'dot-circle', isDefault: false, rules: null },
  {
    name: 'Done',
    color: '#22c55e',
    icon: 'check-circle',
    isDefault: false,
    rules: FINISHED_STAGE_RULES,
  },
];

/** The name "Create" gives a new stage: "New stage", then "New stage 2", "New stage 3"… */
export function nextNewStageName(existing: readonly string[]): string {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  if (!taken.has('new stage')) return 'New stage';
  for (let n = 2; ; n += 1) {
    if (!taken.has(`new stage ${n}`)) return `New stage ${n}`;
  }
}

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

/**
 * How an issue's or task's replies are shown: `chat` — a flat, Discord-like message stream (the
 * default for new items); `forum` — the threaded comment tree (BAT-13). Same replies either way.
 */
export const CONVERSATION_MODES = ['chat', 'forum'] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

/** Chat (typing indicators, catch-up summaries by the viewer's own agent). */
export const CHAT_LIMITS = {
  /** Messages per page of the chat stream. */
  pageSize: 50,
  maxPageSize: 100,
  /** Clients ping `typing` at most this often while someone types… */
  typingPingMs: 3_000,
  /** …and show "X is typing" this long after the last ping. */
  typingShowMs: 5_000,
  /** The server ignores pings of the same person and item closer together than this. */
  typingServerThrottleMs: 1_000,
  /** Unread messages from which the Catch up strip is offered. */
  catchUpThreshold: 10,
  /** "Last N" ranges of a catch-up summary. */
  catchUpCounts: [20, 50, 100],
  /** Most messages one summary covers. */
  catchUpMaxMessages: 100,
  /** Longest summary text. */
  catchUpSummaryMax: 20_000,
  /** Summaries shown per item. */
  catchUpShown: 5,
  /** Messages one "Make task from this" (and its agent draft) takes at most. */
  taskFromMessagesMax: 50,
} as const;

export const ATTACHMENT_PARENT_TYPES = [
  'issue',
  'task',
  'reply',
  'project',
  'user_avatar',
  'pending',
] as const;
export type AttachmentParentType = (typeof ATTACHMENT_PARENT_TYPES)[number];

/** What people can react to with an emoji (BAT-14). */
export const REACTION_TARGET_TYPES = ['task', 'issue', 'reply'] as const;
export type ReactionTargetType = (typeof REACTION_TARGET_TYPES)[number];

/** One-click reactions under every reply, task and issue; the picker offers the rest. */
export const QUICK_REACTIONS = ['👍', '👎', '😄', '❤️', '🔥', '🎉', '👀'] as const;

export const REACTION_LIMITS = {
  /** UTF-8 bytes of one reaction emoji (long ZWJ sequences and tag flags need ~28). */
  emojiBytes: 32,
  /** Different emojis on one reply, task or issue. */
  emojisPerTarget: 50,
} as const;

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
  /** A task reached a stage with `onEnter.notifyAuthor` ("Reached <stage>"; the name is historical). */
  'task_done',
  /** An agent asks its owner to sign off a destructive action (design §6); always delivered. */
  'agent_action_request',
  /** A task entered a pipeline stage whose `notify` rule names you (design §5). */
  'stage_entered',
  /** Someone who may only ask wants to start your agent (agent access): a request to approve. */
  'agent_request',
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
  'difficulty',
  'issue',
  'task',
  'reply',
  'attachment',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/** Items that can be soft-deleted and restored from Trash. */
export const TRASHABLE_TYPES = ['team', 'project', 'issue', 'task', 'reply', 'attachment'] as const;
export type TrashableType = (typeof TRASHABLE_TYPES)[number];
