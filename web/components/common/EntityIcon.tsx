import { cn } from '@web/lib/utils';

/** Emoji icon, or the first letter on the entity color. */
export function EntityIcon({
  icon,
  name,
  color,
  className,
}: {
  icon: string | null;
  name: string;
  color: string;
  className?: string;
}) {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 shrink-0 items-center justify-center text-sm leading-none',
          className,
        )}
      >
        {icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded text-[0.6rem] font-semibold text-white',
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {Array.from(name)[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
