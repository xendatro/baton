import { agentTitle, isAgentUser } from '@web/lib/agentMembers';
import { cn } from '@web/lib/utils';
import { AgentMark } from './AgentMark';
import { AVATAR_SIZE_CLASSES } from './avatarSizes';
import { UserAvatar, type AvatarSize, type AvatarUser } from './UserAvatar';

export { AgentMark } from './AgentMark';

export interface ActorAvatarProps {
  user: AvatarUser | null;
  /** The agent the action came through ("Claude"), if any. */
  agentName?: string | null;
  /** The API key the action came through ("MSI"), if any (tooltips of agent members). */
  keyName?: string | null;
  size?: AvatarSize;
  className?: string;
}

/**
 * The avatar of whoever wrote something. An agent member's write (`user.kind === 'agent'`) shows
 * the logo of the harness it used (or the generic agent mark) with its owner's picture as the
 * badge. Older writes by a person through a key (BAT-6) show the agent's mark with the key
 * owner's picture as the badge; anything else is the user's picture.
 */
export function ActorAvatar({
  user,
  agentName,
  keyName,
  size = 'md',
  className,
}: ActorAvatarProps) {
  if (user && isAgentUser(user)) {
    return (
      <UserAvatar
        user={user}
        agentName={agentName}
        title={agentTitle(user, { agentName, keyName })}
        size={size}
        className={className}
      />
    );
  }
  if (!agentName) return <UserAvatar user={user} size={size} className={className} />;
  return (
    <span
      className={cn('relative inline-flex shrink-0', AVATAR_SIZE_CLASSES[size], className)}
      title={user ? `${agentName} via ${user.name}` : agentName}
      aria-hidden="true"
    >
      <AgentMark agentName={agentName} className="size-full" />
      <UserAvatar
        user={user}
        size="xs"
        className="absolute -right-0.5 -bottom-0.5 size-[55%] ring-2 ring-card"
      />
    </span>
  );
}
