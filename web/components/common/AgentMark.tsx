import { BotIcon } from 'lucide-react';
import { siClaude, siCursor, siGithubcopilot, siGooglegemini, siWindsurf } from 'simple-icons';
import { cn } from '@web/lib/utils';
import { OPENAI_BLOSSOM } from './openaiLogo';

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
