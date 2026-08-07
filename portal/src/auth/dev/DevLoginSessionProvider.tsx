/**
 * `DevLoginSessionProvider` — the developer session, dev builds only.
 *
 * Resolution is two hops, both of them endpoints that already existed:
 *
 *   1. `GET /players/lookup?discordGuildId&discordUserId` → internal player id
 *   2. `GET /players/{id}`                                → the `PortalSession`
 *
 * Hop 1 is the identity bridge the plan always intended a real auth provider to
 * use (§6); this provider just feeds it a pair typed into a form instead of one
 * arriving from an OAuth callback. It never provisions: a pair that has not
 * played answers 404, and the login screen says so rather than creating anyone.
 *
 * What it produces is the *unchanged* `PortalSession`. No page component learns
 * that a login screen exists, and swapping this for `OAuthSessionProvider`
 * remains a one-line change in `providers.tsx` (§25.14).
 *
 * The identity is persisted only once it resolves, so a failed attempt does not
 * become the state the next page load starts in.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { IDENTITY_POLICY } from '@/api/cachePolicy';
import { isPortalApiError } from '@/api/client';
import { getPlayer, getPlayerLookup } from '@/api/players';
import { queryKeys } from '@/api/queryKeys';
import type { Player } from '@/api/types';
import { SessionContext } from '../SessionContext';
import type { PortalSession, SessionState } from '../types';
import { DevAuthContext, type DevAuthState } from './DevAuthContext';
import {
  clearDevIdentity,
  readDevIdentity,
  writeDevIdentity,
  type DevIdentity,
} from './devIdentity';

/**
 * The one failure the login screen treats as an answer rather than a fault: the
 * pair is well-formed, the API is healthy, and nobody with that Discord account
 * has played on that guild. Distinguished from every other 404 so the screen
 * can explain it in the game's terms instead of showing an HTTP code.
 */
export class DevPlayerNotFoundError extends Error {
  readonly identity: DevIdentity;

  constructor(identity: DevIdentity) {
    super(
      `No Waifumon player for Discord user ${identity.discordUserId} on guild ` +
        `${identity.discordGuildId}.`,
    );
    this.name = 'DevPlayerNotFoundError';
    this.identity = identity;
  }
}

/** Same rule as every other provider: the API's name when it has one (§6). */
function displayNameFor(player: Player): string {
  return player.identity?.displayName ?? `Trainer #${player.id}`;
}

/**
 * The one cache key not built in `api/queryKeys.ts`.
 *
 * It lives here because it must vanish with the rest of this subtree: a
 * property on the shared `queryKeys` object would survive into the production
 * bundle as a dead string, which is exactly what `verify-bundle` exists to
 * prevent. It is also not player-scoped — it is the query that *discovers* the
 * player id, so it has none to carry.
 */
function lookupKey(identity: DevIdentity | null) {
  return ['devLogin', 'lookup', identity?.discordGuildId ?? '', identity?.discordUserId ?? ''];
}

export function DevLoginSessionProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<DevIdentity | null>(readDevIdentity);
  // Survives a sign-out. Pre-filling the form with the pair you just left is
  // the difference between "switch player" costing a click and costing a trip
  // back to Discord for a snowflake.
  const [lastIdentity, setLastIdentity] = useState<DevIdentity | null>(readDevIdentity);

  const lookup = useQuery({
    queryKey: lookupKey(identity),
    queryFn: ({ signal }) => getPlayerLookup(identity as DevIdentity, signal),
    enabled: identity !== null,
    // A Discord id maps to the same internal player for the life of the
    // session; re-resolving it is pure overhead.
    ...IDENTITY_POLICY,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const playerId = lookup.data?.playerId ?? null;

  const record = useQuery({
    queryKey: queryKeys.playerRecord(playerId ?? 0),
    queryFn: ({ signal }) => getPlayer(playerId as number, signal),
    enabled: playerId !== null,
    ...IDENTITY_POLICY,
  });

  const player = record.data;

  // Persist only what resolved. A mistyped snowflake stays on the login screen
  // instead of being the thing the Portal tries again on every reload.
  useEffect(() => {
    if (player && identity) writeDevIdentity(identity);
  }, [player, identity]);

  const signIn = useCallback((next: DevIdentity) => {
    setIdentity(next);
    setLastIdentity(next);
  }, []);

  const signOut = useCallback(() => {
    clearDevIdentity();
    setIdentity(null);
  }, []);

  const devAuth = useMemo<DevAuthState>(
    () => ({ identity, lastIdentity, signIn, signOut }),
    [identity, lastIdentity, signIn, signOut],
  );

  const value = useMemo<SessionState>(() => {
    const session: PortalSession | null = player
      ? {
          playerId: player.id,
          guildDbId: player.guildId,
          displayName: displayNameFor(player),
          avatarUrl: player.identity?.avatarUrl ?? null,
          discordUserId: player.discordUserId,
          // The player resource carries the internal guild id, not the
          // snowflake — the signed-in identity is the only source for one.
          discordGuildId: identity?.discordGuildId,
        }
      : null;

    // A 404 from the lookup is "this account has not played here", which the
    // login screen renders as prose. Anything else stays a raw API error.
    let error: unknown = null;
    if (lookup.isError && identity) {
      error =
        isPortalApiError(lookup.error) && lookup.error.isNotFound
          ? new DevPlayerNotFoundError(identity)
          : lookup.error;
    } else if (record.isError) {
      error = record.error;
    }

    let status: SessionState['status'];
    if (session) {
      status = 'ready';
    } else if (identity === null || error !== null) {
      status = 'unresolved'; // signed out, or a settled failure to explain
    } else {
      status = 'loading';
    }

    return {
      status,
      session,
      error,
      // Dev builds no longer read `VITE_DEFAULT_PLAYER_ID` at all — the acting
      // player comes from the login screen. The field stays on the contract for
      // the production provider, which does.
      configuredPlayerId: undefined,
      retry: () => void (lookup.isError ? lookup.refetch() : record.refetch()),
    };
  }, [player, identity, lookup, record]);

  return (
    <DevAuthContext.Provider value={devAuth}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </DevAuthContext.Provider>
  );
}
