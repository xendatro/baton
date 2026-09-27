import { BotIcon } from 'lucide-react';
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siWindsurf } from 'simple-icons';
import { cn } from '@web/lib/utils';
import { AVATAR_SIZE_CLASSES } from './avatarSizes';
import { OPENAI_BLOSSOM } from './openaiLogo';
import { UserAvatar, type AvatarSize, type AvatarUser } from './UserAvatar';

/** A harness's official logo: an SVG path (simple-icons' 24×24 box unless `viewBox` says). */
interface BrandLogo {
  title: string;
  /** Brand color, without `#`. */
  hex: string;
  path: string;
  viewBox?: string;
}

/**
 * The logo of each well-known harness (BAT-8), keyed by the agent names of `shared/agents.ts`.
 * Brand marks come from simple-icons, except OpenAI's (for Codex), which it doesn't carry.
 */
const AGENT_LOGOS: Readonly<Record<string, BrandLogo>> = {
  Claude: siClaude,
  Codex: OPENAI_BLOSSOM,
  Cursor: siCursor,
  Gemini: siGooglegemini,
  Copilot: siGithubcopilot,
  Windsurf: siWindsurf,
};

/**
 * An agent's round mark: its harness's logo in white on the brand color ("Claude": the Claude
 * spark on its orange), or a bot on the primary color for agents we don't know.
 */
export function AgentMark({ agentName, className }: { agentName: string; className?: string }) {
  const logo = Object.hasOwn(AGENT_LOGOS, agentName) ? AGENT_LOGOS[agentName] : undefined;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full text-white dark:ring-1 dark:ring-white/15',
        className,
      )}
      style={{ backgroundColor: logo ? `#${logo.hex}` : 'var(--primary)' }}
      data-agent-logo={logo ? logo.title : 'generic'}
      aria-hidden="true"
    >
      {logo ? (
        <svg
          viewBox={logo.viewBox ?? '0 0 24 24'}
          className="size-[58%]"
          fill="currentColor"
          focusable="false"
        >
          <path d={logo.path} />
        </svg>
      ) : (
        <BotIcon className="size-[60%]" />
      )}
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
