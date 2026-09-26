import { BotIcon, SparkleIcon, TerminalIcon, type LucideIcon } from 'lucide-react';
import { cn } from '@web/lib/utils';
import { AVATAR_SIZE_CLASSES } from './avatarSizes';
import { UserAvatar, type AvatarSize, type AvatarUser } from './UserAvatar';

/** Mark and color per well-known agent (names from `shared/agents.ts`); others get a bot. */
const AGENT_MARKS: Readonly<Record<string, { icon: LucideIcon; color: string }>> = {
  Claude: { icon: SparkleIcon, color: '#d97757' },
  Codex: { icon: TerminalIcon, color: '#18181b' },
};
const DEFAULT_MARK = { icon: BotIcon, color: 'var(--primary)' };

/** An agent's round mark ("Claude": an orange spark). */
export function AgentMark({ agentName, className }: { agentName: string; className?: string }) {
  const { icon: Icon, color } = AGENT_MARKS[agentName] ?? DEFAULT_MARK;
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-full text-white', className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      <Icon className="size-[60%]" />
    </span>
  );
}

export interface ActorAvatarProps {
  user: AvatarUser | null;
  /** The agent the action came through ("Claude"), if any. */
  agentName?: string | null;
  size?: AvatarSize;
  className?: string;
}

/**
 * The avatar of whoever wrote something (BAT-6): the user's picture, or for an agent's write the
 * agent's mark with the key owner's picture as a small badge at the bottom right.
 */
export function ActorAvatar({ user, agentName, size = 'md', className }: ActorAvatarProps) {
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
