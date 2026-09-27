import { Avatar, AvatarFallback, AvatarImage } from '@web/components/ui/avatar';
import { agentOwnerLabel, isAgentUser } from '@web/lib/agentMembers';
import { hueFromString, initials } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { AgentMark } from './AgentMark';
import { AVATAR_SIZE_CLASSES } from './avatarSizes';

export interface AvatarUser {
  id: string;
  name: string;
  username?: string | null;
  image?: string | null;
  /** `'agent'` for agent members (shown as an agent mark with their owner's picture). */
  kind?: 'agent' | 'human' | null;
  agentOwner?: AvatarUser | null;
}

/** Initials text per size (the fallback has its own text size, so it is set there). */
const TEXT = {
  xs: 'text-[0.5rem]',
  sm: 'text-[0.55rem]',
  md: 'text-[0.6rem]',
  lg: 'text-xs',
  xl: 'text-base',
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZE_CLASSES;

export interface UserAvatarProps {
  /** Null renders a neutral placeholder for deleted users. */
  user: AvatarUser | null;
  size?: AvatarSize;
  className?: string;
  /** For agent members: the harness whose logo to show ("Claude"); generic mark when unknown. */
  agentName?: string | null;
  /** Tooltip (default: the name, or "Ethan’s agent" for agents). */
  title?: string;
}

/**
 * Profile picture, or initials on a color derived from the user id. Agent members show the
 * harness's mark (`agentName`, or the generic agent mark) with their owner's picture as a badge.
 */
export function UserAvatar({ user, size = 'md', className, agentName, title }: UserAvatarProps) {
  if (user && isAgentUser(user)) {
    return (
      <span
        className={cn(
          'relative inline-flex shrink-0 rounded-full',
          AVATAR_SIZE_CLASSES[size],
          className,
        )}
        title={title ?? `${user.name} (${agentOwnerLabel(user)})`}
        aria-hidden="true"
        data-agent-member=""
      >
        <AgentMark agentName={agentName ?? ''} className="size-full" />
        {user.agentOwner ? (
          <UserAvatar
            user={user.agentOwner}
            size="xs"
            className="absolute -right-0.5 -bottom-0.5 size-[55%] ring-2 ring-card"
          />
        ) : null}
      </span>
    );
  }
  const label = title ?? (user ? user.name || user.username || 'User' : 'Deleted user');
  const hue = user ? hueFromString(user.id) : 0;
  return (
    <Avatar className={cn(AVATAR_SIZE_CLASSES[size], className)} aria-hidden="true" title={label}>
      {user?.image ? <AvatarImage src={user.image} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback
        className={cn('leading-none font-semibold tracking-tight text-white', TEXT[size])}
        style={{
          backgroundColor: user ? `oklch(0.55 0.13 ${hue})` : 'var(--muted-foreground)',
        }}
      >
        {user ? initials(user.name, user.username ?? '?').slice(0, size === 'xs' ? 1 : 2) : '?'}
      </AvatarFallback>
    </Avatar>
  );
}

export interface AvatarStackProps {
  users: readonly AvatarUser[];
  /** Avatars shown before collapsing the rest into "+N". */
  max?: number;
  size?: AvatarSize;
  className?: string;
}

/** Overlapping avatars with a "+N" overflow count. */
export function AvatarStack({ users, max = 3, size = 'md', className }: AvatarStackProps) {
  const shown = users.slice(0, max);
  const hidden = users.length - shown.length;
  const names = users.map((user) => user.name).join(', ');
  return (
    <span className={cn('inline-flex items-center -space-x-1.5', className)} title={names}>
      <span className="sr-only">{names}</span>
      {shown.map((user) => (
        <UserAvatar key={user.id} user={user} size={size} className="ring-2 ring-background" />
      ))}
      {hidden > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            AVATAR_SIZE_CLASSES[size],
            TEXT[size],
            'relative inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-background',
          )}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
