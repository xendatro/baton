import {
  AGENT_USERNAME_SUFFIX,
  type Principal,
  type PrincipalRule,
  type PrincipalScope,
} from '@shared/principals';
import type { UserSummary } from '@shared/schemas/core';

/**
 * Data and wording for "who" rules (docs/design/agents-and-pipelines.md §2) on the web: the
 * people, agents, team roles and project roles a rule can name, and a rule in words.
 */

export interface PrincipalRoleOption {
  id: string;
  name: string;
  color: string | null;
  /** The team's `@everyone` role. */
  isEveryone?: boolean;
}

export interface PrincipalOptions {
  /** Team members (people and agent members). */
  users: readonly UserSummary[];
  roles: readonly PrincipalRoleOption[];
  projectRoles: readonly PrincipalRoleOption[];
}

export const EMPTY_RULE: PrincipalRule = { allow: [], deny: [] };

/** Agent members are `kind: 'agent'` users named `<owner>-ai` (design §1). */
export function isAgentUser(user: UserSummary & { kind?: string }): boolean {
  return user.kind === 'agent' || user.username.endsWith(AGENT_USERNAME_SUFFIX);
}

export const SCOPE_LABELS: Record<PrincipalScope, string> = {
  both: 'People and agents',
  people: 'People only',
  agents: 'Agents only',
};

/** Same principal (ignoring the scope)? */
export function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'user' && b.type === 'user') return a.userId === b.userId;
  if ((a.type === 'role' || a.type === 'project_role') && a.type === b.type) {
    return a.roleId === (b as { roleId: string }).roleId;
  }
  return a.type === 'everyone';
}

/** A stable key for lists. */
export function principalKey(principal: Principal): string {
  switch (principal.type) {
    case 'user':
      return `user:${principal.userId}`;
    case 'role':
      return `role:${principal.roleId}`;
    case 'project_role':
      return `project_role:${principal.roleId}`;
    case 'everyone':
      return 'everyone';
  }
}

const SCOPE_SUFFIX: Record<PrincipalScope, string> = {
  both: '',
  people: 'people',
  agents: 'agents',
};

/** "@ann", "Reviewer (people)", "QA (project role)", "every agent". */
export function principalLabel(principal: Principal, options: PrincipalOptions): string {
  switch (principal.type) {
    case 'user': {
      const user = options.users.find((candidate) => candidate.id === principal.userId);
      return user ? `@${user.username}` : 'a former member';
    }
    case 'everyone':
      return principal.scope === 'both'
        ? 'everyone'
        : principal.scope === 'people'
          ? 'every person'
          : 'every agent';
    case 'role': {
      const role = options.roles.find((candidate) => candidate.id === principal.roleId);
      const name = role ? (role.isEveryone ? '@everyone' : role.name) : 'a deleted role';
      const scope = SCOPE_SUFFIX[principal.scope];
      return scope ? `${name} (${scope})` : name;
    }
    case 'project_role': {
      const role = options.projectRoles.find((candidate) => candidate.id === principal.roleId);
      const scope = SCOPE_SUFFIX[principal.scope];
      return `${role?.name ?? 'a deleted project role'} (project role${scope ? `, ${scope}` : ''})`;
    }
  }
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

/** A rule in words, as the server writes it: "Reviewer (people) or @ann, except @ben". */
export function describeRule(rule: PrincipalRule | null | undefined, options: PrincipalOptions) {
  if (!rule || rule.allow.length === 0) return 'nobody';
  const allowed = joinOr(rule.allow.map((principal) => principalLabel(principal, options)));
  if (rule.deny.length === 0) return allowed;
  return `${allowed}, except ${joinOr(rule.deny.map((principal) => principalLabel(principal, options)))}`;
}
