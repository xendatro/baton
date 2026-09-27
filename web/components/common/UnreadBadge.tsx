import { pluralize } from '@web/lib/format';
import { cn } from '@web/lib/utils';

/**
 * BAT-16: a small red count of the viewer's unread notifications about a task or issue (mentions,
 * replies, assignment), on board cards, list rows and issue rows. Renders nothing at 0. The number
 * is shown, so color isn't the only signal, and the label reads "2 unread notifications".
 */
export function UnreadBadge({ count, className }: { count?: number; className?: string }) {
  if (!count) return null;
  const label = pluralize(count, 'unread notification', 'unread notifications');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] leading-none font-semibold text-white tabular-nums dark:bg-red-500',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
