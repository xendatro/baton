import { ShieldAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@web/components/common/EmptyState';
import { cn } from '@web/lib/utils';

/** Title row of a team settings page: heading, description and actions. */
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
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 pb-5">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A bordered group of settings rows. */
export function SettingsCard({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        tone === 'danger' && 'border-destructive/40',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One row of a settings card: text on the left, a control on the right (stacked on phones). */
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b p-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Shown on a settings page the viewer lacks the permission for (e.g. opened from a link). */
export function NoAccess({ what, permission }: { what: string; permission: string }) {
  return (
    <EmptyState
      icon={ShieldAlertIcon}
      title={`You can’t view ${what}`}
      description={`This needs the ${permission} permission. Ask a team admin if you need access.`}
    />
  );
}
