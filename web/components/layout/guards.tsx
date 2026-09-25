import type { ReactNode } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router';
import { ErrorState } from '@web/components/common/ErrorState';
import { LoadingScreen } from '@web/components/common/Spinner';
import { isAuthRoutingError, loginPath } from '@web/lib/api';
import { safeNext, useMe, useSession } from '@web/lib/auth';

/**
 * Route guards. `RequireAuth` needs a session, `RequireOnboarded` a verified email and a
 * username (OAuth users pick one first), and `RedirectIfAuthed` sends signed-in users away from
 * the sign-in pages to `?next` (or the dashboard).
 */

function currentPath(location: ReturnType<typeof useLocation>): string {
  return `${location.pathname}${location.search}${location.hash}`;
}

function GuardError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <ErrorState
        title="Couldn’t reach Baton"
        error={error}
        onRetry={retry}
        className="w-full max-w-md"
      />
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  const session = useSession();
  if (session.isPending) return <LoadingScreen />;
  if (session.isError) {
    return <GuardError error={session.error} retry={() => void session.refetch()} />;
  }
  if (!session.data) return <Navigate to={loginPath(currentPath(location))} replace />;
  return children;
}

export function RequireOnboarded({ children }: { children: ReactNode }) {
  const location = useLocation();
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) {
    // 401 and onboarding errors are already being routed by the API client.
    if (isAuthRoutingError(me.error)) return <LoadingScreen />;
    return <GuardError error={me.error} retry={() => void me.refetch()} />;
  }
  const next = encodeURIComponent(currentPath(location));
  const { user } = me.data;
  if (!user.emailVerified) {
    return (
      <Navigate to={`/verify-email?email=${encodeURIComponent(user.email)}&next=${next}`} replace />
    );
  }
  if (!user.username) return <Navigate to={`/onboarding/username?next=${next}`} replace />;
  return children;
}

export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const session = useSession();
  if (session.isPending) return <LoadingScreen />;
  // If the session can't be checked, show the page: signing in will surface the real error.
  if (session.data) return <Navigate to={safeNext(params.get('next'))} replace />;
  return children;
}
