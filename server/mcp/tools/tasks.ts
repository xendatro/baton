import { z } from 'zod';
import { CLAIM_LEASE, ISSUE_LINK_KINDS, LIMITS, PRIORITY_KEYS } from '@shared/constants';
import { formatTaskRef } from '@shared/refs';
import { dueDateSchema } from '@shared/schemas/common';
import {
  claimNextTaskInputSchema,
  createTaskInputSchema,
  listTasksQuerySchema,
  moveTaskInputSchema,
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
import { APPROVAL_DECISIONS, PIPELINE_LIMITS } from '@shared/schemas/pipelines';
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
import { decideApproval } from '../../services/pipelines';
import { pipelineIdOfStatus, resolvePipeline } from '../../services/projectPipelines';
import { listReplyPage } from '../../services/replies';
import { listStatuses } from '../../services/statuses';
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
import { resolveDifficulty } from '../../services/difficulties';

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
const statusRef = z
  .string()
  .min(1)
  .describe(
    'Status name (case-insensitive; the task’s own pipeline first), Pipeline/Status, or id',
  );
const pipelineRef = z
  .string()
  .min(1)
  .describe('Pipeline name (case-insensitive), slug or id (list_pipelines)');
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
const evidenceField = z
  .array(
    toolInput({
      criterion: z.string().min(1).describe("The criterion's id (get_task stage.criteria[].id)"),
      text: z
        .string()
        .max(PIPELINE_LIMITS.evidence)
        .describe('What you did to meet it: a summary, a link, test output ("" removes it)'),
    }),
  )
  .max(PIPELINE_LIMITS.criteria)
  .describe(
    "Evidence for the current stage's exit criteria, one entry per criterion. Saved even when the move is still blocked",
  );

/** The tools' evidence list as the services take it (criterion id → text). */
function evidenceOf(list: Array<{ criterion: string; text: string }> | undefined) {
  return list ? Object.fromEntries(list.map((item) => [item.criterion, item.text])) : undefined;
}
const forceField = z
  .boolean()
  .describe(
    'Team owner or administrator only: move past the stage rules (needs reason; audited). Never use it to skip a review',
  );
const reasonField = z
  .string()
  .max(PIPELINE_LIMITS.reason)
  .describe('Why: required to send the task back to an earlier stage, and to force a move');
const leaseField = z
  .number()
  .int()
  .min(CLAIM_LEASE.minMinutes)
  .max(CLAIM_LEASE.maxMinutes)
  .describe(
    `Ignored: claims no longer expire (kept so older calls still work; ${CLAIM_LEASE.minMinutes}–${CLAIM_LEASE.maxMinutes})`,
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
  difficultyId: 'difficulty',
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

/** A status id by ref; names prefer stages of `pipelineId` (the task's pipeline, BAT-25). */
function statusId(
  ctx: ToolContext,
  projectId: string,
  ref: string | undefined,
  pipelineId?: string,
) {
  return ref === undefined
    ? undefined
    : resolveStatus(ctx.deps.db.orm, projectId, ref, { pipelineId }).id;
}

/** The pipeline a task's status belongs to. */
function pipelineOfTask(ctx: ToolContext, task: { statusId: string }): string | undefined {
  return pipelineIdOfStatus(ctx.deps.db.orm, task.statusId);
}

function pipelineId(ctx: ToolContext, projectId: string, ref: string | undefined) {
  return ref === undefined ? undefined : resolvePipeline(ctx.deps.db.orm, projectId, ref).id;
}

/** A difficulty level ref as its id (null: none; undefined: not given). */
function difficultyIdOf(ctx: ToolContext, projectId: string, ref: string | null | undefined) {
  if (ref === undefined) return undefined;
  return ref === null ? null : resolveDifficulty(ctx.deps.db.orm, projectId, ref).id;
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

/** The stage with blocked moves keyed by status name (agents move by name). */
function stageOut(ctx: ToolContext, task: Task) {
  const { stage } = task;
  if (!stage) return {};
  const names = new Map(
    listStatuses(ctx.deps, ctx.actor, task.projectId).items.map((status) => [
      status.id,
      status.name,
    ]),
  );
  const blockedMoves = Object.fromEntries(
    Object.entries(stage.blockedMoves).map(([id, reason]) => [names.get(id) ?? id, reason]),
  );
  return { stage: { ...stage, blockedMoves } };
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
    ...stageOut(ctx, task),
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
    pipeline: pipelineRef.optional().describe('Only tasks of this pipeline'),
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
    const pipeline = pipelineId(ctx, project.id, input.pipeline);
    const query = parseToolInput(
      listTasksQuerySchema,
      {
        q: input.query,
        pipeline,
        status: input.status?.map((ref) => statusId(ctx, project.id, ref, pipeline)).join(','),
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
    "Full context of a task before you work on it: description (markdown), status, priority, due date, assignees, labels, blockers (blockedBy) and tasks waiting for it (blocking) with their statuses, linked issues (fixes/relates), the claim (holder, key, expiry), attachments, the latest 20 replies, each with parentReplyId (the reply it answers, null for a top-level comment) (replyCount says how many there are; list_replies pages through them all) and the latest 20 history entries (get_activity pages through all of them). When the project has a pipeline, `stage` tells you what to do: the stage's instructions, its exit criteria with the evidence given so far, approvals (given, required, whether you may approve), `missing` (what still blocks moving on), `next` (the stage it moves on to), `canMoveTo` ({ forward: { id, name, missing[] } | null, back: [{ id, name }] }: the only moves you can make — forward to the next stage, or back to one of `back` with a reason), `returnReason` (why it was sent back to this stage: deal with it first), `blockedMoves` (why other statuses are refused), `pool` (claim it with claim_task), `visits` (its stage history) and `previousApprovals` (what reviewers approved or asked for in earlier stages and visits, with their comments: follow them).",
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
    pipeline: pipelineRef
      .optional()
      .describe('Pipeline it starts in (default: the project’s default pipeline)'),
    status: statusRef
      .optional()
      .describe('Initial status (default: the default status of its pipeline)'),
    priority: priorityField.optional(),
    dueDate: dueDateField.optional(),
    assignees: usernames.optional(),
    assigneeRoles: roleNames.optional(),
    labels: labelNames.optional(),
    difficulty: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Difficulty level of the project (e.g. Easy, Normal, Hard); picks the model agents run',
      ),
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
        pipelineId: pipelineId(ctx, project.id, input.pipeline),
        statusId: statusId(
          ctx,
          project.id,
          input.status,
          pipelineId(ctx, project.id, input.pipeline),
        ),
        priority: priorityOf(input.priority),
        dueDate: input.dueDate,
        assigneeUserIds: userIds(ctx, team.id, input.assignees),
        assigneeRoleIds: roleIds(ctx, team.id, input.assigneeRoles),
        labelIds: labelIds(ctx, project.id, input.labels),
        difficultyId: input.difficulty
          ? resolveDifficulty(ctx.deps.db.orm, project.id, input.difficulty).id
          : undefined,
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
    'Changes any field of a task. Lists (assignees, assigneeRoles, labels, blockedBy, issues) take {set} or {add, remove}. Title and description need to be the author or EDIT_ANY_CONTENT; the rest the author or UPDATE_TASKS. A new status puts the task at the end of that column (use move_task to place it exactly) and applies that stage’s rules (its hand-off decides the assignees there; onEnter may resolve the issues it fixes, notify the author and release the claim). Assignees are those of the task’s current stage; setting them together with a new status makes them the new stage’s assignees.',
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
    difficulty: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Difficulty level (name), or null to clear it: of the current stage, or with `status` of the stage it moves to',
      ),
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
    evidence: evidenceField.optional(),
    force: forceField.optional(),
    reason: reasonField.optional(),
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
        statusId: statusId(ctx, project.id, input.status, pipelineOfTask(ctx, task)),
        priority: priorityOf(input.priority),
        dueDate: input.dueDate,
        assigneeUsers: mapChange(input.assignees, (refs) => userIds(ctx, team.id, refs)),
        assigneeRoles: mapChange(input.assigneeRoles, (refs) => roleIds(ctx, team.id, refs)),
        labels: mapChange(input.labels, (refs) => labelIds(ctx, project.id, refs)),
        difficultyId:
          input.difficulty === undefined
            ? undefined
            : input.difficulty === null
              ? null
              : resolveDifficulty(ctx.deps.db.orm, project.id, input.difficulty).id,
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
        evidence: evidenceOf(input.evidence),
        force: input.force,
        reason: input.reason,
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
    "Moves a task to another status and/or position on the board: right after `after`, right before `before`, or (neither) to the end of the column. Entering a stage applies its rules: the hand-off decides who is assigned there (a finishing stage usually assigns nobody), and onEnter may resolve the issues it fixes, notify the author and release your claim — moving to such a stage (see list_statuses) is the usual last step of your work. Moves are strict: forward only to the stage's next stage (get_task's canMoveTo.forward), which needs its exit criteria met (pass `evidence`), its approvals and the right mover — a refused move says exactly what is missing; stages can't be skipped. Back only to the earlier stages the stage allows (canMoveTo.back), and a move back needs a `reason` (posted on the task and given to whoever works on it next). Passing only `evidence` saves it without moving. A status of another pipeline (Pipeline/Status) moves the task to that pipeline: you need to be allowed to move it on from its stage and to create tasks there; its exit criteria and approvals don't apply.",
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
    evidence: evidenceField.optional(),
    difficulty: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Difficulty (level name or id; null: none) for the stage it moves to, instead of the default (its last difficulty there, else the stage’s default, else the current one)',
      ),
    force: forceField.optional(),
    reason: reasonField
      .optional()
      .describe(
        'Required to send the task back to an earlier stage (what has to change), and to force a move',
      ),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project } = taskOf(ctx, input.task);
    const data = parseToolInput(
      moveTaskInputSchema,
      {
        statusId: statusId(ctx, project.id, input.status, pipelineOfTask(ctx, task)),
        afterId: input.after ? taskOf(ctx, input.after).task.id : undefined,
        beforeId: input.before ? taskOf(ctx, input.before).task.id : undefined,
        evidence: evidenceOf(input.evidence),
        difficultyId: difficultyIdOf(ctx, project.id, input.difficulty),
        force: input.force,
        reason: input.reason,
      },
      TASK_FIELD_NAMES,
    );
    return taskOut(ctx, moveTask(ctx.deps, ctx.actor, task.id, data));
  },
});

const approveTaskTool = defineTool({
  name: 'approve_task',
  title: 'Approve task',
  description:
    "Approves the task's current pipeline stage, or requests changes (decision: request_changes, or changes), with a comment shown in the task's history. Only the people and agents the stage names as approvers may do it (get_task's stage.approvals.canApprove); each counts once, and a new decision replaces your previous one. Requesting changes sends the task back to one of the stage's send-back stages (`sendBackTo`, default the nearest; see get_task's canMoveTo.back) with your comment as the reason, so the comment is required then. When the last needed approval arrives and the stage auto-advances, the task moves on.",
  input: toolInput({
    task: taskRef,
    decision: z
      .enum([...APPROVAL_DECISIONS, 'changes'])
      .describe('approve, or request_changes / changes (explain what to change in comment)'),
    comment: z
      .string()
      .max(PIPELINE_LIMITS.comment)
      .optional()
      .describe(
        'Why: what you checked, or what has to change (required when requesting changes sends the task back: it is the reason)',
      ),
    sendBackTo: statusRef
      .optional()
      .describe(
        'Request changes: the earlier stage to send it back to (default: the nearest one it may go back to)',
      ),
    difficulty: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Request changes: the difficulty (level name or id; null: none) for the stage it goes back to, e.g. Hard after a failed review',
      ),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project } = taskOf(ctx, input.task);
    return taskOut(
      ctx,
      decideApproval(ctx.deps, ctx.actor, task.id, {
        decision: input.decision === 'changes' ? 'request_changes' : input.decision,
        comment: input.comment,
        sendBackTo: statusId(ctx, project.id, input.sendBackTo, pipelineOfTask(ctx, task)),
        difficultyId: difficultyIdOf(ctx, project.id, input.difficulty),
      }),
    );
  },
});

const deleteTaskTool = defineTool({
  name: 'delete_task',
  title: 'Delete task',
  description:
    'Moves a task to Trash (author, or DELETE_ANY_CONTENT). Its claim is released, agent jobs about it are cancelled and it stops blocking other tasks. It can be restored for 30 days with restore_task.',
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
    'Start here to pick up work. Atomically claims the best task you can work on in a project: in a claimable stage, not blocked, not claimed by anyone else, matching the optional filters. Tasks assigned to you or your roles (in their current stage) come first, then unassigned ones; then higher priority, earlier due date, lower number. Returns the full task (read its description, then work; post progress with add_reply; finish with move_task to the next stage, e.g. one that releases the claim) or task: null when nothing is eligible. The claim is held by you through this key until you release it (release_task), finish the task, or someone takes it over; claims do not expire.',
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
      .describe('Move the claimed task to this claimable stage, e.g. "In Progress"'),
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
    "Claims a specific task (needs UPDATE_TASKS or being its author), telling everyone you are working on it. Claiming a task you already hold renews it. If someone else holds a valid claim it fails with who holds it, unless force: true, which takes the claim over (UPDATE_TASKS; audited as a takeover) — only do that when the holder has clearly stopped. A task in a stage that isn't claimable (e.g. Done) must be moved to one that is (moveToStatus) to be claimed. A task waiting in a pipeline stage's pool (get_task's stage.pool) can be claimed by the pool's members only, and claiming assigns it to you.",
  input: toolInput({
    task: taskRef,
    force: z.boolean().optional().describe("Take over someone else's claim"),
    moveToStatus: statusRef
      .optional()
      .describe('Move the task to this claimable stage, e.g. "In Progress"'),
    leaseMinutes: leaseField.optional(),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const { task, project } = taskOf(ctx, input.task);
    return taskOut(
      ctx,
      claimTask(ctx.deps, ctx.actor, task.id, {
        force: input.force,
        moveToStatusId: statusId(ctx, project.id, input.moveToStatus, pipelineOfTask(ctx, task)),
        leaseMinutes: input.leaseMinutes,
      }),
    );
  },
});

const renewClaimTool = defineTool({
  name: 'renew_claim',
  title: 'Renew claim',
  description:
    'Deprecated: claims no longer expire, so there is nothing to renew. Confirms you still hold the claim (fails if you do not).',
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
    "Releases your claim so someone else can pick the task up (e.g. you are stopping before it is done). Add a note on what was done and what is left: it is posted as a reply. Not needed after moving the task to a stage that releases claims (onEnter.releaseClaim). Releasing someone else's claim needs UPDATE_TASKS.",
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
  approveTaskTool,
  deleteTaskTool,
  restoreTaskTool,
  createFromIssueTool,
  claimNextTool,
  claimTaskTool,
  renewClaimTool,
  releaseTaskTool,
];
