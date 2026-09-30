import type { AgentWorking } from '@shared/schemas/core';
import { cn } from '@web/lib/utils';
import { workingLabel } from './workingLabel';

/**
 * BAT#42: a small indigo dot that breathes (a slow ~2 s ease-in-out opacity pulse, static with
 * reduced motion) while an agent works on a task or issue: a harness is running its job, not
 * merely queued. On board cards, list and issue rows and next to the item's title. Its label and
 * tooltip name the agents ("Ethan AI is working"), so color isn't the only signal. Renders
 * nothing when no agent works on it.
 */
export function WorkingDot({
  working,
  className,
}: {
  working?: AgentWorking | null;
  className?: string;
}) {
  if (!working || working.agentIds.length === 0) return null;
  const label = workingLabel(working.names);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="working-dot"
      className={cn('inline-flex size-4 shrink-0 items-center justify-center', className)}
    >
      <span className="size-2 animate-working-pulse rounded-full bg-indigo-500 motion-reduce:animate-none dark:bg-indigo-400" />
    </span>
  );
}
