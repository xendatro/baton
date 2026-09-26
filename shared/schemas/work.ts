import { z } from 'zod';
import { PRIORITY_KEYS, PRIORITY_VALUES, STATUS_CATEGORIES } from '../constants';
import { dueDateSchema, idSchema, timestampSchema } from './common';
import { activityEntrySchema, roleSummarySchema, userSummarySchema, viaKeySchema } from './core';

/**
 * Wire contracts of the work module (SPEC §1.9): `GET /api/me/tasks` (My tasks) and
 * `GET /api/me/dashboard`, plus the MCP tools `my_tasks` and `dashboard_summary`.
 */

// ---------------------------------------------------------------------------------------------
// Task summary
// ---------------------------------------------------------------------------------------------

/** Task priority as stored: 0 none, 1 low, 2 medium, 3 high, 4 urgent. */
export const priorityValueSchema = z.literal(PRIORITY_VALUES);

/**
 * A task as lists show it. Same shape as the tasks module's `taskSummarySchema`
 * (shared/schemas/tasks.ts); the work module keeps its own copy so both can be built in parallel.
 */
export const workTaskSchema = z.object({
  id: z.string(),
  /** `KEY-12`. */
  ref: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  projectId: z.string(),
  teamId: z.string(),
  status: z.object({
    id: z.string(),
    name: z.string(),
    color: z.string(),
    category: z.enum(STATUS_CATEGORIES),
  }),
  priority: priorityValueSchema,
  /** `YYYY-MM-DD` or null. */
  dueDate: z.string().nullable(),
  labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
  assignees: z.object({ users: z.array(userSummarySchema), roles: z.array(roleSummarySchema) }),
  /** The valid (unexpired) claim, or null. */
  claim: z
    .object({
      user: userSummarySchema,
      /** The API key holding the claim; null for claims made on the web. */
      via: viaKeySchema.nullable(),
      claimedAt: timestampSchema,
      expiresAt: timestampSchema,
    })
    .nullable(),
  /** Some task it depends on is still in an open-category status. */
  blocked: z.boolean(),
  replyCount: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
});
export type WorkTask = z.infer<typeof workTaskSchema>;

export const workTeamRefSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
});
export type WorkTeamRef = z.infer<typeof workTeamRefSchema>;

export const workProjectRefSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string(),
});
export type WorkProjectRef = z.infer<typeof workProjectRefSchema>;

/** Why a task is on my list: assigned to me directly and/or through roles I have. */
export const assignmentReasonSchema = z.object({
  direct: z.boolean(),
  /** My roles the task is assigned to. */
  roles: z.array(roleSummarySchema),
});
export type AssignmentReason = z.infer<typeof assignmentReasonSchema>;

/** A task with where it lives and why it is mine (My tasks, dashboard lists). */
export const myTaskSchema = workTaskSchema.extend({
  team: workTeamRefSchema,
  project: workProjectRefSchema,
  /** Relative web-app path of the task page. */
  url: z.string(),
  assignment: assignmentReasonSchema,
});
export type MyTask = z.infer<typeof myTaskSchema>;

// ---------------------------------------------------------------------------------------------
// GET /api/me/tasks
// ---------------------------------------------------------------------------------------------

export const DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export const MY_TASKS_SORTS = ['priority', 'due', 'updated', 'created'] as const;
export type MyTasksSort = (typeof MY_TASKS_SORTS)[number];

/** Most tasks one My tasks response lists (`total` still counts them all). */
export const MY_TASKS_MAX = 500;

/** Days (today included) that count as "due this week" / "due soon". */
export const DUE_SOON_DAYS = 7;

/** Comma-separated priority keys (`high,urgent`), deduplicated. */
const priorityListSchema = z
  .string()
  .max(100)
  .transform((value, ctx) => {
    const parts = [
      ...new Set(
        value
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const keys = PRIORITY_KEYS.filter((key) => parts.includes(key));
    if (keys.length !== parts.length) {
      ctx.addIssue({
        code: 'custom',
        message: `priority must be among ${PRIORITY_KEYS.join(',')}`,
      });
      return z.NEVER;
    }
    return keys;
  });

export const myTasksQuerySchema = z.object({
  /** Only this team (id). */
  teamId: idSchema.optional(),
  /** Only this project (id). */
  projectId: idSchema.optional(),
  /** Comma-separated priority keys: `none,low,medium,high,urgent`. */
  priority: priorityListSchema.optional(),
  due: z.enum(DUE_FILTERS).optional(),
  /** Case-insensitive text in the title or the ref. */
  q: z.string().trim().max(200).optional(),
  sort: z.enum(MY_TASKS_SORTS).default('priority'),
  /**
   * The caller's calendar date (`YYYY-MM-DD`) for due-date logic, since due dates have no time
   * zone. Defaults to the server's UTC date.
   */
  today: dueDateSchema.optional(),
});
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;
export type MyTasksQueryInput = z.input<typeof myTasksQuerySchema>;

export const myTasksResponseSchema = z.object({
  items: z.array(myTaskSchema),
  /** Every matching task, even beyond the `MY_TASKS_MAX` listed. */
  total: z.number().int().nonnegative(),
});
export type MyTasksResponse = z.infer<typeof myTasksResponseSchema>;

// ---------------------------------------------------------------------------------------------
// GET /api/me/dashboard
// ---------------------------------------------------------------------------------------------

/** Tasks per dashboard list (the counts say how many there are in all). */
export const DASHBOARD_LIST_LIMIT = 10;
/** Recent activity entries on the dashboard. */
export const DASHBOARD_ACTIVITY_LIMIT = 30;

export const dashboardQuerySchema = z.object({
  /** The caller's calendar date (`YYYY-MM-DD`); defaults to the server's UTC date. */
  today: dueDateSchema.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

export const dashboardCountsSchema = z.object({
  /** Open tasks assigned to me, directly or through my roles. */
  assigned: z.number().int().nonnegative(),
  /** …of which past their due date. */
  overdue: z.number().int().nonnegative(),
  /** …of which due today or within the next days (`DUE_SOON_DAYS`, today included). */
  dueSoon: z.number().int().nonnegative(),
  /** Tasks with a valid claim held by me (on the web or through any of my API keys). */
  claimed: z.number().int().nonnegative(),
});
export type DashboardCounts = z.infer<typeof dashboardCountsSchema>;

export const dashboardProjectSchema = workProjectRefSchema.extend({
  description: z.string(),
  /** Tasks in an open-category status. */
  openTasks: z.number().int().nonnegative(),
  /** Unresolved issues. */
  openIssues: z.number().int().nonnegative(),
  /** Relative web-app path of the project overview. */
  url: z.string(),
});
export type DashboardProject = z.infer<typeof dashboardProjectSchema>;

export const dashboardTeamSchema = workTeamRefSchema.extend({
  memberCount: z.number().int().nonnegative(),
  /** Relative web-app path of the team home. */
  url: z.string(),
  projects: z.array(dashboardProjectSchema),
});
export type DashboardTeam = z.infer<typeof dashboardTeamSchema>;

export const dashboardResponseSchema = z.object({
  /** The date the due-date logic used (`YYYY-MM-DD`). */
  today: z.string(),
  counts: dashboardCountsSchema,
  /** Most urgent open tasks assigned to me (priority, then due date). */
  assigned: z.array(myTaskSchema),
  /** Overdue, earliest due first. */
  overdue: z.array(myTaskSchema),
  /** Due today or soon, earliest due first. */
  dueSoon: z.array(myTaskSchema),
  /** Claimed by me or my keys, most recent claim first. */
  claimed: z.array(myTaskSchema),
  /** Newest first, only what I may see (per-item history, or everything with the audit log). */
  activity: z.array(activityEntrySchema),
  /** My teams with their projects. */
  teams: z.array(dashboardTeamSchema),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
