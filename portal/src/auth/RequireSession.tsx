/**
 * `RequireSession` — the gate every player-scoped route sits behind (plan §7).
 *
 * Three states, and only three:
 *   loading      the shell is already painted by `AppShell`; this adds a quiet
 *                page-level skeleton rather than a spinner (§14)
 *   unresolved   redirect to `/select-player`, which explains what to fix
 *   ready        render the route
 *
 * The redirect carries no state: `/select-player` reads the same session
 * context and describes the same failure, so a deep link to it is honest.
 */
import { Navigate, Outlet, useLocation } from 'react-router';

import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from './useSession';

function SessionSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading your session">
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-40 rounded-2xl" />
      </div>
    </div>
  );
}

export function RequireSession() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') return <SessionSkeleton />;

  if (status === 'unresolved') {
    return <Navigate to="/select-player" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
