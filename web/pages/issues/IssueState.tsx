import { CheckCircle2Icon, CircleDotIcon } from 'lucide-react';
import { cn } from '@web/lib/utils';

/**
 * Open / resolved markers, in the same colors as the project overview's counts: open issues in
 * the accent color, resolved ones in green. Text or an accessible label always goes with them.
 */

export function IssueStateIcon({
  resolved,
  decorative = false,
  className,
}: {
  resolved: boolean;
  /** Hidden from screen readers when the text next to it already says the state. */
  decorative?: boolean;
  className?: string;
}) {
  const Icon = resolved ? CheckCircle2Icon : CircleDotIcon;
  return (
    <Icon
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': resolved ? 'Resolved' : 'Open' })}
      className={cn(
        'size-4 shrink-0',
        resolved ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary',
        className,
      )}
    />
  );
}

export function IssueStateBadge({
  resolved,
  className,
}: {
  resolved: boolean;
  className?: string;
}) {
  const Icon = resolved ? CheckCircle2Icon : CircleDotIcon;
  return (
    <span
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium',
        resolved
          ? 'bg-emerald-600 text-white dark:bg-emerald-500/20 dark:text-emerald-300'
          : 'bg-primary text-primary-foreground dark:bg-primary/25 dark:text-indigo-200',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
      {resolved ? 'Resolved' : 'Open'}
    </span>
  );
}
