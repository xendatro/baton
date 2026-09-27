import { BotIcon, HandIcon } from 'lucide-react';
import type { UserSummary, ViaKey } from '@shared/schemas/core';
import { agentTitle, isAgentUser } from '@web/lib/agentMembers';
import { formatAge, formatDateTime } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { AgentBadge } from './AgentBadge';
import { useNow } from './useNow';
import { UserAvatar } from './UserAvatar';

export interface ClaimBadgeProps {
  holder: UserSummary | null;
  /** The key holding the claim; null for claims made on the web ("ethan (web)"). */
  via: ViaKey | null;
  /** ISO timestamps. */
  claimedAt: string;
  className?: string;
}

/**
 * "ethan via Claude on laptop · 4m": who is working on an item. Claims are held until released,
 * so there is no expiry to show.
 */
export function ClaimBadge({ holder, via, claimedAt, className }: ClaimBadgeProps) {
  const now = useNow();
  const holderName = holder?.name ?? 'Deleted user';
  // An agent member's claim: "Ethan AI [AI]", the key it used in the tooltip (agents A).
  const agent = isAgentUser(holder);
  const how =
    agent && holder ? `(${agentTitle(holder, via)})` : via ? `via ${via.keyName}` : '(web)';
  const description = `${holderName} ${how} claimed this ${formatAge(claimedAt, new Date(now))} ago (${formatDateTime(claimedAt)})`;
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 text-xs',
        'border-emerald-500/40 bg-emerald-500/10 text-foreground',
        className,
      )}
      title={description}
    >
      <span className="sr-only">{description}</span>
      <span aria-hidden="true" className="inline-flex min-w-0 items-center gap-1.5">
        {via ? (
          <BotIcon className="size-3.5 shrink-0" />
        ) : (
          <HandIcon className="size-3.5 shrink-0" />
        )}
        <UserAvatar user={holder} agentName={via?.agentName} size="xs" />
        <span className="truncate">
          <span className="font-medium">{holderName}</span>{' '}
          {agent ? null : via ? (
            <span className="text-muted-foreground">via {via.keyName}</span>
          ) : (
            '(web)'
          )}
        </span>
        {agent ? <AgentBadge /> : null}
        <span className="shrink-0 text-muted-foreground">
          · {formatAge(claimedAt, new Date(now))}
        </span>
      </span>
    </span>
  );
}
