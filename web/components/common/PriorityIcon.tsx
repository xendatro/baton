import { PRIORITIES, type PriorityValue } from '@shared/constants';
import { cn } from '@web/lib/utils';

function priorityLabel(value: PriorityValue): string {
  return PRIORITIES[value]?.label ?? 'No priority';
}

export interface PriorityIconProps {
  value: PriorityValue;
  /** Show the label next to the icon (it is always available to screen readers). */
  showLabel?: boolean;
  className?: string;
}

/** Linear-style priority: dashes (none), 1–3 filled bars (low–high), or an urgent badge. */
export function PriorityIcon({ value, showLabel = false, className }: PriorityIconProps) {
  const label = priorityLabel(value);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm', className)}
      title={showLabel ? undefined : label}
    >
      <PriorityGlyph value={value} />
      <span className={showLabel ? 'truncate' : 'sr-only'}>{label}</span>
    </span>
  );
}

const BARS = [
  { x: 1.5, y: 9, height: 5 },
  { x: 6.5, y: 5.5, height: 8.5 },
  { x: 11.5, y: 2, height: 12 },
];

function PriorityGlyph({ value }: { value: PriorityValue }) {
  if (value === 4) {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="3.5" fill={PRIORITIES[4]?.color} />
        <rect x="7" y="3.5" width="2" height="6" rx="1" fill="white" />
        <rect x="7" y="10.75" width="2" height="2" rx="1" fill="white" />
      </svg>
    );
  }
  if (value === 0) {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true">
        {[1.5, 6.5, 11.5].map((x) => (
          <rect key={x} x={x} y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-foreground/80" aria-hidden="true">
      {BARS.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          fill="currentColor"
          opacity={index < value ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}
