import { TriangleAlertIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Switch } from '@web/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { acceptsNewTasks } from '@web/lib/newTaskStages';
import { cn } from '@web/lib/utils';

type StageLike = Parameters<typeof acceptsNewTasks>[0];

/**
 * BAT-34 / BAT#20: a stage row's "Start here" switch in settings: can new tasks be created in
 * this stage? Several stages of a pipeline may be on. Disabled (read-only) for people who can't
 * manage the pipeline's stages; it still shows the setting.
 */
export function StartHereSwitch({
  status,
  name,
  disabled = false,
  onCheckedChange,
  className,
}: {
  status: StageLike;
  /** The stage's name, for the accessible label. */
  name: string;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A span, so the tooltip also shows while the switch is disabled. */}
        <span className={cn('inline-flex items-center gap-2', className)}>
          <Switch
            id={id}
            size="sm"
            checked={acceptsNewTasks(status)}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-label={`New tasks can start in ${name}`}
          />
          <label
            htmlFor={id}
            className={cn(
              'text-sm text-muted-foreground sm:sr-only',
              disabled ? 'cursor-default' : 'cursor-pointer',
            )}
          >
            Start here
          </label>
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
        No stage{pipelineName ? ` of ${pipelineName}` : ''} accepts new tasks, so none can be
        created. Turn on <strong>Start here</strong> (New tasks can start here) on one of its
        stages.
      </p>
      {action}
    </div>
  );
}
