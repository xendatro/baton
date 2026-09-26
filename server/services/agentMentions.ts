import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { agentHandle } from '@shared/agents';
import type { Actor, AppDeps } from '../context';
import type { Tx } from '../db';
import * as s from '../db/schema';
import { errors } from '../lib/errors';
import { newId } from '../lib/ids';
import { addedMentions } from '../lib/mentions';
import { getReply, type ReplyWithContext } from './replies';

/**
 * @agent mentions (BAT-6). A reply that names an agent (`@claude`) on a task or issue where an
 * API key of that agent replied, or which it created, is queued for that key. The agent collects
 * it with the MCP tool `wait_for_mentions`, which blocks until one arrives. Keys that never took
 * part in the thread are not told, so several agents of one user don't wake each other.
 */

/** Longest `wait_for_mentions` wait (below common MCP client timeouts). */
export const MAX_MENTION_WAIT_SECONDS = 110;

export interface MentionedReply {
  id: string;
  teamId: string;
  parentType: 'issue' | 'task';
  parentId: string;
  body: string;
}

/**
 * Queues the agent mentions of a new or edited reply (inside its write; only mentions added by
 * an edit count). The reply's own key never mentions itself.
 */
export function recordAgentMentions(
  tx: Tx,
  actor: Actor,
  reply: MentionedReply,
  previousBody?: string | null,
): void {
  const handles = new Set(addedMentions(reply.body, previousBody).usernames);
  if (handles.size === 0) return;

  const repliedKeys = tx
    .selectDistinct({ keyId: s.reply.viaKeyId })
    .from(s.reply)
    .where(
      and(
        eq(s.reply.parentType, reply.parentType),
        eq(s.reply.parentId, reply.parentId),
        isNotNull(s.reply.viaKeyId),
        isNull(s.reply.deletedAt),
      ),
    )
    .all()
    .map((row) => row.keyId);
  const parentTable = reply.parentType === 'task' ? s.task : s.issue;
  const creatorKey = tx
    .select({ keyId: parentTable.viaKeyId })
    .from(parentTable)
    .where(eq(parentTable.id, reply.parentId))
    .get()?.keyId;
  const keyIds = [...new Set([...repliedKeys, creatorKey])].filter(
    (id): id is string => Boolean(id) && id !== actor.key?.id,
  );
  if (keyIds.length === 0) return;

  const keys = tx
    .select({ id: s.apiKey.id, agentName: s.apiKey.agentName })
    .from(s.apiKey)
    .innerJoin(
      s.teamMember,
      and(eq(s.teamMember.userId, s.apiKey.userId), eq(s.teamMember.teamId, reply.teamId)),
    )
    .where(and(inArray(s.apiKey.id, keyIds), isNull(s.apiKey.revokedAt)))
    .all()
    .filter((key) => key.agentName && handles.has(agentHandle(key.agentName)));
  if (keys.length === 0) return;

  const now = new Date();
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
 * MCP `wait_for_mentions`: the key's pending @agent mentions at once, or, when there are none,
 * the first to arrive within `timeoutSeconds` (0 checks without waiting).
 */
export async function waitForMentions(
  deps: AppDeps,
  actor: Actor,
  input: { timeoutSeconds: number },
  signal?: AbortSignal,
): Promise<{ mentions: AgentMention[] }> {
  const key = actor.key;
  if (!key) throw errors.validation('Mentions are collected through an API key');
  if (!key.agentName) {
    throw errors.validation(
      'This key has no agent name yet: it is learned from the MCP client when it connects',
    );
  }
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
