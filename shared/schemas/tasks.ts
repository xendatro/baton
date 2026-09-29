import { z } from 'zod';
import {
  CLAIM_LEASE,
  CONVERSATION_MODES,
  ISSUE_LINK_KINDS,
  LIMITS,
  PRIORITY_KEYS,
  PRIORITY_VALUES,
  STATUS_ICONS,
  priorityByKey,
  type PriorityValue,
} from '../constants';
import { dueDateSchema, idSchema, markdownSchema, timestampSchema, titleSchema } from './common';
import {
  attachmentSchema,
  reactionSummarySchema,
  roleSummarySchema,
  userSummarySchema,
  viaKeySchema,
} from './core';
import {
  evidenceInputSchema,
  forceMoveFields,
  taskPipelineSummarySchema,
  taskStageSchema,
} from './pipelines';
import { statusSchema } from './projects';

/**
 * Wire contracts of the tasks module (SPEC §1.8, §1.9): tasks, the board and list views, claims,
 * blockers and issue links. Request schemas validate REST bodies, MCP inputs and web forms;
 * response schemas document (and in tests verify) what the server returns. `path` fields are
 * relative web-app paths.
 */

/** Caps that keep tasks, boards and pickers usable. */
export const TASK_LIMITS = {
  assignees: 50,
  labels: 50,
  blockers: 50,
  issueLinks: 50,
  /** Cards returned per board column. */
  boardColumn: 500,
  /** Rows per list page. */
  listPage: 200,
  /** Values in one list filter (`status=a,b,c`). */
  filterValues: 100,
} as const;

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

/** Priority as stored: 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
export const priorityValueSchema = z.literal(PRIORITY_VALUES);

/** Priority as agents and scripts may write it: a number 0–4 or a name (`high`). */
export const PRIORITY_INPUT_MESSAGE = `Priority must be one of ${PRIORITY_KEYS.join(', ')} (or 0–4)`;

export const priorityInputSchema = z.union(
  [
    priorityValueSchema,
    z.enum(PRIORITY_KEYS).transform((key): PriorityValue => priorityByKey(key)),
  ],
  { error: PRIORITY_INPUT_MESSAGE },
);

export const leaseMinutesSchema = z
  .number()
  .int()
  .min(CLAIM_LEASE.minMinutes, `At least ${CLAIM_LEASE.minMinutes} minutes`)
  .max(CLAIM_LEASE.maxMinutes, `At most ${CLAIM_LEASE.maxMinutes} minutes`);

export const issueLinkKindSchema = z.enum(ISSUE_LINK_KINDS);

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const taskStatusSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  /** Icon shape, drawn in `color`. */
  icon: z.enum(STATUS_ICONS),
  /** Its pipeline (BAT-25): id and name, for projects with more than one. Optional for fixtures. */
  pipeline: z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() }).optional(),
});
export type TaskStatusSummary = z.infer<typeof taskStatusSummarySchema>;

export const taskLabelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type TaskLabelSummary = z.infer<typeof taskLabelSummarySchema>;

/** Assignment is a suggestion, not a lock: any mix of members and roles. */
export const taskAssigneesSchema = z.object({
  users: z.array(userSummarySchema),
  roles: z.array(roleSummarySchema),
});
export type TaskAssignees = z.infer<typeof taskAssigneesSchema>;

/** Who is working on the task: a (user, API key) pair; `via` is null for claims made on the web. */
export const taskClaimSchema = z.object({
  user: userSummarySchema,
  via: viaKeySchema.nullable(),
  claimedAt: timestampSchema,
  /** The lease ends here unless the holder renews it (any write by the holder renews it). */
  /** Always null: claims are held until released (2026-09-27). */
  expiresAt: timestampSchema.nullable(),
});
export type TaskClaim = z.infer<typeof taskClaimSchema>;

/**
 * A task as other modules show it (dashboard, my tasks, …). `claim` is null when nobody holds a
 * valid claim; `blocked` is true while any blocker sits in a stage that blocks its dependents.
 * `assignees` are the task's assignees in its current stage.
 */
export const taskSummarySchema = z.object({
  id: z.string(),
  /** `KEY-12`. */
  ref: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  status: taskStatusSummarySchema,
  /** 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
  priority: priorityValueSchema,
  /** `YYYY-MM-DD`. */
  dueDate: z.string().nullable(),
  labels: z.array(taskLabelSummarySchema),
  assignees: taskAssigneesSchema,
  claim: taskClaimSchema.nullable(),
  blocked: z.boolean(),
  replyCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
  /**
   * Set while the task is in a stage that doesn't block its dependents (it counts as completed),
   * from when it entered such a stage. Optional for older fixtures.
   */
  completedAt: timestampSchema.nullable().optional(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

/** A task on the board or in the list. */
export const taskCardSchema = taskSummarySchema.extend({
  /** Fractional-index key: the order within its status column. */
  position: z.string(),
  /** Refs of the open tasks blocking this one. */
  blockers: z.array(z.string()),
  createdAt: timestampSchema,
  /** Set while the task is in a stage that doesn't block its dependents. */
  completedAt: timestampSchema.nullable(),
  /** Relative web-app path. */
  path: z.string(),
  /**
   * The viewer's unread notifications about the task and its replies (BAT-16). Sent with the
   * board and the list.
   */
  unreadCount: z.number().int().nonnegative().optional(),
  /** What blocks it in its stage (design §5); null when the stage has no such rules. */
  pipeline: taskPipelineSummarySchema.nullable().optional(),
});
export type TaskCard = z.infer<typeof taskCardSchema>;

/** Another task of the project, as listed under "Blocked by" and "Blocking". */
export const relatedTaskSchema = z.object({
  id: z.string(),
  ref: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  status: taskStatusSummarySchema,
  /** Set while it is in a stage that doesn't block its dependents (so it blocks nothing). */
  completedAt: timestampSchema.nullable().optional(),
  path: z.string(),
});
export type RelatedTask = z.infer<typeof relatedTaskSchema>;

/** An issue the task addresses: `fixes` resolves it when the task is done, `relates` doesn't. */
export const linkedIssueSchema = z.object({
  id: z.string(),
  /** `KEY#51`. */
  ref: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  resolved: z.boolean(),
  kind: issueLinkKindSchema,
  projectId: z.string(),
  path: z.string(),
});
export type LinkedIssue = z.infer<typeof linkedIssueSchema>;

/** The full context of a task (task page, `get_task`). */
export const taskSchema = taskCardSchema.extend({
  /** Markdown. */
  description: z.string(),
  teamSlug: z.string(),
  projectKey: z.string(),
  author: userSummarySchema.nullable(),
  /** The API key the task was created through. */
  via: viaKeySchema.nullable(),
  editedAt: timestampSchema.nullable(),
  lastActivityAt: timestampSchema,
  /** Tasks this one waits for; it is blocked while any of them is in a stage that blocks. */
  blockedBy: z.array(relatedTaskSchema),
  /** Tasks waiting for this one. */
  blocking: z.array(relatedTaskSchema),
  issues: z.array(linkedIssueSchema),
  attachments: z.array(attachmentSchema),
  /** Emoji reactions on the task (BAT-14). */
  reactions: z.array(reactionSummarySchema),
  /** Whether the viewer gets reply notifications. */
  subscribed: z.boolean(),
  /**
   * The task's stage in the project's pipeline (design §5): instructions, exit criteria with
   * evidence, approvals, what is missing to move on. Null when the project has no stage rules.
   */
  stage: taskStageSchema.nullable().optional(),
  /** How the replies are shown: `chat` or `forum` (absent in older fixtures: forum). */
  conversationMode: z.enum(CONVERSATION_MODES).optional(),
});
export type Task = z.infer<typeof taskSchema>;

// ---------------------------------------------------------------------------------------------
// Board and list
// ---------------------------------------------------------------------------------------------

export const TASK_DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];
export const TASK_CLAIM_FILTERS = ['yes', 'no', 'mine'] as const;
export type TaskClaimFilter = (typeof TASK_CLAIM_FILTERS)[number];
export const TASK_BLOCKED_FILTERS = ['yes', 'no'] as const;
export type TaskBlockedFilter = (typeof TASK_BLOCKED_FILTERS)[number];

export const TASK_SORTS = [
  'status',
  'number',
  'title',
  'priority',
  'dueDate',
  'createdAt',
  'updatedAt',
] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/** An assignee filter value: `me` (me or my roles), `unassigned`, `user:<id>` or `role:<id>`. */
export const assigneeFilterSchema = z.union([
  z.literal('me'),
  z.literal('unassigned'),
  z.templateLiteral(['user:', idSchema]),
  z.templateLiteral(['role:', idSchema]),
]);
export type AssigneeFilter = z.infer<typeof assigneeFilterSchema>;

/** A comma-separated query value (`a,b,c`) as a deduplicated list. */
function commaList<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .max(5_000)
    .transform((value) => [
      ...new Set(
        value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(item).max(TASK_LIMITS.filterValues));
}

const priorityFilterSchema = z.union([
  z.enum(['0', '1', '2', '3', '4']).transform((value) => Number(value) as PriorityValue),
  z.enum(PRIORITY_KEYS).transform((key): PriorityValue => priorityByKey(key)),
]);

/**
 * Filters shared by the board, the list and `list_tasks` (SPEC §1.9). Values of one filter are
 * alternatives (any of); different filters must all match.
 */
export const taskFiltersSchema = z.object({
  /** Words in the title or description, a number (`12`) or a ref (`API-12`). */
  q: z.string().trim().max(LIMITS.searchQuery.max).optional(),
  status: commaList(idSchema).optional(),
  /** Only tasks in stages of this pipeline (BAT-25). */
  pipeline: idSchema.optional(),
  assignee: commaList(assigneeFilterSchema).optional(),
  label: commaList(idSchema).optional(),
  priority: commaList(priorityFilterSchema).optional(),
  /** `overdue` (past due and not done), `today`, `week` (today and the 6 days after), `none`. */
  due: z.enum(TASK_DUE_FILTERS).optional(),
  /** `yes` (validly claimed), `no`, `mine` (claimed by me through any key or the web). */
  claimed: z.enum(TASK_CLAIM_FILTERS).optional(),
  /** `yes`: waiting for an open blocker. */
  blocked: z.enum(TASK_BLOCKED_FILTERS).optional(),
  /** The viewer's calendar date, for the due filters (default: the server's UTC date). */
  today: dueDateSchema.optional(),
});
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

export const boardQuerySchema = taskFiltersSchema.extend({
  /** Cards per column (the column's `count` covers all matches). */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TASK_LIMITS.boardColumn)
    .default(TASK_LIMITS.boardColumn),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const listTasksQuerySchema = taskFiltersSchema.extend({
  /** `status` orders by column, then board position. */
  sort: z.enum(TASK_SORTS).default('status'),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(TASK_LIMITS.listPage).default(100),
  cursor: z.string().min(1).max(100).optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const boardColumnSchema = z.object({
  status: statusSchema,
  /** Tasks in the column matching the filters. */
  count: z.number().int().nonnegative(),
  /** In board order (at most `limit`). */
  tasks: z.array(taskCardSchema),
});
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const boardResponseSchema = z.object({
  /** Every status of the project, in column order. */
  columns: z.array(boardColumnSchema),
  /** Tasks matching the filters. */
  total: z.number().int().nonnegative(),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

export const taskListResponseSchema = z.object({
  items: z.array(taskCardSchema),
  /** Tasks matching the filters. */
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

function idListSchema(max: number) {
  return z.array(idSchema).max(max);
}

/**
 * A change to a list field: replace it (`set`), or `add` and/or `remove` items. `set` can't be
 * combined with the other two.
 */
function listChangeSchema<T extends z.ZodType, R extends z.ZodType>(item: T, key: R, max: number) {
  return z
    .object({
      set: z.array(item).max(max).optional(),
      add: z.array(item).max(max).optional(),
      remove: z.array(key).max(max).optional(),
    })
    .refine((value) => value.set === undefined || (!value.add && !value.remove), {
      message: 'Use either set, or add/remove',
    })
    .refine(
      (value) => value.set !== undefined || value.add !== undefined || value.remove !== undefined,
      { message: 'Pass set, add or remove' },
    );
}

export function idListChangeSchema(max: number) {
  return listChangeSchema(idSchema, idSchema, max);
}
export type IdListChange = z.infer<ReturnType<typeof idListChangeSchema>>;

export const issueLinkInputSchema = z.object({
  issueId: idSchema,
  kind: issueLinkKindSchema.default('fixes'),
});
export type IssueLinkInput = z.infer<typeof issueLinkInputSchema>;

export const issueLinksChangeSchema = listChangeSchema(
  issueLinkInputSchema,
  idSchema,
  TASK_LIMITS.issueLinks,
);
export type IssueLinksChange = z.infer<typeof issueLinksChangeSchema>;

export const createTaskInputSchema = z.object({
  title: titleSchema,
  /** Markdown. */
  description: markdownSchema.optional(),
  /** Default: the default status of `pipelineId` (or of the project's default pipeline). */
  statusId: idSchema.optional(),
  /** The pipeline it starts in (BAT-25), when `statusId` isn't given. */
  pipelineId: idSchema.optional(),
  priority: priorityValueSchema.optional(),
  dueDate: dueDateSchema.nullable().optional(),
  /** Team members. */
  assigneeUserIds: idListSchema(TASK_LIMITS.assignees).optional(),
  /** Team roles (not `@everyone`). */
  assigneeRoleIds: idListSchema(TASK_LIMITS.assignees).optional(),
  labelIds: idListSchema(TASK_LIMITS.labels).optional(),
  /** Tasks of the same project this one waits for. */
  blockedByTaskIds: idListSchema(TASK_LIMITS.blockers).optional(),
  issueLinks: z.array(issueLinkInputSchema).max(TASK_LIMITS.issueLinks).optional(),
  /** Pending uploads to attach (images and files added in the description editor). */
  attachmentIds: idListSchema(LIMITS.attachmentsPerItem).optional(),
  /** Response style: `chat` (default) or `forum`. */
  conversationMode: z.enum(CONVERSATION_MODES).optional(),
});
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type CreateTaskData = z.output<typeof createTaskInputSchema>;

export const updateTaskInputSchema = z
  .object({
    title: titleSchema.optional(),
    description: markdownSchema.optional(),
    /** Moves the task to the end of that status column. */
    statusId: idSchema.optional(),
    priority: priorityValueSchema.optional(),
    /** null clears the due date. */
    dueDate: dueDateSchema.nullable().optional(),
    assigneeUsers: idListChangeSchema(TASK_LIMITS.assignees).optional(),
    assigneeRoles: idListChangeSchema(TASK_LIMITS.assignees).optional(),
    labels: idListChangeSchema(TASK_LIMITS.labels).optional(),
    blockedBy: idListChangeSchema(TASK_LIMITS.blockers).optional(),
    issueLinks: issueLinksChangeSchema.optional(),
    /** Pending uploads to attach. */
    attachmentIds: idListSchema(LIMITS.attachmentsPerItem).optional(),
    /** Evidence for the current stage's exit criteria (criterion id → text). */
    evidence: evidenceInputSchema.optional(),
    /** Owner/administrator: move past the stage rules (needs `reason`). */
    ...forceMoveFields,
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateTaskInput = z.input<typeof updateTaskInputSchema>;
export type UpdateTaskData = z.output<typeof updateTaskInputSchema>;

/**
 * Moves a task within its column or to another status. It goes right after `afterId`, else right
 * before `beforeId`, else to the end of the column. Neighbours must be in the target status.
 */
export const moveTaskInputSchema = z.object({
  /** Default: the task's current status. */
  statusId: idSchema.optional(),
  afterId: idSchema.optional(),
  beforeId: idSchema.optional(),
  /** Evidence for the current stage's exit criteria (criterion id → text), saved first. */
  evidence: evidenceInputSchema.optional(),
  /** Owner/administrator: move past the stage rules (needs `reason`). */
  ...forceMoveFields,
});
export type MoveTaskInput = z.infer<typeof moveTaskInputSchema>;

/** `POST /api/projects/:projectId/tasks/from-issue` (the issue page's "Create task"). */
export const createTaskFromIssueSchema = z.object({ issueId: idSchema });
export type CreateTaskFromIssueInput = z.infer<typeof createTaskFromIssueSchema>;

/** `PUT /api/tasks/:taskId/issues/:issueId`. */
export const setIssueLinkInputSchema = z.object({ kind: issueLinkKindSchema });
export type SetIssueLinkInput = z.infer<typeof setIssueLinkInputSchema>;

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

export const claimNextTaskInputSchema = z.object({
  /** Only tasks assigned to this role. */
  roleId: idSchema.optional(),
  /** Only tasks with this label. */
  labelId: idSchema.optional(),
  /** Only tasks with one of these priorities. */
  priority: z.array(priorityValueSchema).min(1).max(5).optional(),
  /** Only tasks assigned to me directly or through one of my roles. */
  assignedToMe: z.boolean().optional(),
  /** Move the claimed task to this (claimable) stage, e.g. "In Progress". */
  moveToStatusId: idSchema.optional(),
  leaseMinutes: leaseMinutesSchema.optional(),
});
export type ClaimNextTaskInput = z.infer<typeof claimNextTaskInputSchema>;

export const claimTaskInputSchema = z.object({
  /** Take over a claim someone else holds (needs `UPDATE_TASKS`; audited as a takeover). */
  force: z.boolean().optional(),
  moveToStatusId: idSchema.optional(),
  leaseMinutes: leaseMinutesSchema.optional(),
});
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;

export const renewClaimInputSchema = z.object({ leaseMinutes: leaseMinutesSchema.optional() });
export type RenewClaimInput = z.infer<typeof renewClaimInputSchema>;

export const releaseTaskInputSchema = z.object({
  /** Posted as a reply on the task (e.g. what was done and what is left). */
  note: z.string().trim().max(LIMITS.releaseNote.max).optional(),
});
export type ReleaseTaskInput = z.infer<typeof releaseTaskInputSchema>;

export const claimNextResponseSchema = z.object({
  /** The claimed task, or null when no task is eligible. */
  task: taskSchema.nullable(),
});
export type ClaimNextResponse = z.infer<typeof claimNextResponseSchema>;
