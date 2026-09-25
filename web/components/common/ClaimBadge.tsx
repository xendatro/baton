import { BotIcon, HandIcon } from 'lucide-react';
import type { UserSummary, ViaKey } from '@shared/schemas/core';
import { formatAge, formatDateTime } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { useNow } from './useNow';
import { UserAvatar } from './UserAvatar';

export interface ClaimBadgeProps {
  holder: UserSummary | null;
  /** The key holding the claim; null for claims made on the web ("ethan (web)"). */
  via: ViaKey | null;
  /** ISO timestamps. */
  claimedAt: string;
  expiresAt: string;
  className?: string;
}

/**
 * "ethan via Claude on laptop · 4m": who is working on an item. An expired lease is shown
 * struck through and muted, since the item is free to claim again.
 */
export function ClaimBadge({ holder, via, claimedAt, expiresAt, className }: ClaimBadgeProps) {
  const now = useNow();
  const stale = new Date(expiresAt).getTime() <= now;
  const holderName = holder?.name ?? 'Deleted user';
  const description = `${holderName} ${via ? `via ${via.keyName}` : '(web)'} claimed this ${formatAge(claimedAt, new Date(now))} ago; ${stale ? 'the claim expired' : 'lease ends'} ${formatDateTime(expiresAt)}`;
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 text-xs',
        stale
          ? 'border-dashed text-muted-foreground'
          : 'border-emerald-500/40 bg-emerald-500/10 text-foreground',
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
        <UserAvatar user={holder} size="xs" />
        <span className={cn('truncate', stale && 'line-through')}>
          <span className="font-medium">{holderName}</span>{' '}
          {via ? <span className="text-muted-foreground">via {via.keyName}</span> : '(web)'}
        </span>
        <span className="shrink-0 text-muted-foreground">
          · {stale ? 'expired' : formatAge(claimedAt, new Date(now))}
        </span>
      </span>
    </span>
  );
}
