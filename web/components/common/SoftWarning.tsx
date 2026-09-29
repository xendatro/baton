import { TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/utils';

/**
 * The amber "this is odd, but allowed" notice: something the person did (or left) makes little
 * sense — a pipeline with no stages, no stage accepting new tasks, approvals nobody can give — but
 * Baton lets them do it. Says what is off and, through `action`, how to fix it. The icon and the
 * text carry the meaning (never the color alone).
 */
export function SoftWarning({
  children,
  title,
  action,
  size = 'default',
  className,
  ...props
}: {
  children?: ReactNode;
  /** A short bold lead ("No stages"). */
  title?: ReactNode;
  /** E.g. a button or link that fixes it. */
  action?: ReactNode;
  /** `sm`: a single line under a field. */
  size?: 'default' | 'sm';
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        'flex flex-wrap items-start gap-x-2.5 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        className,
      )}
      {...props}
    >
      <TriangleAlertIcon
        className={cn('shrink-0', size === 'sm' ? 'mt-px size-3.5' : 'mt-0.5 size-4')}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <span className="sr-only">Warning: </span>
        {title ? <strong className="font-medium">{title} </strong> : null}
        {children}
      </div>
      {action}
    </div>
  );
}
