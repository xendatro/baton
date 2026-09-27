import { COLOR_PALETTE } from '@shared/constants';
import type { Principal, PrincipalRule } from '@shared/principals';
import type { HandoffMode, StageRules } from '@shared/schemas/pipelines';
import type { Status } from '@shared/schemas/projects';
import { isAgentUser, type PrincipalOptions } from '@web/components/pickers/principals';

/** Wording of stage rules (design §5) in the status dialog (Project settings → Statuses). */

/** "Assign to": the modes that pick from a custom list of people, agents and roles. */
export const CUSTOM_HANDOFF_MODES = ['specific', 'pool', 'round_robin', 'least_busy'] as const;
export type CustomHandoffMode = (typeof CUSTOM_HANDOFF_MODES)[number];

export function isCustomHandoff(mode: HandoffMode): mode is CustomHandoffMode {
  return (CUSTOM_HANDOFF_MODES as readonly string[]).includes(mode);
}

/** "Who gets it", for a custom list. */
export const CUSTOM_HANDOFF_LABELS: Record<CustomHandoffMode, string> = {
  specific: 'All of them, together',
  pool: 'Whoever claims it first',
  round_robin: 'One of them, taking turns',
  least_busy: 'One of them, whoever has the least work',
};

/** How many rules a stage has (shown on its Rules button). */
export function countRules(rules: StageRules | undefined): number {
  if (!rules) return 0;
  return [
    rules.instructions.trim() !== '',
    rules.handoff.mode !== 'keep',
    rules.notify !== null,
    rules.onEnter.resolveIssues,
    rules.onEnter.releaseClaim,
    rules.onEnter.notifyAuthor,
    !rules.onEnter.notifyAssignees,
    rules.onEnter.notifyPreviousHolder,
    !rules.blocksDependents,
    !rules.claimable,
    rules.exitCriteria.length > 0,
    rules.moveRule !== null,
    rules.approvals !== null,
    rules.autoAdvance,
    rules.nextStatusId !== null,
  ].filter(Boolean).length;
}

/** A color no other status uses yet (the first of the palette when all are taken). */
export function suggestColor(existing: readonly Status[]): string {
  const used = new Set(existing.map((status) => status.color));
  return (COLOR_PALETTE.slice(1).find((color) => !used.has(color.hex)) ?? COLOR_PALETTE[0]).hex;
}

function reaches(
  principal: Principal,
  options: PrincipalOptions,
): { people: boolean; agents: boolean } {
  if (principal.type === 'user') {
    const user = options.users.find((candidate) => candidate.id === principal.userId);
    const agent = user ? isAgentUser(user) : false;
    return { people: !agent, agents: agent };
  }
  return {
    people: principal.scope !== 'agents',
    agents: principal.scope !== 'people',
  };
}

/** "2 different people must approve", "…people or agents…", from who may approve. */
export function approvalsSentence(
  count: number,
  rule: PrincipalRule,
  options: PrincipalOptions,
): string {
  if (rule.allow.length === 0) return 'Add who can approve.';
  const kinds = rule.allow.map((principal) => reaches(principal, options));
  const people = kinds.some((kind) => kind.people);
  const agents = kinds.some((kind) => kind.agents);
  const who =
    people && agents
      ? count === 1
        ? 'person or agent'
        : 'people or agents'
      : agents
        ? count === 1
          ? 'agent'
          : 'agents'
        : count === 1
          ? 'person'
          : 'people';
  return count === 1
    ? `1 ${who} must approve before it moves on.`
    : `${count} different ${who} must approve before it moves on.`;
}
