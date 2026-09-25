import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '@web/components/layout/Logo';
import { useDocumentTitle } from '@web/lib/title';
import { cn } from '@web/lib/utils';

export interface AuthLayoutProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Links under the card ("Don't have an account? Sign up"). */
  footer?: ReactNode;
  className?: string;
}

/** Centered card for the sign-in pages (no app shell). */
export function AuthLayout({ title, description, children, footer, className }: AuthLayoutProps) {
  useDocumentTitle([title]);
  return (
    <div className="flex min-h-svh flex-col items-center bg-muted/40 px-4 py-10 sm:justify-center sm:py-16 dark:bg-background">
      <main className={cn('flex w-full max-w-sm flex-col gap-6', className)}>
        <Link
          to="/"
          className="self-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Baton"
        >
          <Logo className="[&_svg]:size-8 [&>span]:text-xl" />
        </Link>
        <div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
          <div className="mb-6 space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-sm text-balance text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {children}
        </div>
        {footer ? <div className="text-center text-sm text-muted-foreground">{footer}</div> : null}
      </main>
    </div>
  );
}
