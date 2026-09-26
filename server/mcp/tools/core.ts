import { z } from 'zod';
import { agentHandle } from '@shared/agents';
import {
  type ActivityEntityType,
  ACTIVITY_ENTITY_TYPES,
  ACTOR_SOURCES,
  LIMITS,
  SEARCH_ENTITY_TYPES,
} from '@shared/constants';
import { createReplyInputSchema, updateReplyInputSchema } from '@shared/schemas/core';
import { errors } from '../../lib/errors';
import { parseInput } from '../../lib/validate';
import { consumeRateLimit } from '../../middleware/rateLimit';
import { appPaths } from '../../lib/urls';
import { listAuditLog, listEntityActivityPage } from '../../services/activity';
import { resolveAuditLogKey } from '../../services/admin';
import {
  deleteAttachment,
  getAgentImage,
  getAttachmentWithContent,
  listAttachments,
  uploadAttachmentContent,
} from '../../services/attachments';
import { MAX_MENTION_WAIT_SECONDS, waitForMentions } from '../../services/agentMentions';
import { findItem } from '../../services/items';
import { listNotifications, markNotificationsRead } from '../../services/notifications';
import { resolveProject, resolveTeam, resolveUser } from '../../services/refs';
import {
  createReply,
  deleteReply,
  editReply,
  getReply,
  listReplyPage,
  type ReplyWithContext,
} from '../../services/replies';
import { search } from '../../services/search';
import { setSubscription } from '../../services/subscriptions';
import { getMe } from '../../services/users';
import {
  qualifyRef,
  resolveItemRef,
  teamSlugs,
  toAbsolute,
  withAbsoluteUrls,
  withQualifiedRefs,
} from '../util';
import { defineTool, toolInput, withContent, type McpTool, type ToolContext } from './define';

/**
 * Core MCP tools (SPEC §5.1 [core]): whoami, search, notifications, replies, attachments,
 * activity and subscriptions. Handlers resolve refs and call services only.
 */

const itemRef = z
  .string()
  .min(1)
  .describe('Task or issue: a ref like KEY-12 (task), KEY#51 (issue), team-slug/KEY-12, or an id');

const orderField = z.enum(['asc', 'desc']).describe('asc: oldest first; desc: newest first');

/** A reply as add_reply / edit_reply return it: team-qualified ref, absolute file URLs. */
function replyForAgent(ctx: ToolContext, reply: ReplyWithContext) {
  const teamSlug = teamSlugs(ctx.deps, [reply.teamId]).get(reply.teamId) ?? '';
  return {
    ...reply,
    ref: qualifyRef(teamSlug, reply.ref),
    attachments: withAbsoluteUrls(ctx.deps, reply.attachments),
  };
}

function itemContext(ctx: ToolContext, ref: string) {
  const resolved = resolveItemRef(ctx.deps, ctx.actor, ref);
  const item = findItem(ctx.deps.db.orm, resolved.type, resolved.id);
  if (!item) throw errors.notFound('Task or issue');
  return item;
}

const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    'The user this API key acts for, the key itself, and the teams (with your permissions) and projects you can access. Call this first to learn team slugs and project keys (and the upload size limit).',
  input: toolInput({}),
  annotations: { readOnlyHint: true },
  handler: (ctx) => {
    const me = getMe(ctx.deps, ctx.actor);
    return {
      user: {
        id: me.user.id,
        username: me.user.username,
        name: me.user.name,
        email: me.user.email,
      },
      via: ctx.actor.key
        ? {
            keyId: ctx.actor.key.id,
            keyName: ctx.actor.key.name,
            agentName: ctx.actor.key.agentName ?? null,
            // `@claude` in a reply on an item you replied to or created: see wait_for_mentions.
            mentionHandle: ctx.actor.key.agentName
              ? `@${agentHandle(ctx.actor.key.agentName)}`
              : null,
          }
        : null,
      teams: me.teams.map((team) => ({
        id: team.id,
        slug: team.slug,
        name: team.name,
        isOwner: team.isOwner,
        permissions: team.permissions,
        url: toAbsolute(ctx.deps, appPaths.team(team.slug)),
        projects: team.projects.map((project) => ({
          id: project.id,
          key: project.key,
          name: project.name,
          ref: `${team.slug}/${project.key}`,
          url: toAbsolute(ctx.deps, appPaths.project(team.slug, project.key)),
        })),
      })),
      unreadNotifications: me.unreadNotifications,
      limits: { maxUploadMb: ctx.deps.env.maxUploadMb },
    };
  },
});

const searchTool = defineTool({
  name: 'search',
  title: 'Search',
  description:
    'Full-text search over tasks, issues and replies in your teams (prefix matching, best matches first).',
  input: toolInput({
    query: z
      .string()
      .min(LIMITS.searchQuery.min)
      .max(LIMITS.searchQuery.max)
      .describe(
        'Words to look for (every word must match, prefix matching), or a task/issue ref (KEY-12, KEY#51, team/KEY-12, 12) whose items come first',
      ),
    team: z.string().optional().describe('Limit to a team (slug or id)'),
    project: z.string().optional().describe('Limit to a project (KEY, team-slug/KEY or id)'),
    types: z
      .array(z.enum(SEARCH_ENTITY_TYPES))
      .optional()
      .describe('Entity types to include (default: task, issue, reply)'),
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum results (1–50)'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const project = input.project ? resolveProject(ctx.deps, ctx.actor, input.project) : null;
    const team = input.team ? resolveTeam(ctx.deps, ctx.actor, input.team) : null;
    const { results } = search(ctx.deps, ctx.actor, {
      q: input.query,
      teamId: project?.team.id ?? team?.team.id,
      projectId: project?.project.id,
      types: input.types ?? [...SEARCH_ENTITY_TYPES],
      limit: input.limit,
    });
    return { results: withQualifiedRefs(ctx.deps, withAbsoluteUrls(ctx.deps, results)) };
  },
});

const listNotificationsTool = defineTool({
  name: 'list_notifications',
  title: 'List notifications',
  description: 'Your inbox, newest first: mentions, assignments, replies, resolutions.',
  input: toolInput({
    unreadOnly: z.boolean().default(false).describe('Only unread notifications'),
    limit: z.number().int().min(1).max(LIMITS.page.maxSize).default(20).describe('Page size'),
    cursor: z.string().optional().describe('nextCursor from a previous call, for the next page'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const page = listNotifications(ctx.deps, ctx.actor, {
      unread: input.unreadOnly ? '1' : undefined,
      limit: input.limit,
      cursor: input.cursor,
    });
    return { items: withAbsoluteUrls(ctx.deps, page.items), nextCursor: page.nextCursor };
  },
});

const markNotificationsReadTool = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark notifications read',
  description: 'Marks the given notifications, or all of them, as read.',
  annotations: { destructiveHint: false, idempotentHint: true },
  input: toolInput({
    ids: z
      .array(z.string())
      .min(1)
      .max(LIMITS.bulkIds)
      .optional()
      .describe('Notification ids to mark read'),
    all: z.boolean().optional().describe('true to mark every notification read'),
  }),
  handler: (ctx, input) => {
    if (input.all) return markNotificationsRead(ctx.deps, ctx.actor, { all: true });
    if (!input.ids) throw errors.validation('Pass ids, or all: true');
    return markNotificationsRead(ctx.deps, ctx.actor, { ids: input.ids });
  },
});

const listRepliesTool = defineTool({
  name: 'list_replies',
  title: 'List replies',
  description:
    'The reply thread of a task or issue, one page at a time: oldest first by default, or newest first with order: "desc" (the latest replies). `total` counts every reply; pass nextCursor back for the next page.',
  input: toolInput({
    item: itemRef,
    order: orderField.default('asc'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.page.maxSize)
      .default(50)
      .describe(`Page size (1–${LIMITS.page.maxSize}, default 50)`),
    cursor: z.string().optional().describe('nextCursor from a previous call, for the next page'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const item = itemContext(ctx, input.item);
    const page = listReplyPage(ctx.deps, ctx.actor, {
      parentType: item.type,
      parentId: item.id,
      limit: input.limit,
      cursor: input.cursor,
      order: input.order,
    });
    const teamSlug = teamSlugs(ctx.deps, [item.teamId]).get(item.teamId) ?? '';
    return {
      item: {
        type: item.type,
        ref: qualifyRef(teamSlug, item.ref),
        title: item.title,
        url: toAbsolute(ctx.deps, item.path),
      },
      total: page.total,
      nextCursor: page.nextCursor,
      replies: page.items.map((reply) => ({
        ...reply,
        url: toAbsolute(ctx.deps, appPaths.reply(item.path, reply.id)),
        attachments: withAbsoluteUrls(ctx.deps, reply.attachments),
      })),
    };
  },
});

const addReply = defineTool({
  name: 'add_reply',
  title: 'Add reply',
  description:
    'Replies to a task or issue (markdown; mention people with @username and roles with @&role-slug). Subscribers and mentioned members are notified.',
  input: toolInput({
    item: itemRef,
    body: z
      .string()
      .min(LIMITS.replyBody.min)
      .max(LIMITS.replyBody.max)
      .describe('Reply text in markdown'),
    attachmentIds: z
      .array(z.string())
      .max(LIMITS.attachmentsPerItem)
      .optional()
      .describe('Ids of pending uploads (from upload_attachment without an item) to attach'),
  }),
  annotations: { destructiveHint: false },
  handler: (ctx, input) => {
    const item = resolveItemRef(ctx.deps, ctx.actor, input.item);
    const data = parseInput(createReplyInputSchema, {
      parentType: item.type,
      parentId: item.id,
      body: input.body,
      attachmentIds: input.attachmentIds,
    });
    return replyForAgent(ctx, createReply(ctx.deps, ctx.actor, data));
  },
});

const editReplyTool = defineTool({
  name: 'edit_reply',
  title: 'Edit reply',
  description: 'Replaces the text of a reply (your own, or any with EDIT_ANY_CONTENT).',
  input: toolInput({
    reply: z.string().min(1).describe('Reply id'),
    body: z
      .string()
      .min(LIMITS.replyBody.min)
      .max(LIMITS.replyBody.max)
      .describe('New reply text in markdown'),
  }),
  annotations: { destructiveHint: false, idempotentHint: true },
  handler: (ctx, input) => {
    const data = parseInput(updateReplyInputSchema, { body: input.body });
    return replyForAgent(ctx, editReply(ctx.deps, ctx.actor, input.reply, data));
  },
});

const deleteReplyTool = defineTool({
  name: 'delete_reply',
  title: 'Delete reply',
  description:
    'Moves a reply to Trash (your own, or any with DELETE_ANY_CONTENT). Restorable for 30 days.',
  input: toolInput({ reply: z.string().min(1).describe('Reply id') }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => {
    const reply = replyForAgent(ctx, getReply(ctx.deps, ctx.actor, input.reply));
    deleteReply(ctx.deps, ctx.actor, input.reply);
    return { ok: true, deleted: { id: reply.id, ref: reply.ref } };
  },
});

const uploadAttachment = defineTool({
  name: 'upload_attachment',
  title: 'Upload attachment',
  description:
    'Uploads a file as base64 or plain text, up to the server upload limit (MAX_UPLOAD_MB, see whoami). With `item` it is attached to that task or issue; otherwise it stays pending in `team` and can be attached by passing its id in attachmentIds (e.g. add_reply) within 24 hours. Counts against the same per-user upload rate limit as web uploads (30 per minute).',
  input: toolInput({
    filename: z.string().min(1).max(LIMITS.filename.max).describe('File name, e.g. notes.md'),
    contentBase64: z.string().optional().describe('File content, base64-encoded (binary files)'),
    text: z.string().optional().describe('File content as UTF-8 text (text files)'),
    item: itemRef.optional().describe('Task or issue to attach the file to (ref or id)'),
    team: z
      .string()
      .optional()
      .describe('Team (slug or id) for a pending upload; not needed with item'),
  }),
  annotations: { destructiveHint: false },
  handler: async (ctx, input) => {
    if ((input.contentBase64 === undefined) === (input.text === undefined)) {
      throw errors.validation('Pass exactly one of contentBase64 or text');
    }
    consumeRateLimit(ctx.deps.rateLimiter, 'uploads', ctx.actor.userId);
    let fields;
    if (input.item) {
      const item = itemContext(ctx, input.item);
      fields = { teamId: item.teamId, parentType: item.type, parentId: item.id } as const;
    } else if (input.team) {
      fields = {
        teamId: resolveTeam(ctx.deps, ctx.actor, input.team).team.id,
        parentType: 'pending',
      } as const;
    } else {
      throw errors.validation('Pass item (to attach) or team (for a pending upload)');
    }
    const attachment = await uploadAttachmentContent(ctx.deps, ctx.actor, {
      ...fields,
      filename: input.filename,
      contentBase64: input.contentBase64,
      text: input.text,
    });
    return { ...attachment, url: toAbsolute(ctx.deps, attachment.url) };
  },
});

const listAttachmentsTool = defineTool({
  name: 'list_attachments',
  title: 'List attachments',
  description: 'Files attached to a task, issue, reply or project.',
  input: toolInput({
    item: itemRef.optional().describe('Task or issue (ref or id)'),
    reply: z.string().optional().describe('Reply id'),
    project: z.string().optional().describe('Project (KEY, team-slug/KEY or id)'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const given = [input.item, input.reply, input.project].filter((value) => value !== undefined);
    if (given.length !== 1) throw errors.validation('Pass exactly one of item, reply or project');
    let parent;
    if (input.item) {
      const item = resolveItemRef(ctx.deps, ctx.actor, input.item);
      parent = { type: item.type, id: item.id } as const;
    } else if (input.reply) {
      parent = { type: 'reply', id: input.reply } as const;
    } else {
      parent = {
        type: 'project',
        id: resolveProject(ctx.deps, ctx.actor, input.project ?? '').project.id,
      } as const;
    }
    const { items } = listAttachments(ctx.deps, ctx.actor, parent);
    return { items: withAbsoluteUrls(ctx.deps, items) };
  },
});

const getAttachment = defineTool({
  name: 'get_attachment',
  title: 'Get attachment',
  description:
    'Metadata and download URL of an attachment; for text files up to 256 KB (source code, diffs, logs, anything uploaded as text) also the content; for PNG, JPEG, GIF and WebP images the picture itself as image content (scaled down to at most 1568 px and 1 MB; `image` says its size). The download URL needs the same `Authorization: Bearer` API key.',
  input: toolInput({ attachment: z.string().min(1).describe('Attachment id') }),
  annotations: { readOnlyHint: true },
  handler: async (ctx, input) => {
    const attachment = getAttachmentWithContent(ctx.deps, ctx.actor, input.attachment);
    const image = await getAgentImage(ctx.deps, ctx.actor, input.attachment);
    const value = {
      ...attachment,
      url: toAbsolute(ctx.deps, attachment.url),
      image: image
        ? {
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            resized: image.resized,
          }
        : null,
    };
    return image
      ? withContent(value, [{ type: 'image', data: image.data, mimeType: image.mimeType }])
      : value;
  },
});

const deleteAttachmentTool = defineTool({
  name: 'delete_attachment',
  title: 'Delete attachment',
  description:
    'Moves an attachment to Trash (your own, or any with DELETE_ANY_CONTENT). Restorable for 30 days.',
  input: toolInput({ attachment: z.string().min(1).describe('Attachment id') }),
  annotations: { destructiveHint: true },
  handler: (ctx, input) => deleteAttachment(ctx.deps, ctx.actor, input.attachment),
});

const getActivity = defineTool({
  name: 'get_activity',
  title: 'Get activity',
  description:
    'History of one task, issue, reply or attachment (who changed what, oldest first by default, paginated; every member can read it), or — with VIEW_AUDIT_LOG — the history of any other team entity (entityType + entityId, e.g. project or role) or, with `team`, the team audit log (newest first, paginated, filterable by project, actor, source, API key, entity type, action and time; get_audit_log_facets lists the values present).',
  input: toolInput({
    item: itemRef.optional().describe('Task or issue whose history to show (ref or id)'),
    entityType: z
      .enum(ACTIVITY_ENTITY_TYPES)
      .optional()
      .describe(
        'Other entity type for a history (with entityId): reply or attachment for any member; project, role and other team entities need VIEW_AUDIT_LOG. With team and no entityId: audit log filter by entity type',
      ),
    entityId: z.string().optional().describe('Entity id for entityType'),
    team: z.string().optional().describe('Team (slug or id) whose audit log to read'),
    project: z.string().optional().describe('Audit log: only this project (KEY, team/KEY or id)'),
    actor: z.string().optional().describe('Audit log: only actions by this user (username or id)'),
    source: z.enum(ACTOR_SOURCES).optional().describe('Audit log: only this source'),
    key: z
      .string()
      .optional()
      .describe(
        'Audit log: only actions made through this API key (key id, or its name as shown in via)',
      ),
    action: z
      .string()
      .optional()
      .describe('Audit log: exact action (task.created) or a prefix ending in a dot (task.)'),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Audit log: from (inclusive), ISO 8601'),
    until: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Audit log: to (exclusive), ISO 8601'),
    order: orderField
      .optional()
      .describe(
        'History of an item or entity: asc (default, oldest first) or desc (newest first). The audit log is always newest first',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.page.maxSize)
      .default(50)
      .describe('Page size (history or audit log)'),
    cursor: z.string().optional().describe('nextCursor from a previous call, for the next page'),
  }),
  annotations: { readOnlyHint: true },
  handler: (ctx, input) => {
    const history = (entityType: ActivityEntityType, entityId: string) => {
      const page = listEntityActivityPage(ctx.deps, ctx.actor, {
        entityType,
        entityId,
        limit: input.limit,
        cursor: input.cursor,
        order: input.order ?? 'asc',
      });
      return { items: withAbsoluteUrls(ctx.deps, page.items), nextCursor: page.nextCursor };
    };
    if (input.item) {
      const item = resolveItemRef(ctx.deps, ctx.actor, input.item);
      return history(item.type, item.id);
    }
    if (input.entityType && input.entityId) return history(input.entityType, input.entityId);
    if (!input.team) throw errors.validation('Pass item, entityType + entityId, or team');
    const { team } = resolveTeam(ctx.deps, ctx.actor, input.team);
    const page = listAuditLog(ctx.deps, ctx.actor, team.id, {
      limit: input.limit,
      cursor: input.cursor,
      projectId: input.project
        ? resolveProject(ctx.deps, ctx.actor, input.project).project.id
        : undefined,
      actorId: input.actor
        ? resolveUser(ctx.deps, ctx.actor, input.actor, { teamId: team.id }).id
        : undefined,
      source: input.source,
      keyId: input.key ? resolveAuditLogKey(ctx.deps, ctx.actor, team.id, input.key) : undefined,
      entityType: input.entityType,
      action: input.action,
      from: input.since,
      to: input.until,
    });
    return { items: withAbsoluteUrls(ctx.deps, page.items), nextCursor: page.nextCursor };
  },
});

function subscriptionTool(name: 'subscribe' | 'unsubscribe') {
  const subscribed = name === 'subscribe';
  return defineTool({
    name,
    title: subscribed ? 'Subscribe' : 'Unsubscribe',
    description: subscribed
      ? 'Get notified about new replies on a task or issue.'
      : 'Stop reply notifications for a task or issue (mentions still notify).',
    input: toolInput({ item: itemRef }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: (ctx, input) => {
      const item = resolveItemRef(ctx.deps, ctx.actor, input.item);
      return setSubscription(ctx.deps, ctx.actor, {
        entityType: item.type,
        entityId: item.id,
        subscribed,
      });
    },
  });
}

const waitForMentionsTool = defineTool({
  name: 'wait_for_mentions',
  title: 'Wait for mentions',
  description:
    'Waits until someone @mentions your agent (e.g. @claude; `whoami` shows your handle) in a reply on a task or issue you replied to or created, and returns those replies (each one once). Returns at once when mentions are pending; otherwise waits up to timeoutSeconds. Call it again to keep listening.',
  input: toolInput({
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_MENTION_WAIT_SECONDS)
      .default(50)
      .describe(
        `Longest wait in seconds (default 50, max ${MAX_MENTION_WAIT_SECONDS}); 0 only checks`,
      ),
  }),
  annotations: { readOnlyHint: true },
  handler: async (ctx, input) => {
    const { mentions } = await waitForMentions(ctx.deps, ctx.actor, input, ctx.signal);
    return {
      mentions: mentions.map(({ reply, parentType }) => ({
        item: { type: parentType, ref: reply.ref },
        reply: {
          id: reply.id,
          body: reply.body,
          author: reply.author,
          via: reply.via,
          createdAt: reply.createdAt,
          url: reply.url,
        },
      })),
    };
  },
});

export const coreTools: McpTool[] = [
  whoami,
  searchTool,
  listNotificationsTool,
  markNotificationsReadTool,
  listRepliesTool,
  addReply,
  editReplyTool,
  deleteReplyTool,
  uploadAttachment,
  listAttachmentsTool,
  getAttachment,
  deleteAttachmentTool,
  getActivity,
  subscriptionTool('subscribe'),
  subscriptionTool('unsubscribe'),
  waitForMentionsTool,
];
