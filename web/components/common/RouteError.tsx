import { AlertTriangleIcon, HomeIcon, RotateCwIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useRouteError } from 'react-router';
import { Button } from '@web/components/ui/button';
import { errorMessage } from '@web/lib/api';
import { isChunkLoadError, reloadOnceForNewVersion } from '@web/lib/chunkReload';
import { cn } from '@web/lib/utils';

/**
 * Route error elements (SPEC §6: every page has an error state). React Router sends a failed
 * lazy page import and any error thrown while rendering a route here instead of the component
 * tree. The most common cause is a deploy: an open tab asks for a page chunk that no longer exists,
 * so a chunk-load failure reloads the page once (see web/lib/chunkReload.ts).
 */

export interface RouteErrorProps {
  /** `page`: inside the app shell (sidebar stays); `screen`: the whole window. */
  variant: 'page' | 'screen';
}

export function RouteError({ variant }: RouteErrorProps) {
  const error = useRouteError();
  const chunkError = isChunkLoadError(error);

  useEffect(() => {
    if (chunkError) reloadOnceForNewVersion();
    // Surfaced in the browser console for bug reports; there is no client-side log sink.
    // eslint-disable-next-line no-console
    else console.error('Route error', error);
  }, [chunkError, error]);

  const title = chunkError ? 'Baton was updated' : 'Something went wrong';
  const description = chunkError
    ? 'This page needs the latest version of the app. Reload to continue.'
    : errorMessage(error);

  return (
    <div
      className={cn(
        'flex flex-1 items-center justify-center p-4 sm:p-6',
        variant === 'screen' && 'min-h-svh bg-background',
      )}
    >
      <div
        role="alert"
        className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
      >
        <AlertTriangleIcon className="size-6 text-destructive" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-sm font-semibold">{title}</h1>
          <p className="text-sm break-words text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            <RotateCwIcon aria-hidden="true" />
            Reload
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to="/" reloadDocument={variant === 'screen'}>
              <HomeIcon aria-hidden="true" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
