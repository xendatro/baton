import { LogInIcon, TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { acceptsNewTasks } from '@web/lib/newTaskStages';
import { cn } from '@web/lib/utils';

type StageLike = Parameters<typeof acceptsNewTasks>[0];

/** BAT-34: a small mark after the name of a status new tasks can start in (settings). */
export function StartMark({ status, className }: { status: StageLike; className?: string }) {
  if (!acceptsNewTasks(status)) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label="New tasks can start here"
          className={cn(
            'inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <LogInIcon className="size-2.5" strokeWidth={3} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent>New tasks can start here</TooltipContent>
    </Tooltip>
  );
}

/** The warning shown when a pipeline has no stage that accepts new tasks. */
export function NoStartStageNotice({
  pipelineName,
  action,
  className,
}: {
  /** Shown when the project has several pipelines. */
  pipelineName?: string | undefined;
  /** E.g. a link to the stage settings. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="note"
      data-testid="no-start-stage"
      className={cn(
        'flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200',
        className,
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        No status{pipelineName ? ` of ${pipelineName}` : ''} accepts new tasks, so none can be
        created. Turn on <strong>New tasks can start here</strong> on one in its settings.
      </p>
      {action}
    </div>
  );
}
