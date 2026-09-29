import { z } from 'zod';
import { principalRuleSchema, type Principal, type PrincipalRule } from '../principals';
import { chainEntrySchema, chainSchema, ranWithSchema } from './agentRunner';
import { idSchema, timestampSchema } from './common';
import { userSummarySchema } from './core';

/**
 * Agent access: who can start your agent. Per team a default, per project an optional override
 * that replaces it there. For each person or role (a "who" principal): `auto` starts your agent
 * without asking, `ask` sends you a request you approve (choosing the model) or decline, and
 * anyone in neither list can't start it at all. You and your own agent always start it.
 *
 * A principal is in at most one list (`auto` or `ask`); a person named directly in a list wins
 * over the roles they hold, and otherwise `auto` wins over `ask`.
 */

export const AGENT_ACCESS_LEVELS = ['auto', 'ask', 'none'] as const;
export type AgentAccessLevel = (typeof AGENT_ACCESS_LEVELS)[number];

export const AGENT_ACCESS_LISTS = ['auto', 'ask'] as const;
export type AgentAccessList = (typeof AGENT_ACCESS_LISTS)[number];

/** Same principal, whatever its scope (`@everyone` people and agents count as one). */
function principalIdentity(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return `user:${principal.userId}`;
    case 'role':
      return `role:${principal.roleId}:${principal.scope}`;
    case 'project_role':
      return `project_role:${principal.roleId}:${principal.scope}`;
    case 'everyone':
      return `everyone:${principal.scope}`;
  }
}

/** Same principal (type, id and scope)? */
export function sameAccessPrincipal(a: Principal, b: Principal): boolean {
  return principalIdentity(a) === principalIdentity(b);
}

const baseRulesSchema = z.object({
  /** Start your agent without asking. */
  auto: principalRuleSchema,
  /** May ask you to start it (a request). */
  ask: principalRuleSchema,
});
export type AgentAccessRules = z.infer<typeof baseRulesSchema>;

/** Principals in both lists (the invariant forbids it). */
export function accessConflicts(rules: AgentAccessRules): Principal[] {
  const auto = new Set(rules.auto.allow.map(principalIdentity));
  return rules.ask.allow.filter((principal) => auto.has(principalIdentity(principal)));
}

/** The rules with a list's principals, removed from the other list (the invariant, kept). */
export function setAccessList(
  rules: AgentAccessRules,
  list: AgentAccessList,
  rule: PrincipalRule,
): AgentAccessRules {
  const other: AgentAccessList = list === 'auto' ? 'ask' : 'auto';
  const taken = new Set(rule.allow.map(principalIdentity));
  return {
    ...rules,
    [list]: rule,
    [other]: {
      ...rules[other],
      allow: rules[other].allow.filter((principal) => !taken.has(principalIdentity(principal))),
    },
  };
}

export const agentAccessRulesSchema = baseRulesSchema.superRefine((rules, ctx) => {
  if (accessConflicts(rules).length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'Someone is in both lists: each person or role either starts it or can ask',
      path: ['ask', 'allow'],
    });
  }
});

/**
 * Nothing set: only you (and your agent) start it; every person and every agent of the team can
 * ask. Automatic start is never broad by default.
 */
export const DEFAULT_AGENT_ACCESS: AgentAccessRules = {
  auto: { allow: [], deny: [] },
  ask: {
    allow: [
      { type: 'everyone', scope: 'people' },
      { type: 'everyone', scope: 'agents' },
    ],
    deny: [],
  },
};

/** One team's default, in `GET /api/me/agent/access`. */
export const teamAgentAccessSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  teamSlug: z.string(),
  rules: baseRulesSchema,
  /** Nothing saved: the built-in default. */
  isDefault: z.boolean(),
});
export type TeamAgentAccess = z.infer<typeof teamAgentAccessSchema>;

export const agentAccessSchema = z.object({ teams: z.array(teamAgentAccessSchema) });
export type AgentAccess = z.infer<typeof agentAccessSchema>;

/** `PUT /api/me/agent/access/teams/:teamId`. */
export const setTeamAgentAccessInputSchema = z.object({ rules: agentAccessRulesSchema });

/** `GET/PUT /api/projects/:projectId/me/agent-access`. */
export const projectAgentAccessSchema = z.object({
  projectId: z.string(),
  teamId: z.string(),
  /** Null: the team default applies ("Use team default"). */
  override: baseRulesSchema.nullable(),
  teamDefault: baseRulesSchema,
});
export type ProjectAgentAccess = z.infer<typeof projectAgentAccessSchema>;

export const setProjectAgentAccessInputSchema = z.object({
  override: agentAccessRulesSchema.nullable(),
});
export type SetProjectAgentAccessInput = z.infer<typeof setProjectAgentAccessInputSchema>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const AGENT_REQUEST_DECISIONS = ['approved', 'declined'] as const;
export type AgentRequestDecision = (typeof AGENT_REQUEST_DECISIONS)[number];

/** `pending` waits for the owner; `cleared`: its item finished or was deleted meanwhile. */
export const AGENT_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'cleared'] as const;
export type AgentRequestStatus = (typeof AGENT_REQUEST_STATUSES)[number];

const personSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string(),
});

/** A request to start the owner's agent, as the owner sees it (`GET /api/me/agent/requests`). */
export const agentRequestSchema = z.object({
  jobId: z.string(),
  kind: z.string(),
  status: z.enum(AGENT_REQUEST_STATUSES),
  agent: personSchema,
  owner: personSchema,
  /** Who asked (null: nobody in particular, e.g. a system hand-off). */
  requester: userSummarySchema.nullable(),
  /** The question in the agent's words: "Can I reply to Caden’s message here?". */
  question: z.string(),
  /** What it would do: "Reply to Caden’s message on BAT-40". */
  summary: z.string(),
  project: z.object({ id: z.string(), ref: z.string(), name: z.string() }).nullable(),
  target: z.object({
    type: z.enum(['task', 'issue']).nullable(),
    id: z.string().nullable(),
    ref: z.string().nullable(),
    title: z.string().nullable(),
    /** Relative app URL of the task or issue. */
    path: z.string().nullable(),
  }),
  /** The message that asked (a reply), with a link to it. */
  message: z
    .object({ replyId: z.string(), body: z.string(), path: z.string().nullable() })
    .nullable(),
  /** The pipeline stage the job is for, when a stage handed it over. */
  stage: z.string().nullable(),
  /**
   * What runs without a choice (first = the "Run with" picker's starting point): the suggestion
   * when one of the owner's computers has it, else the owner's default for the project, else
   * their account default.
   */
  suggestedChain: chainSchema,
  suggestedSource: z.string(),
  /** The model suggested for this run (the requester's, else the stage's; null: none). */
  suggestedModel: chainEntrySchema.nullable().optional(),
  /** Who suggested it: the requester or the job's stage. */
  suggestedModelFrom: z.enum(['requester', 'stage']).nullable().optional(),
  /** The model its last run actually used (null: it hasn't run). */
  ranWith: ranWithSchema.nullable().optional(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  /** Why it was declined. */
  reason: z.string().nullable(),
  /** The model chosen when approving. */
  modelOverride: chainSchema.nullable(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const agentRequestsSchema = z.object({ requests: z.array(agentRequestSchema) });

export const AGENT_REQUEST_LIMITS = { reason: 500, bulk: 100 } as const;

/** `POST /api/me/agent/requests/:jobId/approve`: run it, with this model (else the mapping). */
export const approveAgentRequestInputSchema = z.object({
  model: chainEntrySchema.nullable().optional(),
});
export type ApproveAgentRequestInput = z.input<typeof approveAgentRequestInputSchema>;

/** `POST /api/me/agent/requests/:jobId/decline`, with an optional reason for the requester. */
export const declineAgentRequestInputSchema = z.object({
  reason: z.string().trim().max(AGENT_REQUEST_LIMITS.reason).optional(),
});
export type DeclineAgentRequestInput = z.infer<typeof declineAgentRequestInputSchema>;

/** `POST /api/me/agent/requests/bulk`. */
export const bulkAgentRequestsInputSchema = z.object({
  jobIds: z.array(idSchema).min(1).max(AGENT_REQUEST_LIMITS.bulk),
  decision: z.enum(['approve', 'decline']),
  reason: z.string().trim().max(AGENT_REQUEST_LIMITS.reason).optional(),
});
export type BulkAgentRequestsInput = z.infer<typeof bulkAgentRequestsInputSchema>;

/**
 * `GET /api/agent-requests?itemType=&itemId=`: requests about one task or issue. `mine` are the
 * viewer's own agent's (full cards, for inline Approve / Decline); `waiting` is what anyone who
 * can see the item may know: whose agent waits for its owner's OK, or was declined (with the
 * reason, only for the requester and the owner).
 */
export const itemAgentRequestsQuerySchema = z.object({
  itemType: z.enum(['task', 'issue']),
  itemId: idSchema,
});

export const itemAgentRequestStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(['pending', 'declined']),
  agent: personSchema,
  owner: personSchema,
  requester: personSchema.nullable(),
  summary: z.string(),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  reason: z.string().nullable(),
});
export type ItemAgentRequestStatus = z.infer<typeof itemAgentRequestStatusSchema>;

export const itemAgentRequestsSchema = z.object({
  mine: z.array(agentRequestSchema),
  waiting: z.array(itemAgentRequestStatusSchema),
});
export type ItemAgentRequests = z.infer<typeof itemAgentRequestsSchema>;

/** How long declined requests stay visible on their item. */
export const DECLINED_REQUESTS_SHOWN_MS = 24 * 60 * 60 * 1000;
