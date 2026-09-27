import { BotIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActorSource } from '@shared/constants';
import type { UserSummary, ViaKey } from '@shared/schemas/core';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@web/components/ui/hover-card';
import { agentOwnerLabel, agentTitle, agentViaLabel, isAgentUser } from '@web/lib/agentMembers';
import { useReadableTextColor } from '@web/lib/colors';
import { cn } from '@web/lib/utils';
import { ActorAvatar } from './AgentAvatar';
import { AgentBadge } from './AgentBadge';
import { AgentMark } from './AgentMark';
import { UserAvatar, type AvatarSize } from './UserAvatar';

export interface UserNameProps {
  /** Null for deleted users (or the system, with `source="system"`). */
  user: UserSummary | null;
  /** The API key the action went through: renders "via <key>" with a bot icon. */
  via?: ViaKey | null;
  source?: ActorSource;
  /** Show the avatar before the name. */
  avatar?: AvatarSize | false;
  /** Name color (the member's highest colored role). */
  color?: string | null;
  /** Show a profile card on hover (default true). */
  hovercard?: boolean;
  className?: string;
}

/**
 * Display name (with @username on hover) and, for agent writes, "via <key>". Agent members read
 * "Ethan AI" with an "AI" badge, the key and harness in the tooltip.
 */
export function UserName({
  user,
  via,
  source,
  avatar = false,
  color,
  hovercard = true,
  className,
}: UserNameProps) {
  // Role colors are darkened (light theme) or lightened (dark theme) until the name is readable.
  const colorStyle = useReadableTextColor(color);
  if (!user) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-muted-foreground', className)}>
        {source === 'system' ? 'Baton' : <span className="italic">Deleted user</span>}
      </span>
    );
  }
  const name = (
    <span
      className="truncate font-medium text-foreground"
      style={colorStyle}
      title={hovercard ? undefined : `@${user.username}`}
    >
      {user.name}
    </span>
  );
  if (isAgentUser(user)) {
    // Agent members (agents A): "Ethan AI [AI]", "Ethan’s agent · via Claude (MSI key)" on hover.
    const agentLabel = (
      <span
        className="truncate font-medium text-foreground"
        style={colorStyle}
        title={hovercard ? undefined : `@${user.username} · ${agentTitle(user, via)}`}
      >
        {user.name}
      </span>
    );
    return (
      <span
        className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
        title={hovercard ? agentTitle(user, via) : undefined}
      >
        {avatar ? (
          <ActorAvatar
            user={user}
            agentName={via?.agentName}
            keyName={via?.keyName}
            size={avatar}
          />
        ) : null}
        {hovercard ? (
          <UserHoverCard user={user} via={via}>
            {agentLabel}
          </UserHoverCard>
        ) : (
          agentLabel
        )}
        <AgentBadge />
      </span>
    );
  }
  if (via?.agentName) {
    // BAT-6: "Claude via Ethan's MSI" — the agent wrote it, through Ethan's key.
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
        {avatar ? <ActorAvatar user={user} agentName={via.agentName} size={avatar} /> : null}
        <span className="truncate font-medium text-foreground">{via.agentName}</span>
        <span
          className="inline-flex min-w-0 items-center gap-1 text-muted-foreground"
          title={`Written by ${via.agentName}, an agent using ${user.name}’s API key “${via.keyName}”`}
        >
          <span>via</span>
          {hovercard ? <UserHoverCard user={user}>{name}</UserHoverCard> : name}
          <span className="-ml-1 truncate">’s {via.keyName}</span>
        </span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      {avatar ? <UserAvatar user={user} size={avatar} /> : null}
      {hovercard ? <UserHoverCard user={user}>{name}</UserHoverCard> : name}
      {via ? <ViaKeyLabel via={via} /> : null}
    </span>
  );
}

export function ViaKeyLabel({ via, className }: { via: ViaKey; className?: string }) {
  const agent = via.agentName ? `${via.agentName}, an agent` : 'an agent';
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1 text-muted-foreground', className)}
      title={`Done by ${agent} using the API key “${via.keyName}”`}
    >
      <span>via</span>
      {via.agentName ? (
        <AgentMark agentName={via.agentName} className="size-3.5 shrink-0" />
      ) : (
        <BotIcon className="size-3.5 shrink-0" aria-label="agent" />
      )}
      <span className="truncate">
        {via.agentName ? `${via.agentName} · ${via.keyName}` : via.keyName}
      </span>
    </span>
  );
}

export interface UserHoverCardProps {
  user: UserSummary;
  /** For agent members' writes: the key and harness it went through. */
  via?: ViaKey | null;
  children: ReactNode;
}

/**
 * Wraps `children` in a hover card showing the user's avatar, name and @username; for agent
 * members also the "AI" badge and whose agent it is.
 */
export function UserHoverCard({ user, via, children }: UserHoverCardProps) {
  const agent = isAgentUser(user);
  const viaLabel = agent ? agentViaLabel(via) : null;
  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          className="min-w-0 cursor-default truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          tabIndex={0}
        >
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent className="w-64 p-3" align="start">
        <div className="flex items-center gap-3">
          <UserAvatar user={user} agentName={via?.agentName} size="xl" />
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-semibold">{user.name}</span>
              {agent ? <AgentBadge /> : null}
            </p>
            <p className="truncate text-sm text-muted-foreground">@{user.username}</p>
            {agent ? (
              <p className="truncate text-xs text-muted-foreground">{agentOwnerLabel(user)}</p>
            ) : null}
            {viaLabel ? <p className="truncate text-xs text-muted-foreground">{viaLabel}</p> : null}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
