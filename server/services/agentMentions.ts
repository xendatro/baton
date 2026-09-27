import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Actor, AppDeps } from '../context';
import type { Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { addedMentions } from '../lib/mentions';
import { agentPauseReason } from './agents';
import { getReply, type ReplyWithContext } from './replies';

/**
 * Agent mentions. Since agents A, `@ethan-ai` is an ordinary username mention of Ethan's agent
 * member; a reply mentioning an agent member of the team is queued (`agent_mention`) for every
 * active API key of the agent's owner, since each key is a session of that agent. The agent
 * collects it with the MCP tool `wait_for_mentions`, which blocks until one arrives. Wave 2C
 * replaces this with agent jobs and `start_listener` (docs/design/agents-and-pipelines.md §4).
 */

/** Longest `wait_for_mentions` wait (below common MCP client timeouts). */
export const MAX_MENTION_WAIT_SECONDS = 110;

export interface MentionedReply {
  id: string;
  teamId: string;
  projectId: string;
  parentType: 'issue' | 'task';
  parentId: string;
  body: string;
}

/**
 * Queues the agent-member mentions of a new or edited reply (inside its write; only mentions
 * added by an edit count). An agent never mentions itself, and a paused agent is not woken.
 */
export function recordAgentMentions(
  tx: Tx,
  actor: Actor,
  reply: MentionedReply,
  previousBody?: string | null,
): void {
  const usernames = addedMentions(reply.body, previousBody).usernames;
  if (usernames.length === 0) return;

  const agents = tx
    .select({ id: s.user.id, ownerId: s.user.agentOwnerId })
    .from(s.user)
    .innerJoin(
      s.teamMember,
      and(eq(s.teamMember.userId, s.user.id), eq(s.teamMember.teamId, reply.teamId)),
    )
    .where(and(inArray(s.user.username, usernames), eq(s.user.kind, 'agent')))
    .all()
    .flatMap((row) =>
      row.ownerId && row.id !== actor.userId ? [{ agentId: row.id, ownerId: row.ownerId }] : [],
    )
    .filter((agent) => agentPauseReason(tx, agent, reply.teamId, reply.projectId) === null);
  if (agents.length === 0) return;

  const now = new Date();
  const keys = tx
    .select({ id: s.apiKey.id })
    .from(s.apiKey)
    .where(
      and(
        inArray(
          s.apiKey.userId,
          agents.map((agent) => agent.ownerId),
        ),
        isNull(s.apiKey.revokedAt),
        or(isNull(s.apiKey.expiresAt), gt(s.apiKey.expiresAt, now)),
      ),
    )
    .all();
  if (keys.length === 0) return;

  tx.insert(s.agentMention)
    .values(
      keys.map((key) => ({
        id: newId(),
        keyId: key.id,
        teamId: reply.teamId,
        replyId: reply.id,
        parentType: reply.parentType,
        parentId: reply.parentId,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
}

export interface AgentMention {
  /** The reply that mentioned the agent, with the ref and URL of its task or issue. */
  reply: ReplyWithContext;
  parentType: 'issue' | 'task';
}

/**
 * Hands out the key's undelivered mentions (oldest first) and marks them delivered. Mentions in
 * replies or items that were deleted since, or that the key's user can no longer see, are
 * dropped.
 */
function takeMentions(deps: AppDeps, actor: Actor, keyId: string): AgentMention[] {
  const rows = deps.db.orm
    .select()
    .from(s.agentMention)
    .where(and(eq(s.agentMention.keyId, keyId), isNull(s.agentMention.deliveredAt)))
    .orderBy(asc(s.agentMention.createdAt))
    .limit(50)
    .all();
  if (rows.length === 0) return [];
  const mentions: AgentMention[] = [];
  for (const row of rows) {
    try {
      mentions.push({ reply: getReply(deps, actor, row.replyId), parentType: row.parentType });
    } catch {
      // Deleted, or no longer visible: skip (it is still marked delivered below).
    }
  }
  const ids = rows.map((row) => row.id);
  deps.db.write((tx) => {
    tx.update(s.agentMention)
      .set({ deliveredAt: new Date() })
      .where(inArray(s.agentMention.id, ids))
      .run();
  });
  return mentions;
}

/**
 * MCP `wait_for_mentions`: the key's pending mentions of its agent member at once, or, when
 * there are none, the first to arrive within `timeoutSeconds` (0 checks without waiting).
 */
export async function waitForMentions(
  deps: AppDeps,
  actor: Actor,
  input: { timeoutSeconds: number },
  signal?: AbortSignal,
): Promise<{ mentions: AgentMention[] }> {
  const key = actor.key;
  if (!key) throw errors.validation('Mentions are collected through an API key');
  const first = takeMentions(deps, actor, key.id);
  if (first.length > 0 || input.timeoutSeconds <= 0) return { mentions: first };

  const timeoutMs = Math.min(input.timeoutSeconds, MAX_MENTION_WAIT_SECONDS) * 1000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (mentions: AgentMention[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve({ mentions });
    };
    const onAbort = () => finish([]);
    const timer = setTimeout(() => finish(takeMentions(deps, actor, key.id)), timeoutMs);
    // Mentions are queued inside reply writes, which emit reply events after commit.
    const unsubscribe = deps.events.subscribe((event) => {
      if (settled || event.entityType !== 'reply') return;
      if (event.type !== 'reply.created' && event.type !== 'reply.updated') return;
      const mentions = takeMentions(deps, actor, key.id);
      if (mentions.length > 0) finish(mentions);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
