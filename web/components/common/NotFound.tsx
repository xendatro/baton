import { CompassIcon } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@web/components/ui/button';
import { useDocumentTitle } from '@web/lib/title';

export interface NotFoundProps {
  /** What was not found, e.g. "Task". */
  what?: string;
  description?: string;
}

/**
 * "Not found" for unknown URLs and for items that don't exist or aren't visible to the viewer
 * (the API answers 404 for teams the viewer isn't a member of).
 */
export function NotFound({ what = 'Page', description }: NotFoundProps) {
  useDocumentTitle([`${what} not found`]);
  return (
    <div className="flex min-h-[60vh] flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <CompassIcon className="size-6" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold tracking-tight">{what} not found</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {description ?? 'It may have been moved or deleted, or you may not have access to it.'}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  );
}
