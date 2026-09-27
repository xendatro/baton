import { cn } from '@web/lib/utils';

/**
 * The small "AI" text badge after an agent member's name (docs/design/agents-and-pipelines.md
 * §1), so agents are told apart by text, not only by their avatar.
 */
export function AgentBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded border border-primary/30 bg-primary/10 px-1 text-[0.625rem] leading-none font-semibold tracking-wide text-primary dark:text-indigo-300',
        className,
      )}
      title="Agent member"
      data-agent-badge=""
    >
      AI
    </span>
  );
}
