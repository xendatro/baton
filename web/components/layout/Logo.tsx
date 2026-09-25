import { cn } from '@web/lib/utils';

/** The Baton mark (same drawing as favicon.svg). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6 shrink-0', className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#4f46e5" />
      <path d="M9 23 23 9" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <circle cx="23" cy="9" r="3" fill="#c7d2fe" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">Baton</span>
    </span>
  );
}
