import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@web/lib/utils';

/** Title row of a project settings section. */
export function SettingsHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Explains why a section is read-only. */
export function ReadOnlyNotice({ permission }: { permission: string }) {
  return (
    <p className="mb-5 flex items-start gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        You can view this, but changing it needs the <strong>{permission}</strong> permission.
      </span>
    </p>
  );
}

/** A bordered group of settings rows. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border bg-card', className)}>{children}</div>;
}
