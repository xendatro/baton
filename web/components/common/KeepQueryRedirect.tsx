import { Navigate, useLocation } from 'react-router';

/** Redirects to a path relative to the current one, keeping the query and hash (old URLs). */
export function KeepQueryRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: to, search, hash }} relative="path" replace />;
}
