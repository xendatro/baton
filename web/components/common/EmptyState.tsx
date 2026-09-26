import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Call to action (usually a Button). */
  action?: ReactNode;
  /**
   * Heading level of the title: 2 under a page's h1 (default), 3 inside a section with its own
   * h2, so heading levels never skip.
   */
  headingLevel?: 2 | 3;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <div className="max-w-sm space-y-1">
        <Heading className="text-sm font-semibold">{title}</Heading>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
