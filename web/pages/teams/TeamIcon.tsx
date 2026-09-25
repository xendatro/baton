import { tintStyle } from '@web/lib/colors';
import { cn } from '@web/lib/utils';

const SIZES = {
  sm: 'size-6 rounded-md text-sm',
  md: 'size-9 rounded-lg text-lg',
  lg: 'size-12 rounded-xl text-2xl',
  xl: 'size-16 rounded-2xl text-4xl',
} as const;

const INITIAL_TEXT = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
  xl: 'text-2xl',
} as const;

export interface TeamIconProps {
  icon: string | null;
  name: string;
  color: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/** A team's (or project's) emoji on a tint of its color, or its initial on the solid color. */
export function TeamIcon({ icon, name, color, size = 'md', className }: TeamIconProps) {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center border leading-none',
          SIZES[size],
          className,
        )}
        style={tintStyle(color)}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold text-white',
        SIZES[size],
        INITIAL_TEXT[size],
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
