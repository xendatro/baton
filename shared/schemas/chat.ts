import { z } from 'zod';
import {
  AGENT_JOB_STATUSES,
  CHAT_LIMITS,
  CONVERSATION_MODES,
  REPLY_PARENT_TYPES,
} from '../constants';
import { idSchema, markdownSchema, timestampSchema, titleSchema } from './common';
import { replySchema, userSummarySchema } from './core';

/**
 * Wire contracts of chat conversations on issues and tasks: the flat message stream, typing
 * pings, the conversation mode, and catch-up summaries written by the viewer's own agent.
 * Paths: `/api/items/:type/:id/…` with `type` = `issue` | `task`.
 */

export const conversationModeSchema = z.enum(CONVERSATION_MODES);

export const itemParamsSchema = z.object({
  type: z.enum(REPLY_PARENT_TYPES),
  id: idSchema,
});
export type ItemParams = z.infer<typeof itemParamsSchema>;

/** `PUT /api/items/:type/:id/conversation-mode` (the author, or `EDIT_ANY_CONTENT`). */
export const setConversationModeInputSchema = z.object({ mode: conversationModeSchema });
export type SetConversationModeInput = z.infer<typeof setConversationModeInputSchema>;

export const conversationModeResponseSchema = z.object({ mode: conversationModeSchema });

/** `GET /api/items/:type/:id/chat`: one page of messages, newest page first. */
export const chatPageQuerySchema = z.object({
  /** `olderCursor` of the page after which to continue (older messages). */
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.maxPageSize).optional(),
});
export type ChatPageQuery = z.infer<typeof chatPageQuerySchema>;

export const chatPageSchema = z.object({
  /** Oldest first within the page. */
  items: z.array(replySchema),
  /** Pass as `before` to load the page of older messages; null at the start of the chat. */
  olderCursor: z.string().nullable(),
  /** Live messages in the whole chat. */
  total: z.number().int().nonnegative(),
  /**
   * The viewer's unread messages (reply notifications not read yet) as the page was read, and the
   * oldest of them (the "new messages" divider). Opening the chat marks them read afterwards.
   */
  unread: z.object({
    count: z.number().int().nonnegative(),
    firstReplyId: z.string().nullable(),
  }),
  /** Agent members with a job about this item in progress now ("… is working"). */
  workingAgents: z.array(userSummarySchema),
});
export type ChatPage = z.infer<typeof chatPageSchema>;

// ---------------------------------------------------------------------------------------------
// Catch up
// ---------------------------------------------------------------------------------------------

/** Which messages to summarize: those since the first unread one, or the last N. */
export const catchUpRangeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unread'), sinceReplyId: idSchema }),
  z.object({
    kind: z.literal('last'),
    count: z.union([z.literal(20), z.literal(50), z.literal(100)]),
  }),
]);
export type CatchUpRangeInput = z.infer<typeof catchUpRangeInputSchema>;

/** The messages a summary covers (resolved when it was asked for). */
export const catchUpRangeSchema = z.object({
  kind: z.enum(['unread', 'last']),
  /** Messages in the range. */
  count: z.number().int().nonnegative(),
  fromReplyId: z.string().nullable(),
  toReplyId: z.string().nullable(),
});
export type CatchUpRange = z.infer<typeof catchUpRangeSchema>;

export const catchUpSummarySchema = z.object({
  id: z.string(),
  itemType: z.enum(REPLY_PARENT_TYPES),
  itemId: z.string(),
  range: catchUpRangeSchema,
  /** Markdown. */
  summary: z.string(),
  createdAt: timestampSchema,
});
export type CatchUpSummary = z.infer<typeof catchUpSummarySchema>;

export const catchUpJobSchema = z.object({
  id: z.string(),
  status: z.enum(AGENT_JOB_STATUSES),
  range: catchUpRangeSchema,
  createdAt: timestampSchema,
});
export type CatchUpJob = z.infer<typeof catchUpJobSchema>;

/** `GET /api/items/:type/:id/catch-up`: the viewer's own summaries and open request. */
export const catchUpStateSchema = z.object({
  /** Newest first. */
  summaries: z.array(catchUpSummarySchema),
  /** The viewer's agent's catch-up job for this item still waiting or running, if any. */
  job: catchUpJobSchema.nullable(),
  /** Does the viewer have an agent member? */
  hasAgent: z.boolean(),
});
export type CatchUpState = z.infer<typeof catchUpStateSchema>;

/** MCP `submit_catch_up`. */
export const submitCatchUpInputSchema = z.object({
  jobId: idSchema,
  summary: z.string().trim().min(1, 'Required').max(CHAT_LIMITS.catchUpSummaryMax),
});
export type SubmitCatchUpInput = z.infer<typeof submitCatchUpInputSchema>;

// ---------------------------------------------------------------------------------------------
// Task drafts ("Have my agent draft it")
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/items/:type/:id/task-draft`: asks the viewer's **own** agent to turn the item (no
 * `replyIds`: its title, description and latest messages) or the chosen messages into a task
 * title and description. The draft is private to the viewer and never creates anything.
 */
export const requestTaskDraftInputSchema = z.object({
  replyIds: z.array(idSchema).max(CHAT_LIMITS.taskFromMessagesMax).optional(),
});
export type RequestTaskDraftInput = z.infer<typeof requestTaskDraftInputSchema>;

export const taskDraftSchema = z.object({ title: z.string(), description: z.string() });
export type TaskDraft = z.infer<typeof taskDraftSchema>;

/** `GET /api/task-drafts/:jobId` (and the POST's answer): the job and, once handed in, the draft. */
export const taskDraftStateSchema = z.object({
  jobId: z.string(),
  status: z.enum(AGENT_JOB_STATUSES),
  itemType: z.enum(REPLY_PARENT_TYPES),
  itemId: z.string(),
  replyIds: z.array(z.string()),
  draft: taskDraftSchema.nullable(),
  createdAt: timestampSchema,
});
export type TaskDraftState = z.infer<typeof taskDraftStateSchema>;

/** MCP `submit_task_draft`. */
export const submitTaskDraftInputSchema = z.object({
  jobId: idSchema,
  title: titleSchema,
  description: markdownSchema,
});
export type SubmitTaskDraftInput = z.infer<typeof submitTaskDraftInputSchema>;
