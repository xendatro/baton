import { agentHandle } from '@shared/agents';
import type { UserSummary, ViaKey } from '@shared/schemas/core';
import type { MentionAgent } from '@web/components/editor/mention';
import { mentionAtStart } from '@web/lib/mentions';

/** Something written in a thread: the task or issue itself, or a reply. */
export interface ThreadWrite {
  author: UserSummary | null;
  via?: ViaKey | null;
}

/**
 * The agents that wrote in a thread (BAT-12), in order of first appearance, for `@` suggestions.
 * An agent is listed once however many keys it wrote through (`@claude` reaches all of them),
 * and only when its handle reads back as a mention.
 */
export function threadAgents(writes: readonly ThreadWrite[]): MentionAgent[] {
  const agents = new Map<string, MentionAgent & { keyIds: Set<string> }>();
  for (const { author, via } of writes) {
    if (!via?.agentName) continue;
    const handle = agentHandle(via.agentName);
    const parsed = mentionAtStart(`@${handle}`);
    if (parsed?.kind !== 'user' || parsed.id !== handle) continue;
    let agent = agents.get(handle);
    if (!agent) {
      agent = { name: via.agentName, handle, keys: [], keyIds: new Set() };
      agents.set(handle, agent);
    }
    if (agent.keyIds.has(via.keyId)) continue;
    agent.keyIds.add(via.keyId);
    agent.keys.push(author ? `${author.name}’s ${via.keyName}` : via.keyName);
  }
  return [...agents.values()].map(({ name, handle, keys }) => ({ name, handle, keys }));
}
