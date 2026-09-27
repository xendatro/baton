import type { UserSummary, ViaKey } from '@shared/schemas/core';
import type { MentionAgent } from '@web/components/editor/mention';
import { isAgentUser } from '@web/lib/agentMembers';

/** Something written in a thread: the task or issue itself, or a reply. */
export interface ThreadWrite {
  author: UserSummary | null;
  via?: ViaKey | null;
  /** ISO time of the write: the latest write names the agent's harness. */
  createdAt?: string;
}

/**
 * The agent members that wrote in a thread (BAT-12, agents A), in order of first appearance, for
 * `@` suggestions: `@ethan-ai` is an ordinary username mention. Each shows the harness of its
 * latest write through a key that named one ("Claude"), or the generic agent mark. People's
 * writes, including older ones through a key (BAT-6), suggest nobody.
 */
export function threadAgents(writes: readonly ThreadWrite[]): MentionAgent[] {
  const agents = new Map<string, MentionAgent & { at: string }>();
  for (const { author, via, createdAt = '' } of writes) {
    if (!author || !isAgentUser(author)) continue;
    let agent = agents.get(author.id);
    if (!agent) {
      agent = { user: author, agentName: null, at: '' };
      agents.set(author.id, agent);
    }
    if (via?.agentName && createdAt >= agent.at) {
      agent.agentName = via.agentName;
      agent.at = createdAt;
    }
  }
  return [...agents.values()].map(({ user, agentName }) => ({ user, agentName }));
}
