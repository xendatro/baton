import { CalendarIcon } from 'lucide-react';
import { daysUntil, formatDueDate, parseDueDate } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { useNow } from './useNow';

export interface DueDateProps {
  /** `YYYY-MM-DD`. */
  value: string;
  /** Finished items (in a done status) are never shown as overdue. */
  done?: boolean;
  className?: string;
}

/** Due date with a calendar icon; red (and labelled "overdue") when past due and not done. */
export function DueDate({ value, done = false, className }: DueDateProps) {
  const now = new Date(useNow());
  const days = daysUntil(value, now);
  const overdue = !done && days < 0;
  const dueToday = !done && days === 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs whitespace-nowrap',
        overdue
          ? 'font-medium text-red-600 dark:text-red-400'
          : dueToday
            ? 'font-medium text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground',
        className,
      )}
      title={`Due ${parseDueDate(value).toDateString()}`}
    >
      <CalendarIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{formatDueDate(value, now)}</span>
      {overdue ? <span className="sr-only">(overdue)</span> : null}
    </span>
  );
}
