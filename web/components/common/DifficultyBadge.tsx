import { GaugeIcon } from 'lucide-react';
import type { TaskDifficultySummary } from '@shared/schemas/tasks';
import { cn } from '@web/lib/utils';

/**
 * A task's difficulty level (BAT-24): a gauge in the level's color plus its name, so the color is
 * never the only signal. Without a level it reads "No difficulty" (muted).
 */
export function DifficultyBadge({
  difficulty,
  showEmpty = true,
  className,
}: {
  difficulty: Pick<TaskDifficultySummary, 'name' | 'color'> | null | undefined;
  /** Render "No difficulty" when there is none (pickers); cards pass false. */
  showEmpty?: boolean;
  className?: string;
}) {
  if (!difficulty) {
    return showEmpty ? (
      <span className={cn('inline-flex items-center gap-1.5 text-muted-foreground', className)}>
        <GaugeIcon className="size-3.5" aria-hidden="true" />
        No difficulty
      </span>
    ) : null;
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <GaugeIcon
        className="size-3.5 shrink-0"
        style={{ color: difficulty.color }}
        aria-hidden="true"
      />
      <span className="truncate">{difficulty.name}</span>
    </span>
  );
}
