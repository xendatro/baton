import { z } from 'zod';
import { AGENT_ACTION_STATUSES, AGENT_ACTIONS } from '../constants';
import { timestampSchema } from './common';
import { userSummarySchema, viaKeySchema } from './core';

/**
 * Human sign-off for agents' destructive actions (docs/design/agents-and-pipelines.md §6,
 * docs/API.md → Agent action requests). While a team's "Agents need human sign-off" is on, a
 * destructive operation requested by an agent member creates a request its owner approves or
 * denies instead of running.
 */

export const agentActionSchema = z.enum(AGENT_ACTIONS);
export const agentActionStatusSchema = z.enum(AGENT_ACTION_STATUSES);

/**
 * What a request stores to run the action again once approved, and to describe it. `input` is the
 * action's own arguments (ids), validated by the action's executor when it runs.
 */
export interface AgentActionPayload {
  input: Record<string, unknown>;
  /** What the agent wants to do, in words: `delete BAT-12 “Fix login”`. */
  summary: string;
  /** App URL of the target (relative), when it has a page. */
  url: string | null;
}

/**
 * The answer to an agent whose destructive action now waits for its owner: `202` on REST, a
 * normal (non-error) tool result on MCP.
 */
export const pendingApprovalResponseSchema = z.object({
  pendingApproval: z.literal(true),
  requestId: z.string(),
  message: z.string(),
});
export type PendingApprovalResponse = z.infer<typeof pendingApprovalResponseSchema>;

export const agentActionErrorSchema = z.object({ code: z.string(), message: z.string() });

export const agentActionRequestSchema = z.object({
  id: z.string(),
  team: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  projectId: z.string().nullable(),
  action: agentActionSchema,
  status: agentActionStatusSchema,
  /** `delete BAT-12 “Fix login”`: shown as "Ethan AI wants to delete BAT-12 “Fix login”". */
  summary: z.string(),
  /** App URL of the target (relative), when it has a page. */
  url: z.string().nullable(),
  /** The agent member that asked. */
  agent: userSummarySchema.nullable(),
  /** The person who decides (the agent's owner). */
  owner: userSummarySchema.nullable(),
  /** The API key the agent asked through. */
  via: viaKeySchema.nullable(),
  /** Owner-only actions (delete, restore or transfer a team) run as the owner once approved. */
  runsAsOwner: z.boolean(),
  /** What the action returned once approved and run. */
  result: z.unknown().nullable(),
  /** Why it failed when it ran (status `failed`). */
  error: agentActionErrorSchema.nullable(),
  createdAt: timestampSchema,
  /** When a pending request expires (7 days after it was made). */
  expiresAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  decidedBy: userSummarySchema.nullable(),
});
export type AgentActionRequest = z.infer<typeof agentActionRequestSchema>;

/** `GET /api/agent-actions`: the signed-in person's requests, newest first. */
export const agentActionListQuerySchema = z.object({
  status: z.union([agentActionStatusSchema, z.literal('all')]).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AgentActionListQuery = z.infer<typeof agentActionListQuerySchema>;

export const agentActionListResponseSchema = z.object({
  items: z.array(agentActionRequestSchema),
});
export type AgentActionListResponse = z.infer<typeof agentActionListResponseSchema>;
