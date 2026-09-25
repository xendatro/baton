import type { ReactNode } from 'react';
import { cn } from '@web/lib/utils';

export interface PageContainerProps {
  children: ReactNode;
  /** `narrow` for forms and settings, `wide` (default) for lists, `full` for boards. */
  width?: 'narrow' | 'wide' | 'full';
  className?: string;
}

const WIDTHS = { narrow: 'max-w-3xl', wide: 'max-w-6xl', full: 'max-w-none' } as const;

/** Standard page padding and width inside the app shell. */
export function PageContainer({ children, width = 'wide', className }: PageContainerProps) {
  return (
    <div className={cn('mx-auto w-full px-4 py-6 sm:px-6', WIDTHS[width], className)}>
      {children}
    </div>
  );
}
