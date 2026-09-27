/**
 * Agent members (docs/design/agents-and-pipelines.md §1): every person has one agent user
 * (`ethan-ai`, "Ethan AI", `kind: 'agent'`) that everything written through their API keys is
 * authored by. These helpers name them the same way everywhere.
 */

interface MaybeAgent {
  kind?: 'agent' | 'human' | null;
  agentOwner?: { name: string } | null;
}

/** The key (and harness) an agent's write went through. */
export interface AgentVia {
  keyName?: string | null;
  agentName?: string | null;
}

/** True for agent members (`kind: 'agent'`); people and deleted users are false. */
export function isAgentUser<T extends MaybeAgent>(
  user: T | null | undefined,
): user is T & { kind: 'agent' } {
  return user?.kind === 'agent';
}

/** "Ethan’s agent" (or "An agent" when the owner is unknown). */
export function agentOwnerLabel(user: MaybeAgent): string {
  return user.agentOwner ? `${user.agentOwner.name}’s agent` : 'An agent';
}

/** "via Claude (MSI key)", "via Claude", "via the MSI key", or null when nothing is known. */
export function agentViaLabel(via: AgentVia | null | undefined): string | null {
  const agentName = via?.agentName?.trim();
  const keyName = via?.keyName?.trim();
  if (agentName && keyName) return `via ${agentName} (${keyName} key)`;
  if (agentName) return `via ${agentName}`;
  if (keyName) return `via the ${keyName} key`;
  return null;
}

/** Tooltip of an agent author: "Ethan’s agent · via Claude (MSI key)". */
export function agentTitle(user: MaybeAgent, via?: AgentVia | null): string {
  const viaLabel = agentViaLabel(via);
  return viaLabel ? `${agentOwnerLabel(user)} · ${viaLabel}` : agentOwnerLabel(user);
}
