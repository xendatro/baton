import { CheckCircle2Icon, CircleIcon } from 'lucide-react';
import type { StatusCategory } from '@shared/constants';
import { cn } from '@web/lib/utils';

export interface StatusLike {
  name: string;
  color: string;
  category: StatusCategory;
}

/** Status icon in the status color: an open circle, or a check for done statuses. */
export function StatusIcon({ status, className }: { status: StatusLike; className?: string }) {
  const Icon = status.category === 'done' ? CheckCircle2Icon : CircleIcon;
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', className)}
      style={{ color: status.color }}
      strokeWidth={2.5}
    />
  );
}

export interface StatusBadgeProps {
  status: StatusLike;
  /** Icon only (the name stays available to screen readers and as a tooltip). */
  iconOnly?: boolean;
  className?: string;
}

export function StatusBadge({ status, iconOnly = false, className }: StatusBadgeProps) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-sm', className)}
      title={iconOnly ? status.name : undefined}
    >
      <StatusIcon status={status} />
      <span className={iconOnly ? 'sr-only' : 'truncate'}>{status.name}</span>
    </span>
  );
}
