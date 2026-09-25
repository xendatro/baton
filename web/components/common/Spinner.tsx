import { Loader2Icon } from 'lucide-react';
import { cn } from '@web/lib/utils';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <>
      <Loader2Icon className={cn('size-4 animate-spin', className)} aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

/** Centered spinner filling its container (route and guard loading states). */
export function LoadingScreen({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[50vh] flex-1 items-center justify-center text-muted-foreground"
    >
      <Spinner className="size-5" label={label} />
    </div>
  );
}
