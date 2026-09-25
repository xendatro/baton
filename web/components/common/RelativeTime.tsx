import { formatDateTime, formatRelative } from '@web/lib/format';
import { cn } from '@web/lib/utils';
import { useNow } from './useNow';

export interface RelativeTimeProps {
  /** ISO 8601 timestamp or Date. */
  value: string | Date;
  className?: string;
}

/** "4m ago", kept current, with the full date and time on hover. */
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const current = useNow();
  const iso = typeof value === 'string' ? value : value.toISOString();
  return (
    <time
      dateTime={iso}
      title={formatDateTime(value)}
      className={cn('whitespace-nowrap text-muted-foreground', className)}
    >
      {formatRelative(value, new Date(current))}
    </time>
  );
}
