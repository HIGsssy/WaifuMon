/**
 * Renders `children` iff the current session holds `permission`. Otherwise
 * renders the fallback (a 404-style page by default).
 *
 * The guard is deliberately a UX affordance, not a security boundary: the
 * corresponding API routes independently re-check every request in
 * `requirePortalPermission` on the server. A privileged user typing an
 * admin URL by hand still hits authenticated screens; an unprivileged user
 * doing the same hits the fallback and can never trigger a mutation.
 */
import type { ReactNode } from 'react';
import { NotFoundPage } from '@/features/notFound/NotFoundPage';
import { useHasPermission } from './useSession';

export interface RequirePortalPermissionProps {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequirePortalPermission({
  permission,
  children,
  fallback,
}: RequirePortalPermissionProps): JSX.Element {
  const has = useHasPermission(permission);
  if (!has) return <>{fallback ?? <NotFoundPage />}</>;
  return <>{children}</>;
}
