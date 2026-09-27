import { z } from 'zod';

/**
 * "Who" rules (docs/design/agents-and-pipelines.md §2): one shape for assignee pools, move
 * permissions, approvers, hand-offs and notify lists. A rule matches a member when any `allow`
 * entry matches and no `deny` entry does; an empty `allow` matches nobody.
 */

export const PRINCIPAL_SCOPES = ['people', 'agents', 'both'] as const;
export type PrincipalScope = (typeof PRINCIPAL_SCOPES)[number];

export const principalSchema = z.discriminatedUnion('type', [
  /** A person or an agent member. */
  z.object({ type: z.literal('user'), userId: z.string().min(1) }),
  /** A team role; `agents` = agents whose owners have the role, plus agents holding it. */
  z.object({
    type: z.literal('role'),
    roleId: z.string().min(1),
    scope: z.enum(PRINCIPAL_SCOPES),
  }),
  /** A project role (§3). */
  z.object({
    type: z.literal('project_role'),
    roleId: z.string().min(1),
    scope: z.enum(PRINCIPAL_SCOPES),
  }),
  /** Every member of the team (of the scope). */
  z.object({ type: z.literal('everyone'), scope: z.enum(PRINCIPAL_SCOPES) }),
]);
export type Principal = z.infer<typeof principalSchema>;

export const principalRuleSchema = z.object({
  allow: z.array(principalSchema).max(100),
  deny: z.array(principalSchema).max(100).default([]),
});
export type PrincipalRule = z.infer<typeof principalRuleSchema>;

/** The `-ai` suffix of agent usernames (`ethan-ai`); reserved for agents. */
export const AGENT_USERNAME_SUFFIX = '-ai';

export function agentUsername(ownerUsername: string): string {
  return `${ownerUsername}${AGENT_USERNAME_SUFFIX}`;
}
