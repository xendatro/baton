import { z } from 'zod';
import { AGENT_JOB_KINDS, AGENT_JOB_STATUSES, AGENT_JOB_TARGET_TYPES } from '../constants';
import { timestampSchema } from './common';

/**
 * Wire contracts of agent jobs, listener sessions and presence (docs/design/agents-and-pipelines.md
 * §4, docs/API.md → Agents): the owner's "Agent activity" panel (`GET /api/me/agent/activity`)
 * and team presence (`GET /api/teams/:teamId/presence`).
 */

/** A project as a job or session names it. */
export const agentJobProjectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  teamSlug: z.string(),
});
export type AgentJobProject = z.infer<typeof agentJobProjectSchema>;

/** A listener session of the owner's agent. */
export const agentSessionSchema = z.object({
  id: z.string(),
  /** The API key it runs with (null once the key is deleted). */
  keyName: z.string().nullable(),
  /** The harness using the key ("Claude"), when known. */
  agentName: z.string().nullable(),
  projects: z.array(agentJobProjectSchema),
  startedAt: timestampSchema,
  lastSeenAt: timestampSchema,
  /** Seen in the last 90 s, or waiting for jobs right now. */
  online: z.boolean(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentJobSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(AGENT_JOB_KINDS),
  status: z.enum(AGENT_JOB_STATUSES),
  closing: z.boolean(),
  project: agentJobProjectSchema.nullable(),
  target: z.object({
    type: z.enum(AGENT_JOB_TARGET_TYPES),
    id: z.string(),
    /** `KEY-12` / `KEY#51` for tasks and issues; null for other targets or deleted items. */
    ref: z.string().nullable(),
    title: z.string().nullable(),
    /** Relative app URL, when the target is a live task or issue. */
    url: z.string().nullable(),
  }),
  createdAt: timestampSchema,
  claimedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});
export type AgentJobSummary = z.infer<typeof agentJobSummarySchema>;

/** `GET /api/me/agent/activity`: sessions (most recently seen first) and the latest jobs. */
export const agentActivitySchema = z.object({
  online: z.boolean(),
  sessions: z.array(agentSessionSchema),
  jobs: z.array(agentJobSummarySchema),
  pendingCount: z.number().int().nonnegative(),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

/** `GET /api/teams/:teamId/presence`: ids of the team's members who are online now. */
export const teamPresenceSchema = z.object({ online: z.array(z.string()) });
export type TeamPresence = z.infer<typeof teamPresenceSchema>;
