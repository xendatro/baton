import { DEFAULT_STATUS_ICON, type StatusIconShape } from '@shared/constants';
import { cn } from '@web/lib/utils';
import { STATUS_ICON_SHAPES } from './statusIcons';

export interface StatusLike {
  name: string;
  color: string;
  /** Icon shape; a circle when missing (older data). */
  icon?: StatusIconShape;
}

/** A status's icon: its chosen shape in its color. */
export function StatusIcon({ status, className }: { status: StatusLike; className?: string }) {
  const Icon = STATUS_ICON_SHAPES[status.icon ?? DEFAULT_STATUS_ICON].icon;
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', className)}
      style={{ color: status.color }}
      strokeWidth={2.5}
      data-icon={status.icon ?? DEFAULT_STATUS_ICON}
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
