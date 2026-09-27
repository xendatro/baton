import { z } from 'zod';
import { CLAIM_LEASE, ISSUE_LINK_KINDS, LIMITS, PRIORITY_KEYS } from '@shared/constants';
import { formatTaskRef } from '@shared/refs';
import { dueDateSchema } from '@shared/schemas/common';
import {
  claimNextTaskInputSchema,
  createTaskInputSchema,
  listTasksQuerySchema,
  PRIORITY_INPUT_MESSAGE,
  priorityInputSchema,
  TASK_BLOCKED_FILTERS,
  TASK_CLAIM_FILTERS,
  TASK_DUE_FILTERS,
  TASK_LIMITS,
  TASK_SORTS,
  updateTaskInputSchema,
  type Task,
  type TaskCard,
} from '@shared/schemas/tasks';
import type { Reply } from '@shared/schemas/core';
import { errors, isAppError } from '../../lib/errors';
import { appPaths } from '../../lib/urls';
import { listEntityActivity } from '../../services/activity';
import { resolveTrashRef } from '../../services/admin';
import { claimNextTask, claimTask, releaseTask, renewClaim } from '../../services/claims';
import {
  resolveIssue,
  resolveLabel,
  resolveProject,
  resolveRole,
  resolveStatus,
  resolveTask,
  resolveUser,
} from '../../services/refs';
import { listReplyPage } from '../../services/replies';
import {
  createTask,
  createTaskFromIssue,
  deleteTask,
  getTask,
  listTasks,
  moveTask,
  restoreTask,
  updateTask,
} from '../../services/tasks';
import { parseToolInput, qualifyRef, toAbsolute, withAbsoluteUrls } from '../util';
import { defineTool, toolInput, type McpTool, type ToolContext } from './define';

/**
 * Task MCP tools (SPEC §5.1 [tasks]): the board, tasks, links and claims. Handlers resolve refs
 * (`KEY-12`, status and label names, usernames, role names), validate with the shared schemas and
 * call the same services as the REST routes. Descriptions teach the agent workflow:
 * whoami → claim_next_task → get_task → work → add_reply → move_task to done (releases the claim).
 */

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

const projectRef = z
  .string()
  .min(1)
  .describe('Project: KEY (if unambiguous across your teams), team-slug/KEY, or project id');
const taskRef = z.string().min(1).describe('Task: KEY-12, team-slug/KEY-12, or task id');
const statusRef = z.string().min(1).describe('Status name (case-insensitive) or id');
const priorityField = z
  .union([z.enum(PRIORITY_KEYS), z.number().int().min(0).max(4)], {
    error: PRIORITY_INPUT_MESSAGE,
  })
  .describe('Priority: none, low, medium, high, urgent (or 0–4)');
const dueDateField = z.string().describe('Due date YYYY-MM-DD');
const usernames = z
  .array(z.string().min(1))
  .max(TASK_LIMITS.assignees)
  .describe('Usernames (or user ids) of team members');
const roleNames = z
  .array(z.string().min(1))
  .max(TASK_LIMITS.assignees)
  .describe('Team roles by name, slug (e.g. backend or @&backend) or id');
const labelNames = z
  .array(z.string().min(1))
  .max(TASK_LIMITS.labels)
  .describe('Label names (case-insensitive) or ids of the project');
const taskRefs = z
  .array(z.string().min(1))
  .max(TASK_LIMITS.blockers)
  .describe('Task refs (KEY-12) of the same project');
const issueLinkField = toolInput({
  issue: z.string().min(1).describe('Issue: KEY#51, team-slug/KEY#51, or issue id'),
  kind: z
    .enum(ISSUE_LINK_KINDS)
    .default('fixes')
    .describe(
      "fixes: the issue is resolved when the task is done (only for the issue's author or with RESOLVE_ISSUES); relates: just a reference",
    ),
});
const leaseField = z
  .number()
  .int()
  .min(CLAIM_LEASE.minMinutes)
  .max(CLAIM_LEASE.maxMinutes)
  .describe(
    `Lease in minutes (${CLAIM_LEASE.minMinutes}–${CLAIM_LEASE.maxMinutes}, default ${CLAIM_LEASE.defaultMinutes}); any write you make on the task renews it`,
  );

function listChange<T extends z.ZodType>(item: T, description: string) {
  return toolInput({
    set: z.array(item).optional().describe('Replace the whole list'),
    add: z.array(item).optional().describe('Add these'),
    remove: z.array(item).optional().describe('Remove these'),
  }).describe(`${description}. Pass set, or add and/or remove.`);
}

/**
 * The tools' parameter names for the fields of the shared task schemas, so validation errors
 * name what the agent sent.
 */
const TASK_FIELD_NAMES: Readonly<Record<string, string>> = {
  q: 'query',
  statusId: 'status',
  assigneeUserIds: 'assignees',
  assigneeRoleIds: 'assigneeRoles',
  assigneeUsers: 'assignees',
  labelIds: 'labels',
  blockedByTaskIds: 'blockedBy',
  issueLinks: 'issues',
  roleId: 'role',
  labelId: 'label',
  moveToStatusId: 'moveToStatus',
};

// ---------------------------------------------------------------------------------------------
// Resolution and output
// ---------------------------------------------------------------------------------------------

function projectOf(ctx: ToolContext, ref: string) {
  return resolveProject(ctx.deps, ctx.actor, ref);
}

function taskOf(ctx: ToolContext, ref: string) {
  return resolveTask(ctx.deps, ctx.actor, ref);
}

function userIds(ctx: ToolContext, teamId: string, refs: readonly string[] | undefined) {
  return refs?.map((ref) => resolveUser(ctx.deps, ctx.actor, ref, { teamId }).id);
}

function roleIds(ctx: ToolContext, teamId: string, refs: readonly string[] | undefined) {
  return refs?.map((ref) => resolveRole(ctx.deps.db.orm, teamId, ref).id);
}

function labelIds(ctx: ToolContext, projectId: string, refs: readonly string[] | undefined) {
  return refs?.map((ref) => resolveLabel(ctx.deps.db.orm, projectId, ref).id);
}

function taskIds(ctx: ToolContext, refs: readonly string[] | undefined) {
  return refs?.map((ref) => taskOf(ctx, ref).task.id);
}

function statusId(ctx: ToolContext, projectId: string, ref: string | undefined) {
  return ref === undefined ? undefined : resolveStatus(ctx.deps.db.orm, projectId, ref).id;
}

function priorityOf(value: z.infer<typeof priorityField> | undefined) {
  return value === undefined ? undefined : parseToolInput(priorityInputSchema, value, {});
}

type Change<T> = { set?: T[] | undefined; add?: T[] | undefined; remove?: T[] | undefined };

function mapChange<T, R>(value: Change<T> | undefined, map: (items: T[]) => R[] | undefined) {
  if (!value) return undefined;
  return {
    ...(value.set ? { set: map(value.set) } : {}),
    ...(value.add ? { add: map(value.add) } : {}),
    ...(value.remove ? { remove: map(value.remove) } : {}),
  };
}

/**
 * A card with a team-qualified `ref` (`team/KEY-12`, which keeps resolving when another of your
 * teams uses the same key), `teamSlug` and an absolute `url` instead of the relative `path`.
 */
function cardOut(ctx: ToolContext, card: TaskCard, teamSlug: string) {
  const { path, position: _position, ...rest } = card;
  return {
    ...rest,
    ref: qualifyRef(teamSlug, card.ref),
    teamSlug,
    blockers: card.blockers.map((ref) => qualifyRef(teamSlug, ref)),
    url: toAbsolute(ctx.deps, path),
  };
}

/** The full task with team-qualified refs and absolute URLs everywhere. */
function taskOut(ctx: ToolContext, task: Task) {
  const { path, position: _position, ...rest } = task;
  const linked = <T extends { ref: string; path: string }>({ path: p, ...item }: T) => ({
    ...item,
    ref: qualifyRef(task.teamSlug, item.ref),
    url: toAbsolute(ctx.deps, p),
  });
  return {
    ...rest,
    ref: qualifyRef(task.teamSlug, task.ref),
    blockers: task.blockers.map((ref) => qualifyRef(task.teamSlug, ref)),
    url: toAbsolute(ctx.deps, path),
    blockedBy: task.blockedBy.map(linked),
    blocking: task.blocking.map(linked),
    issues: task.issues.map(linked),
    attachments: withAbsoluteUrls(ctx.deps, task.attachments),
  };
}

/**
 * A list_tasks assignee filter value: `me`, `unassigned`, `@&slug` / `role:<name>` (a role), or a
 * member (username or id) or role (name, slug or id). A value naming both a member and a role is
 * ambiguous.
 */
function assigneeFilter(ctx: ToolContext, teamId: string, value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'me' || lower === 'unassigned') return lower;
  if (trimmed.startsWith('@&') || lower.startsWith('role:')) {
    return `role:${resolveRole(ctx.deps.db.orm, teamId, trimmed.replace(/^role:/i, '')).id}`;
  }
  const attempt = <T>(resolve: () => T): T | null => {
    try {
      return resolve();
    } catch (error) {
      if (isAppError(error) && error.code === 'not_found') return null;
      throw error;
    }
  };
  const user = attempt(() => resolveUser(ctx.deps, ctx.actor, trimmed, { teamId }));
  const role = trimmed.startsWith('@')
    ? null
    : attempt(() => resolveRole(ctx.deps.db.orm, teamId, trimmed));
  if (user && role) {
    const member = `@${user.username ?? user.id}`;
    throw errors.validation(
      `Assignee "${trimmed}" is both a member (${member}) and a role (${role.name}). Use "${member}" for the member or "@&${role.slug}" for the role`,
      { candidates: [member, `@&${role.slug}`] },
    );
  }
  if (user) return `user:${user.id}`;
  if (role) return `role:${role.id}`;
  throw errors.notFoundWith(
    `Assignee not found: "${trimmed}" is neither a member nor a role of this team. Pass me, unassigned, a username or a role name`,
    { ref: trimmed },
  );
}

/** A reply as get_task shows it: author, key, body, files and a link to the reply. */
function replyOut(ctx: ToolContext, taskPath: string, reply: Reply) {
  return {
    id: reply.id,
    parentReplyId: reply.parentReplyId,
    author: reply.author?.username ?? null,
    via: reply.via?.keyName ?? null,
    body: reply.body,
    attachments: withAbsoluteUrls(ctx.deps, reply.attachments),
    url: toAbsolute(ctx.deps, appPaths.reply(taskPath, reply.id)),
    createdAt: reply.createdAt,
    editedAt: reply.editedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

const listTasksTool = defineTool({
  name: 'list_tasks',
  title: 'List tasks',
  description:
    'Tasks of a project with the board/list filters: text, status, assignee (me = you or your roles, unassigned, a username, a role), label, priority, due (overdue/today/week/none), claimed (yes/no/mine) and blocked (yes/no). Each task has its ref (KEY-12), status, priority (0 none … 4 urgent), due date, labels, assignees, claim (who is working on it, via which key, until when), blocked flag and URL. To pick work, prefer claim_next_task.',
  input: toolInput({
    project: projectRef,
    query: z
      .string()
      .max(LIMITS.searchQuery.max)
      .optional()
      .describe('Words in the title or description, or a number/ref'),
    status: z
      .array(statusRef)
      .max(TASK_LIMITS.filterValues)
      .optional()
      .describe('Only these statuses (names or ids)'),
    assignee: z
      .array(z.string().min(1))
      .max(TASK_LIMITS.filterValues)
      .optional()
      .describe(
        'Any of: "me" (you or your roles), "unassigned", a username, or a role (its name, or @&slug)',
      ),
    label: labelNames.optional().describe('Only tasks with any of these labels'),
    priority: z.array(priorityField).max(5).optional().describe('Only these priorities'),
    due: z.enum(TASK_DUE_FILTERS).optional().describe('overdue, today, week (next 7 days) or none'),
    today: dueDateSchema
      .optional()
      .describe(
        "Your local date as YYYY-MM-DD, used by the due filter to decide what is overdue, due today or this week (due dates have no time zone). Default: today's date in UTC",
      ),
    claimed: z.enum(TASK_CLAIM_FILTERS).optional().describe('yes, no, or mine (claimed by you)'),
    blocked: z
      .enum(TASK_BLOCKED_FILTERS)
      .optional()
      .describe('yes: waiting for an open blocker; no: ready'),
    sort: z.enum(TASK_SORTS).default('status').describe('Order (status = board order)'),
    order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
    limit: z.number().int().min(1).max(TASK_LIMITS.listPage).default(50).describe('Page size'),
    cursor: z.string().optional().describe('nextCursor from a previous call'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { project, team } = projectOf(ctx, input.project);
    const assignee = input.assignee?.map((value) => assigneeFilter(ctx, team.id, value));
    const query = parseToolInput(
      listTasksQuerySchema,
      {
        q: input.query,
        status: input.status?.map((ref) => statusId(ctx, project.id, ref)).join(','),
        assignee: assignee?.join(','),
        label: labelIds(ctx, project.id, input.label)?.join(','),
        priority: input.priority?.map((value) => String(priorityOf(value))).join(','),
        due: input.due,
        today: input.today,
        claimed: input.claimed,
        blocked: input.blocked,
        sort: input.sort,
        order: input.order,
        limit: input.limit,
        cursor: input.cursor,
      },
      TASK_FIELD_NAMES,
    );
    const page = listTasks(ctx.deps, ctx.actor, project.id, query);
    return {
      tasks: page.items.map((card) => cardOut(ctx, card, team.slug)),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  },
});

const HISTORY_SHOWN = 20;
const REPLIES_SHOWN = 20;

const getTaskTool = defineTool({
  name: 'get_task',
  title: 'Get task',
  description:
    'Full context of a task before you work on it: description (markdown), status, priority, due date, assignees, labels, blockers (blockedBy) and tasks waiting for it (blocking) with their statuses, linked issues (fixes/relates), the claim (holder, key, expiry), attachments, the latest 20 replies, each with parentReplyId (the reply it answers, null for a top-level comment) (replyCount says how many there are; list_replies pages through them all) and the latest 20 history entries (get_activity pages through all of them).',
  input: toolInput({ task: taskRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { task } = taskOf(ctx, input.task);
    const full = getTask(ctx.deps, ctx.actor, task.id);
    const replies = listReplyPage(ctx.deps, ctx.actor, {
      parentType: 'task',
      parentId: task.id,
      limit: REPLIES_SHOWN,
      order: 'desc',
    });
    const history = listEntityActivity(ctx.deps, ctx.actor, {
      entityType: 'task',
      entityId: task.id,
    }).items;
    return {
      ...taskOut(ctx, full),
      replyCount: replies.total,
      recentReplies: replies.items.reverse().map((reply) => replyOut(ctx, full.path, reply)),
      recentHistory: history.slice(-HISTORY_SHOWN).map((entry) => ({
        action: entry.action,
        actor: entry.actor.user?.username ?? (entry.actor.source === 'system' ? 'system' : null),
        via: entry.actor.via?.keyName ?? null,
        changes: entry.changes,
        createdAt: entry.createdAt,
      })),
    };
  },
});

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

const createTaskTool = defineTool({
  name: 'create_task',
  title: 'Create task',
  description:
    'Creates a task in a project (needs CREATE_TASKS). It goes to the default status (or `status`) at the end of its column and gets the next number (KEY-n). Assignees (members and roles) are notified, @mentions in the description too; you and the assigned members are subscribed to replies.',
  input: toolInput({
    project: projectRef,
    title: z.string().min(1).max(LIMITS.title.max).describe('Short title'),
    description: z
      .string()
      .max(LIMITS.body.max)
      .optional()
      .describe('Markdown; mention people with @username and roles with @&role-slug'),
    status: statusRef.optional().describe('Initial status (default: the project default)'),
    priority: priorityField.optional(),
    dueDate: dueDateField.optional(),
    assignees: usernames.optional(),
    assigneeRoles: roleNames.optional(),
    labels: labelNames.optional(),
    blockedBy: taskRefs.optional().describe('Tasks of the same project this one waits for'),
    issues: z
      .array(issueLinkField)
      .max(TASK_LIMITS.issueLinks)
      .optional()
      .describe('Issues this task addresses'),
    attachmentIds: z
      .array(z.string())
      .max(LIMITS.attachmentsPerItem)
      .optional()
      .describe('Ids from upload_attachment (pending uploads) to attach'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { project, team } = projectOf(ctx, input.project);
    const data = parseToolInput(
      createTaskInputSchema,
      {
        title: input.title,
        description: input.description,
        statusId: statusId(ctx, project.id, input.status),
        priority: priorityOf(input.priority),
        dueDate: input.dueDate,
        assigneeUserIds: userIds(ctx, team.id, input.assignees),
        assigneeRoleIds: roleIds(ctx, team.id, input.assigneeRoles),
        labelIds: labelIds(ctx, project.id, input.labels),
        blockedByTaskIds: taskIds(ctx, input.blockedBy),
        issueLinks: input.issues?.map((link) => ({
          issueId: resolveIssue(ctx.deps, ctx.actor, link.issue).issue.id,
          kind: link.kind,
        })),
        attachmentIds: input.attachmentIds,
      },
      TASK_FIELD_NAMES,
    );
    return taskOut(ctx, createTask(ctx.deps, ctx.actor, project.id, data));
  },
});

const updateTaskTool = defineTool({
  name: 'update_task',
  title: 'Update task',
  description:
    'Changes any field of a task. Lists (assignees, assigneeRoles, labels, blockedBy, issues) take {set} or {add, remove}. Title and description need to be the author or EDIT_ANY_CONTENT; the rest the author or UPDATE_TASKS. A new status puts the task at the end of that column (use move_task to place it exactly); entering a done status resolves the issues it fixes, notifies the author and assignees and releases the claim. Your writes renew your claim.',
  input: toolInput({
    task: taskRef,
    title: z.string().min(1).max(LIMITS.title.max).optional().describe('New title'),
    description: z
      .string()
      .max(LIMITS.body.max)
      .optional()
      .describe('New description (markdown, replaces the old one)'),
    status: statusRef.optional().describe('New status'),
    priority: priorityField.optional(),
    dueDate: dueDateField
      .nullable()
      .optional()
      .describe('Due date YYYY-MM-DD, or null to clear it'),
    assignees: listChange(z.string().min(1), 'Assigned members (usernames or ids)').optional(),
    assigneeRoles: listChange(z.string().min(1), 'Assigned roles (names, slugs or ids)').optional(),
    labels: listChange(z.string().min(1), 'Labels (names or ids)').optional(),
    blockedBy: listChange(
      z.string().min(1),
      'Blocking tasks of the same project (KEY-12)',
    ).optional(),
    issues: toolInput({
      set: z.array(issueLinkField).optional().describe('Replace every link'),
      add: z.array(issueLinkField).optional().describe('Link these (or change their kind)'),
      remove: z.array(z.string().min(1)).optional().describe('Unlink these issues (KEY#51)'),
    })
      .optional()
      .describe('Issues this task addresses. Pass set, or add and/or remove.'),
    attachmentIds: z
      .array(z.string())
      .max(LIMITS.attachmentsPerItem)
      .optional()
      .describe('Pending uploads (from upload_attachment) to attach'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project, team } = taskOf(ctx, input.task);
    const issueLink = (link: z.infer<typeof issueLinkField>) => ({
      issueId: resolveIssue(ctx.deps, ctx.actor, link.issue).issue.id,
      kind: link.kind,
    });
    const data = parseToolInput(
      updateTaskInputSchema,
      {
        title: input.title,
        description: input.description,
        statusId: statusId(ctx, project.id, input.status),
        priority: priorityOf(input.priority),
        dueDate: input.dueDate,
        assigneeUsers: mapChange(input.assignees, (refs) => userIds(ctx, team.id, refs)),
        assigneeRoles: mapChange(input.assigneeRoles, (refs) => roleIds(ctx, team.id, refs)),
        labels: mapChange(input.labels, (refs) => labelIds(ctx, project.id, refs)),
        blockedBy: mapChange(input.blockedBy, (refs) => taskIds(ctx, refs)),
        issueLinks: input.issues
          ? {
              ...(input.issues.set ? { set: input.issues.set.map(issueLink) } : {}),
              ...(input.issues.add ? { add: input.issues.add.map(issueLink) } : {}),
              ...(input.issues.remove
                ? {
                    remove: input.issues.remove.map(
                      (ref) => resolveIssue(ctx.deps, ctx.actor, ref).issue.id,
                    ),
                  }
                : {}),
            }
          : undefined,
        attachmentIds: input.attachmentIds,
      },
      TASK_FIELD_NAMES,
    );
    return taskOut(ctx, updateTask(ctx.deps, ctx.actor, task.id, data));
  },
});

const moveTaskTool = defineTool({
  name: 'move_task',
  title: 'Move task',
  description:
    'Moves a task to another status and/or position on the board: right after `after`, right before `before`, or (neither) to the end of the column. Moving into a done status marks it finished: it resolves the issues it fixes, notifies the author and assignees, and releases your claim — the usual last step of your work.',
  input: toolInput({
    task: taskRef,
    status: statusRef.optional().describe('Target status (default: the current one)'),
    after: z
      .string()
      .optional()
      .describe('Place right after this task (KEY-12) of the target column'),
    before: z
      .string()
      .optional()
      .describe('Place right before this task (KEY-12) of the target column'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project } = taskOf(ctx, input.task);
    return taskOut(
      ctx,
      moveTask(ctx.deps, ctx.actor, task.id, {
        statusId: statusId(ctx, project.id, input.status),
        afterId: input.after ? taskOf(ctx, input.after).task.id : undefined,
        beforeId: input.before ? taskOf(ctx, input.before).task.id : undefined,
      }),
    );
  },
});

const deleteTaskTool = defineTool({
  name: 'delete_task',
  title: 'Delete task',
  description:
    'Moves a task to Trash (author, or DELETE_ANY_CONTENT). It can be restored for 30 days with restore_task.',
  input: toolInput({ task: taskRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const { task, project, team } = taskOf(ctx, input.task);
    deleteTask(ctx.deps, ctx.actor, task.id);
    return {
      ok: true,
      ref: formatTaskRef(project.key, task.number, team.slug),
      restoreWith: 'restore_task',
    };
  },
});

const restoreTaskTool = defineTool({
  name: 'restore_task',
  title: 'Restore task',
  description:
    'Restores a deleted task from Trash (author, or MANAGE_TRASH) at its old place on the board.',
  input: toolInput({
    task: z.string().min(1).describe('Deleted task: KEY-12, team-slug/KEY-12, or id'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const ref = resolveTrashRef(ctx.deps, ctx.actor, { item: input.task, type: 'task' });
    return taskOut(ctx, restoreTask(ctx.deps, ctx.actor, ref.id));
  },
});

const createFromIssueTool = defineTool({
  name: 'create_task_from_issue',
  title: 'Create task from issue',
  description:
    "Turns an issue into a task: the issue's title, a link back to the issue plus its body as the description, its labels, and a `fixes` link (finishing the task resolves the issue; a `relates` link if you may not resolve the issue).",
  input: toolInput({
    issue: z.string().min(1).describe('Issue: KEY#51, team-slug/KEY#51, or issue id'),
    project: projectRef.optional().describe("Project for the task (default: the issue's project)"),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { issue, project: issueProject } = resolveIssue(ctx.deps, ctx.actor, input.issue);
    const project = input.project ? projectOf(ctx, input.project).project : issueProject;
    return taskOut(
      ctx,
      createTaskFromIssue(ctx.deps, ctx.actor, project.id, { issueId: issue.id }),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

const claimNextTool = defineTool({
  name: 'claim_next_task',
  title: 'Claim next task',
  description:
    'Start here to pick up work. Atomically claims the best task you can work on in a project: open status, not blocked, not claimed by anyone else, matching the optional filters. Tasks assigned to you or your roles come first, then unassigned ones; then higher priority, earlier due date, lower number. Returns the full task (read its description, then work; post progress with add_reply; finish with move_task to a done status, which releases the claim) or task: null when nothing is eligible. The claim is held by you through this key; it lasts leaseMinutes and every write you make on the task (updates, replies) renews it — call renew_claim during long silent work, release_task if you stop.',
  input: toolInput({
    project: projectRef,
    role: z.string().optional().describe('Only tasks assigned to this role (name, slug or id)'),
    label: z.string().optional().describe('Only tasks with this label (name or id)'),
    priority: z
      .array(priorityField)
      .min(1)
      .max(5)
      .optional()
      .describe('Only these priorities, e.g. ["urgent","high"]'),
    assignedToMe: z
      .boolean()
      .optional()
      .describe('Only tasks assigned to you or one of your roles'),
    moveToStatus: statusRef
      .optional()
      .describe('Move the claimed task to this open status, e.g. "In Progress"'),
    leaseMinutes: leaseField.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { project, team } = projectOf(ctx, input.project);
    const data = parseToolInput(
      claimNextTaskInputSchema,
      {
        roleId: input.role ? resolveRole(ctx.deps.db.orm, team.id, input.role).id : undefined,
        labelId: input.label
          ? resolveLabel(ctx.deps.db.orm, project.id, input.label).id
          : undefined,
        priority: input.priority?.map((value) => priorityOf(value)),
        assignedToMe: input.assignedToMe,
        moveToStatusId: statusId(ctx, project.id, input.moveToStatus),
        leaseMinutes: input.leaseMinutes,
      },
      TASK_FIELD_NAMES,
    );
    const { task } = claimNextTask(ctx.deps, ctx.actor, project.id, data);
    if (!task) {
      return {
        task: null,
        message:
          'No task is eligible right now (every open task is blocked, claimed, or filtered out). Try other filters, or list_tasks to see the board.',
      };
    }
    return { task: taskOut(ctx, task) };
  },
});

const claimTaskTool = defineTool({
  name: 'claim_task',
  title: 'Claim task',
  description:
    'Claims a specific task (needs UPDATE_TASKS or being its author), telling everyone you are working on it. Claiming a task you already hold renews it. If someone else holds a valid claim it fails with who holds it, unless force: true, which takes the claim over (UPDATE_TASKS; audited as a takeover) — only do that when the holder has clearly stopped. A task in a done status must be moved to an open status (moveToStatus) to be claimed.',
  input: toolInput({
    task: taskRef,
    force: z.boolean().optional().describe("Take over someone else's claim"),
    moveToStatus: statusRef
      .optional()
      .describe('Move the task to this open status, e.g. "In Progress"'),
    leaseMinutes: leaseField.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project } = taskOf(ctx, input.task);
    return taskOut(
      ctx,
      claimTask(ctx.deps, ctx.actor, task.id, {
        force: input.force,
        moveToStatusId: statusId(ctx, project.id, input.moveToStatus),
        leaseMinutes: input.leaseMinutes,
      }),
    );
  },
});

const renewClaimTool = defineTool({
  name: 'renew_claim',
  title: 'Renew claim',
  description:
    'Extends your claim on a task to a full lease from now (the same length as before unless leaseMinutes is given). Writes on the task renew it too, so call this only during long stretches without updates or replies. Fails if you do not hold the claim.',
  input: toolInput({ task: taskRef, leaseMinutes: leaseField.optional() }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const { task } = taskOf(ctx, input.task);
    return taskOut(
      ctx,
      renewClaim(ctx.deps, ctx.actor, task.id, { leaseMinutes: input.leaseMinutes }),
    );
  },
});

const releaseTaskTool = defineTool({
  name: 'release_task',
  title: 'Release task',
  description:
    "Releases your claim so someone else can pick the task up (e.g. you are stopping before it is done). Add a note on what was done and what is left: it is posted as a reply. Not needed after moving the task to a done status, which releases it automatically. Releasing someone else's claim needs UPDATE_TASKS.",
  input: toolInput({
    task: taskRef,
    note: z
      .string()
      .max(LIMITS.releaseNote.max)
      .optional()
      .describe('Handoff note (markdown), posted as a reply'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task } = taskOf(ctx, input.task);
    return taskOut(ctx, releaseTask(ctx.deps, ctx.actor, task.id, { note: input.note }));
  },
});

/** Tasks tools in catalog order. */
export const tasksTools: McpTool[] = [
  listTasksTool,
  getTaskTool,
  createTaskTool,
  updateTaskTool,
  moveTaskTool,
  deleteTaskTool,
  restoreTaskTool,
  createFromIssueTool,
  claimNextTool,
  claimTaskTool,
  renewClaimTool,
  releaseTaskTool,
];
