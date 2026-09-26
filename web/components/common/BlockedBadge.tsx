import { BanIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';

export interface BlockedBadgeProps {
  /** Refs of the open tasks it waits for, when known (board and list cards carry them). */
  blockers?: readonly string[];
  className?: string;
}

/**
 * "Blocked": the task waits for another task that is still in an open status. Used by board
 * cards, the task list and the work lists (dashboard, My tasks), so a blocked task looks the same
 * everywhere.
 */
export function BlockedBadge({ blockers, className }: BlockedBadgeProps) {
  const text = blockers?.length
    ? `Blocked by ${blockers.join(', ')}`
    : 'Blocked: waiting on a task that is still open';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400',
            className,
          )}
        >
          <BanIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{text}</span>
          <span aria-hidden="true">Blocked</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
