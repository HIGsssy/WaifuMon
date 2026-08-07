/**
 * `DevSessionProvider` — v1's entire authentication surface (plan §6), and the
 * single seam `providers.tsx` aliases as `SessionProvider`.
 *
 * It is a compile-time switch between two implementations, and nothing more:
 *
 *   dev builds   `DevLoginSessionProvider` — a Discord id typed into the
 *                developer-login screen, bridged to an internal player id
 *                through `GET /players/lookup` and remembered in localStorage
 *   otherwise    `EnvSessionProvider` — `VITE_DEFAULT_PLAYER_ID`, resolved once
 *                at startup, exactly as it has always worked
 *
 * `import.meta.env.DEV` is substituted by Vite before bundling, so a production
 * build folds this to the env provider and the developer-login subtree — form,
 * storage, `useDevAuth`, "Switch player" — is dropped from the output rather
 * than merely hidden. `scripts/verify-bundle.mjs` asserts that mechanically.
 *
 * Both implementations publish the same `PortalSession`. No page component asks
 * how the session was established, which is what keeps the v2 OAuth migration
 * (§25.14) a one-line import change.
 */
import type { ReactNode } from 'react';

import { DevLoginSessionProvider } from './dev/DevLoginSessionProvider';
import { EnvSessionProvider } from './EnvSessionProvider';

export function DevSessionProvider({ children }: { children: ReactNode }) {
  return import.meta.env.DEV ? (
    <DevLoginSessionProvider>{children}</DevLoginSessionProvider>
  ) : (
    <EnvSessionProvider>{children}</EnvSessionProvider>
  );
}
