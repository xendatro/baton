import { AlertTriangleIcon, RotateCwIcon } from 'lucide-react';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { cn } from '@web/lib/utils';

export interface ErrorStateProps {
  title?: string;
  error?: unknown;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  className?: string;
}

/** Inline error for a failed load, with an optional retry. */
export function ErrorState({
  title = 'Couldn’t load this',
  error,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center',
        className,
      )}
    >
      <AlertTriangleIcon className="size-6 text-destructive" aria-hidden="true" />
      <div className="max-w-md space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {error !== undefined ? (
          <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCwIcon aria-hidden="true" />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
