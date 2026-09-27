import { CheckIcon } from 'lucide-react';
import type { StageRules } from '@shared/schemas/pipelines';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { cn } from '@web/lib/utils';

/** Does a status count its tasks as finished (its rules' `blocksDependents` is off)? */
function isFinishedStatus(status: { rules?: StageRules | undefined }): boolean {
  return status.rules?.blocksDependents === false;
}

/**
 * A small ✓ after the name of a status whose tasks count as finished (completed, no longer
 * blocking or overdue), so the board and settings show which statuses those are.
 */
export function FinishedMark({
  status,
  className,
}: {
  status: { rules?: StageRules | undefined };
  className?: string;
}) {
  if (!isFinishedStatus(status)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label="Counts as finished"
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-400',
            className,
          )}
        >
          <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>Counts as finished: its tasks are complete</TooltipContent>
    </Tooltip>
  );
}
