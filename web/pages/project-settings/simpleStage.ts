import type { Principal, PrincipalRule } from '@shared/principals';
import type { StageRules } from '@shared/schemas/pipelines';
import {
  describeRule,
  isAgentUser,
  principalLabel,
  type PrincipalOptions,
} from '@web/components/pickers/principals';

/**
 * The visual pipeline editor's plain-language view of a stage's rules (2026-09-29): "Who works
 * here?", "What's needed to move on?" and "Should an agent do this stage?", mapped onto the
 * existing stage rules. Nothing here adds a rule type: an agent stage is a hand-off (a claim pool,
 * or everyone together) whose list names only agents.
 */

/** "Who works here?" in the simple panel. `custom`: a hand-off only Advanced can edit. */
export type WhoChoice = 'keep' | 'nobody' | 'specific' | 'pool' | 'custom';

/** Does the principal only ever match agents? */
export function isAgentPrincipal(principal: Principal, options: PrincipalOptions): boolean {
  if (principal.type === 'user') {
    const user = options.users.find((candidate) => candidate.id === principal.userId);
    return user ? isAgentUser(user) : false;
  }
  return principal.scope === 'agents';
}

/** An agent stage: its hand-off picks from a list of agents only. */
export function isAgentStage(rules: StageRules, options: PrincipalOptions): boolean {
  const { handoff } = rules;
  if (handoff.mode !== 'pool' && handoff.mode !== 'specific') return false;
  const allow = handoff.rule?.allow ?? [];
  return allow.length > 0 && allow.every((principal) => isAgentPrincipal(principal, options));
}

/** The agents an agent stage hands tasks to (empty for other stages). */
export function stageAgents(rules: StageRules, options: PrincipalOptions): Principal[] {
  return isAgentStage(rules, options) ? [...(rules.handoff.rule?.allow ?? [])] : [];
}

export function whoChoice(rules: StageRules): WhoChoice {
  const { mode } = rules.handoff;
  return mode === 'keep' || mode === 'nobody' || mode === 'specific' || mode === 'pool'
    ? mode
    : 'custom';
}

const CUSTOM_WORDS: Record<string, string> = {
  round_robin: 'One of a list, taking turns',
  least_busy: 'One of a list, the least busy',
  author: 'The task’s author',
  mover: 'Whoever moved it here',
  stage_holder: 'Whoever had it in an earlier stage',
};

/** "Who works here" in a few words, for the flow's badges. */
export function whoSummary(rules: StageRules, options: PrincipalOptions): string {
  const { handoff } = rules;
  switch (handoff.mode) {
    case 'keep':
      return 'Same people';
    case 'nobody':
      return 'Anyone';
    case 'specific':
      return shortList(handoff.rule, options);
    case 'pool':
      return `First to claim: ${shortList(handoff.rule, options)}`;
    default:
      return CUSTOM_WORDS[handoff.mode] ?? 'Custom';
  }
}

/** The long form of `whoSummary`, for accessible names and the panel. */
export function whoSentence(rules: StageRules, options: PrincipalOptions): string {
  const { handoff } = rules;
  switch (handoff.mode) {
    case 'keep':
      return 'Whoever had it keeps it';
    case 'nobody':
      return 'Nobody is assigned; anyone can pick it up';
    case 'specific':
      return `Assigned to ${describeRule(handoff.rule, options)}`;
    case 'pool':
      return `The first to claim it from ${describeRule(handoff.rule, options)}`;
    default:
      return CUSTOM_WORDS[handoff.mode] ?? 'Custom';
  }
}

/** "@ann", "@ann +2", "nobody". */
function shortList(rule: PrincipalRule | undefined, options: PrincipalOptions): string {
  const allow = rule?.allow ?? [];
  const [first] = allow;
  if (!first) return 'nobody';
  const label = principalLabel(first, options);
  return allow.length > 1 ? `${label} +${allow.length - 1}` : label;
}

/** The agents a stage can be handed to: each agent member, every agent, each role's agents. */
export interface AgentChoice {
  key: string;
  principal: Principal;
  label: string;
  description: string;
}

export function agentChoices(options: PrincipalOptions): AgentChoice[] {
  return [
    ...options.users.filter(isAgentUser).map((user) => ({
      key: `user:${user.id}`,
      principal: { type: 'user' as const, userId: user.id },
      label: user.name,
      description: `@${user.username}`,
    })),
    {
      key: 'everyone:agents',
      principal: { type: 'everyone' as const, scope: 'agents' as const },
      label: 'Any agent in the team',
      description: '@everyone-ai',
    },
    ...options.roles
      .filter((role) => !role.isEveryone)
      .map((role) => ({
        key: `role:${role.id}`,
        principal: { type: 'role' as const, roleId: role.id, scope: 'agents' as const },
        label: `${role.name} agents`,
        description: `Agents of people with the ${role.name} role`,
      })),
    ...options.projectRoles.map((role) => ({
      key: `project_role:${role.id}`,
      principal: { type: 'project_role' as const, roleId: role.id, scope: 'agents' as const },
      label: `${role.name} agents`,
      description: `Agents of people with the ${role.name} project role`,
    })),
  ];
}

/** Same principal, scope included. */
export function samePrincipalExactly(a: Principal, b: Principal): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A free criterion id (`c1`, `c2`…). */
export function nextCriterionId(existing: ReadonlyArray<{ id: string }>): string {
  for (let n = existing.length + 1; ; n += 1) {
    const id = `c${n}`;
    if (!existing.some((criterion) => criterion.id.toLowerCase() === id)) return id;
  }
}

/** The approvers a new "Needs approval" starts with: every person of the team. */
export const EVERY_PERSON_RULE: PrincipalRule = {
  allow: [{ type: 'everyone', scope: 'people' }],
  deny: [],
};
