import type { ReactNode } from 'react';
import { tintStyle } from '@web/lib/colors';
import { cn } from '@web/lib/utils';

export interface ChipProps {
  color: string | null | undefined;
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Chip({ color, children, title, className }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-48 min-w-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium text-foreground',
        className,
      )}
      style={tintStyle(color)}
      title={title}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? 'var(--muted-foreground)' }}
      />
      <span className="truncate">{children}</span>
    </span>
  );
}
