import { z } from 'zod';
import { LIMITS } from '@shared/constants';
import type { ActivityEntry, Attachment } from '@shared/schemas/core';
import {
  createIssueInputSchema,
  ISSUE_SORTS,
  ISSUE_STATES,
  LABEL_MATCHES,
  listIssuesQuerySchema,
  updateIssueInputSchema,
  type Issue,
  type IssueSummary,
} from '@shared/schemas/issues';
import { parseInput } from '../../lib/validate';
import { listEntityActivity } from '../../services/activity';
import { resolveTrashRef } from '../../services/admin';
import {
  createIssue,
  deleteIssue,
  getIssue,
  listIssues,
  reopenIssue,
  resolveIssue,
  restoreIssue,
  updateIssue,
} from '../../services/issues';
import {
  resolveIssue as resolveIssueRef,
  resolveLabel,
  resolveProject,
  resolveUser,
} from '../../services/refs';
import { listReplies } from '../../services/replies';
import { toAbsolute, withAbsoluteUrls } from '../util';
import { defineTool, type McpTool, type ToolContext } from './define';

/**
 * Issue MCP tools (SPEC §5.1 [issues]): list, read, open, edit, label, resolve/reopen, delete and
 * restore issues. Handlers resolve refs (`KEY#51`, `team-slug/KEY#51`, ids; labels by name;
 * authors by username), validate with the shared schemas and call the same services as REST.
 */

const issueRef = z
  .string()
  .min(1)
  .describe('Issue: KEY#51, team-slug/KEY#51 (when the key is ambiguous), or the issue id');

const projectRef = z
  .string()
  .min(1)
  .describe('Project: KEY (if unambiguous across your teams), team-slug/KEY, or project id');

const labelNames = (what: string) =>
  z
    .array(z.string().min(1))
    .max(LIMITS.bulkIds)
    .describe(`${what}: label names (case-insensitive) or ids of the issue's project`);

const attachmentIdsField = z
  .array(z.string())
  .max(LIMITS.attachmentsPerItem)
  .describe(
    'Ids of your pending uploads (from upload_attachment without a parent) to attach to the issue',
  );

/** Replaces relative paths and download URLs with absolute URLs, as MCP entities carry. */
function summaryForAgent(ctx: ToolContext, issue: IssueSummary) {
  const { path, ...rest } = issue;
  return { ...rest, url: toAbsolute(ctx.deps, path) };
}

function attachmentsForAgent(ctx: ToolContext, attachments: readonly Attachment[]) {
  return withAbsoluteUrls(ctx.deps, attachments);
}

function issueForAgent(ctx: ToolContext, issue: Issue) {
  const { path, attachments, linkedTasks, ...rest } = issue;
  return {
    ...rest,
    url: toAbsolute(ctx.deps, path),
    attachments: attachmentsForAgent(ctx, attachments),
    linkedTasks: linkedTasks.map(({ path: taskPath, ...task }) => ({
      ...task,
      url: toAbsolute(ctx.deps, taskPath),
    })),
  };
}

/** One line per history entry: who, through which key, what changed. */
function historyForAgent(entries: readonly ActivityEntry[]) {
  return entries.map((entry) => ({
    at: entry.createdAt,
    actor: entry.actor.user?.username ?? null,
    via: entry.actor.via?.keyName ?? null,
    action: entry.action,
    ...(Object.keys(entry.changes).length > 0 ? { changes: entry.changes } : {}),
  }));
}

function issueId(ctx: ToolContext, ref: string): string {
  return resolveIssueRef(ctx.deps, ctx.actor, ref).issue.id;
}

function labelIds(ctx: ToolContext, projectId: string, refs: readonly string[] | undefined) {
  return refs?.map((ref) => resolveLabel(ctx.deps.db.orm, projectId, ref).id);
}

const HISTORY_LIMIT = 30;

const listIssuesTool = defineTool({
  name: 'list_issues',
  title: 'List issues',
  description:
    'Issues of a project, like a forum or GitHub issues: open (default), resolved or all, filtered by labels, author and text, sorted by latest activity (default), newest, oldest or most replies. Returns one page with nextCursor, plus how many issues match each state. Use get_issue for the body and replies.',
  input: z.object({
    project: projectRef,
    state: z.enum(ISSUE_STATES).optional().describe('open (default), resolved or all'),
    labels: labelNames('Only issues with these labels').optional(),
    labelMatch: z
      .enum(LABEL_MATCHES)
      .optional()
      .describe('any (default): issues with any of the labels; all: issues with every label'),
    author: z.string().optional().describe('Only issues opened by this user (username or id)'),
    q: z
      .string()
      .max(LIMITS.searchQuery.max)
      .optional()
      .describe('Search titles, bodies and replies; "#12" finds issue 12'),
    sort: z
      .enum(ISSUE_SORTS)
      .optional()
      .describe('latest-activity (default), newest, oldest or most-replies'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
    cursor: z.string().optional().describe('nextCursor from the previous page'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const { project, team } = resolveProject(ctx.deps, ctx.actor, input.project);
    const query = parseInput(listIssuesQuerySchema, {
      state: input.state,
      labels: labelIds(ctx, project.id, input.labels)?.join(','),
      labelMatch: input.labelMatch,
      author: input.author
        ? resolveUser(ctx.deps, ctx.actor, input.author, { teamId: team.id }).id
        : undefined,
      q: input.q,
      sort: input.sort,
      limit: input.limit ?? 25,
      cursor: input.cursor,
    });
    const page = listIssues(ctx.deps, ctx.actor, project.id, query);
    return {
      issues: page.items.map((issue) => summaryForAgent(ctx, issue)),
      counts: page.counts,
      nextCursor: page.nextCursor,
    };
  },
});

const getIssueTool = defineTool({
  name: 'get_issue',
  title: 'Get issue',
  description:
    'Everything about an issue: title, markdown body, labels, author (and the key they used), resolved state, attachments, the tasks addressing it ("fixes" resolves it when the task is done), whether you are subscribed, every reply in order and a summary of its history.',
  input: z.object({ issue: issueRef }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const issue = getIssue(ctx.deps, ctx.actor, issueId(ctx, input.issue));
    const replies = listReplies(ctx.deps, ctx.actor, { parentType: 'issue', parentId: issue.id });
    const history = listEntityActivity(ctx.deps, ctx.actor, {
      entityType: 'issue',
      entityId: issue.id,
    });
    return {
      ...issueForAgent(ctx, issue),
      replies: replies.items.map((reply) => ({
        ...reply,
        attachments: attachmentsForAgent(ctx, reply.attachments),
      })),
      history: historyForAgent(history.items.slice(-HISTORY_LIMIT)),
    };
  },
});

const createIssueTool = defineTool({
  name: 'create_issue',
  title: 'Create issue',
  description:
    'Opens an issue in a project (needs CREATE_ISSUES). The body is markdown: @username and @&role mentions notify those members. You are subscribed to its replies. Returns the issue with its ref (KEY#n) and URL.',
  input: z.object({
    project: projectRef,
    title: z.string().min(1).max(LIMITS.title.max).describe('Short summary of the issue'),
    body: z
      .string()
      .max(LIMITS.body.max)
      .optional()
      .describe('Markdown body: context, steps to reproduce, expected and actual behaviour'),
    labels: labelNames('Labels to add').optional(),
    attachmentIds: attachmentIdsField.optional(),
  }),
  handler: (ctx, input) => {
    const { project } = resolveProject(ctx.deps, ctx.actor, input.project);
    const parsed = parseInput(createIssueInputSchema, {
      title: input.title,
      body: input.body,
      labelIds: labelIds(ctx, project.id, input.labels),
      attachmentIds: input.attachmentIds,
    });
    return issueForAgent(ctx, createIssue(ctx.deps, ctx.actor, project.id, parsed));
  },
});

const updateIssueTool = defineTool({
  name: 'update_issue',
  title: 'Update issue',
  description:
    'Edits an issue. Title and body: the author or EDIT_ANY_CONTENT (the body replaces the whole markdown; new mentions notify). Labels: the author or RESOLVE_ISSUES; pass labels to replace the set, or addLabels/removeLabels to change it. Pass only what changes.',
  input: z.object({
    issue: issueRef,
    title: z.string().max(LIMITS.title.max).optional().describe('New title'),
    body: z
      .string()
      .max(LIMITS.body.max)
      .optional()
      .describe('New markdown body (replaces the whole body)'),
    labels: labelNames('Replace every label with these (empty array clears them)').optional(),
    addLabels: labelNames('Labels to add').optional(),
    removeLabels: labelNames('Labels to remove').optional(),
    attachmentIds: attachmentIdsField.optional(),
  }),
  handler: (ctx, input) => {
    const { issue } = resolveIssueRef(ctx.deps, ctx.actor, input.issue);
    const set = labelIds(ctx, issue.projectId, input.labels);
    const add = labelIds(ctx, issue.projectId, input.addLabels);
    const remove = labelIds(ctx, issue.projectId, input.removeLabels);
    const labelsChanged = set !== undefined || add !== undefined || remove !== undefined;
    const parsed = parseInput(updateIssueInputSchema, {
      title: input.title,
      body: input.body,
      labels: labelsChanged ? { set, add, remove } : undefined,
      attachmentIds: input.attachmentIds,
    });
    return issueForAgent(ctx, updateIssue(ctx.deps, ctx.actor, issue.id, parsed));
  },
});

const resolveIssueTool = defineTool({
  name: 'resolve_issue',
  title: 'Resolve issue',
  description:
    'Marks an issue resolved (the author or RESOLVE_ISSUES). Its author and subscribers are notified. To explain why, add a reply with add_reply first. Resolving a resolved issue changes nothing.',
  input: z.object({ issue: issueRef }),
  annotations: { idempotentHint: true },
  handler: (ctx, input) =>
    issueForAgent(ctx, resolveIssue(ctx.deps, ctx.actor, issueId(ctx, input.issue))),
});

const reopenIssueTool = defineTool({
  name: 'reopen_issue',
  title: 'Reopen issue',
  description:
    'Reopens a resolved issue (the author or RESOLVE_ISSUES). Its author and subscribers are notified. Reopening an open issue changes nothing.',
  input: z.object({ issue: issueRef }),
  annotations: { idempotentHint: true },
  handler: (ctx, input) =>
    issueForAgent(ctx, reopenIssue(ctx.deps, ctx.actor, issueId(ctx, input.issue))),
});

const deleteIssueTool = defineTool({
  name: 'delete_issue',
  title: 'Delete issue',
  description:
    'Moves an issue to Trash (the author or DELETE_ANY_CONTENT). It disappears from lists and search, and can be restored with restore_issue for 30 days.',
  input: z.object({ issue: issueRef }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => deleteIssue(ctx.deps, ctx.actor, issueId(ctx, input.issue)),
});

const restoreIssueTool = defineTool({
  name: 'restore_issue',
  title: 'Restore issue',
  description:
    'Restores an issue from Trash (its author or MANAGE_TRASH), with its replies and files. If its project is in Trash, restore the project instead.',
  input: z.object({
    issue: z
      .string()
      .min(1)
      .describe('The deleted issue: KEY#51, team-slug/KEY#51, or its id (see list_trash)'),
  }),
  handler: (ctx, input) => {
    const ref = resolveTrashRef(ctx.deps, ctx.actor, { item: input.issue, type: 'issue' });
    return issueForAgent(ctx, restoreIssue(ctx.deps, ctx.actor, ref.id));
  },
});

export const issuesTools: McpTool[] = [
  listIssuesTool,
  getIssueTool,
  createIssueTool,
  updateIssueTool,
  resolveIssueTool,
  reopenIssueTool,
  deleteIssueTool,
  restoreIssueTool,
];
