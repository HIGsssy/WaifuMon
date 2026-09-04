/**
 * The hook every page uses to learn who it is rendering for (plan §6).
 *
 * Two entry points on purpose:
 *
 *   `useSession()`       full state, including `loading` and `unresolved`.
 *                        Only the route guard and the diagnostics page need it.
 *   `useCurrentSession()` the resolved session, non-null. Every page under
 *                        `<RequireSession>` uses this and never writes a null
 *                        check — the guard has already run.
 */
import { useContext } from 'react';

import { SessionContext } from './SessionContext';
import type { PortalSession, SessionState } from './types';

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (!state) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }
  return state;
}

/**
 * The resolved session. Throws if called outside `<RequireSession>` — that is a
 * routing bug, not a runtime state a page should branch on.
 */
export function useCurrentSession(): PortalSession {
  const { session } = useSession();
  if (!session) {
    throw new Error(
      'useCurrentSession requires a resolved session — render this page inside <RequireSession>.',
    );
  }
  return session;
}

/**
 * True iff the current session holds `permission`. Never a security boundary
 * — API routes independently re-check every mutation. Use to hide admin UI
 * elements from unprivileged sessions.
 */
export function useHasPermission(permission: string): boolean {
  const { session } = useSession();
  if (!session) return false;
  return session.permissions.includes(permission);
}
