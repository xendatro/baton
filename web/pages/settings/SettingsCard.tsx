import type { ReactNode } from 'react';
import { Skeleton } from '@web/components/ui/skeleton';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';

export interface SettingsPageProps {
  title: string;
  description?: ReactNode;
  /** Buttons at the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** One settings page: its title (also the document title) and its sections. */
export function SettingsPage({ title, description, actions, children }: SettingsPageProps) {
  useDocumentTitle([title, 'Settings']);
  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

export interface SettingsCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right side of the header (e.g. a button). */
  action?: ReactNode;
  /** Bottom bar: usually a hint on the left and the save button on the right. */
  footer?: ReactNode;
  /** `danger` outlines the card in red (irreversible actions). */
  tone?: 'default' | 'danger';
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
}

/** A bordered section of a settings page (GitHub-style), with an optional footer bar. */
export function SettingsCard({
  title,
  description,
  action,
  footer,
  tone = 'default',
  className,
  contentClassName,
  children,
}: SettingsCardProps) {
  return (
    <section
      className={cn(
        'rounded-lg border bg-card text-card-foreground',
        tone === 'danger' && 'border-destructive/40',
        className,
      )}
    >
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-5 sm:pt-5">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className={cn('text-sm font-semibold', tone === 'danger' && 'text-destructive')}>
            {title}
          </h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
      </div>
      {children !== undefined ? (
        <div className={cn('px-4 pt-4 pb-4 sm:px-5 sm:pb-5', contentClassName)}>{children}</div>
      ) : (
        <div className="pb-4 sm:pb-5" />
      )}
      {footer ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t bg-muted/40 px-4 py-3 sm:px-5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** Loading placeholder shaped like a settings card with `rows` lines. */
export function SettingsCardSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="rounded-lg border p-4 sm:p-5" aria-hidden="true">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-2 h-3 w-64 max-w-full" />
      <div className="mt-5 grid gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
