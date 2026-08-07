/**
 * The developer-login control surface — dev builds only.
 *
 * Deliberately *separate* from `SessionContext`. Every page reads the acting
 * player through `PortalSession`, and that contract does not change between the
 * dev provider and a future `OAuthSessionProvider` (plan §6). Sign-in and
 * sign-out are not part of it: only the developer-login screen and the two
 * dev-only "Switch player" affordances ever call them, and all three live
 * behind `import.meta.env.DEV`.
 */
import { createContext } from 'react';

import type { DevIdentity } from './devIdentity';

export interface DevAuthState {
  /** The identity the current session is resolving from, or null when signed out. */
  identity: DevIdentity | null;
  /**
   * The last identity entered this browser, retained across a sign-out purely
   * so the login form can pre-fill it. Never used to resolve a session.
   */
  lastIdentity: DevIdentity | null;
  /** Resolve this pair and, on success, persist it as the developer session. */
  signIn: (identity: DevIdentity) => void;
  /** Drop the stored session and return to the login screen. */
  signOut: () => void;
}

export const DevAuthContext = createContext<DevAuthState | null>(null);
