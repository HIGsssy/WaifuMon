/**
 * `DevSessionProvider` — v1's entire authentication surface (plan §6).
 *
 * Radically simple, on purpose:
 *   1. read `VITE_DEFAULT_PLAYER_ID` from the Vite env
 *   2. resolve it via `GET /api/v1/players/{id}`
 *   3. missing or unresolved → `status: 'unresolved'`, which the route guard
 *      turns into the `/select-player` fallback screen (§8.11)
 *
 * There is **no login form, no localStorage, no cookie, no runtime switcher**.
 * Changing the acting player is a `.env.local` edit plus a reload; the runtime
 * switcher is filed as §25.2.
 *
 * Replacing this with `OAuthSessionProvider` in v2 touches this file and
 * `providers.tsx` only — no page component reads anything but `PortalSession`.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';

import { PLAYER_POLICY } from '@/api/cachePolicy';
import { getPlayer } from '@/api/players';
import { queryKeys } from '@/api/queryKeys';
import { portalEnv } from '@/lib/env';
import { SessionContext } from './SessionContext';
import type { PortalSession, SessionState } from './types';

/**
 * The env value only counts if it names a positive integer — the API's own
 * rule for internal ids. A typo becomes the fallback screen, not a 400 loop.
 */
function parsePlayerId(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

class InvalidPlayerIdError extends Error {
  constructor(raw: string | undefined) {
    super(
      raw === undefined
        ? 'VITE_DEFAULT_PLAYER_ID is not set.'
        : `VITE_DEFAULT_PLAYER_ID is "${raw}", which is not a positive integer player id.`,
    );
    this.name = 'InvalidPlayerIdError';
  }
}

/**
 * The Platform API models a player by internal id and Discord snowflake; it
 * carries no display name or avatar (the bot renders those from Discord at
 * send time). "Trainer #<id>" is an honest stand-in rather than a fabricated
 * name — a player display-name field is filed as API feedback in docs/portal.md.
 */
function displayNameFor(playerId: number): string {
  return `Trainer #${playerId}`;
}

export function DevSessionProvider({ children }: { children: ReactNode }) {
  const configuredPlayerId = portalEnv.defaultPlayerId;
  const playerId = parsePlayerId(configuredPlayerId);

  const query = useQuery({
    queryKey: queryKeys.playerRecord(playerId ?? 0),
    queryFn: ({ signal }) => getPlayer(playerId as number, signal),
    // A missing or malformed env value is a config problem, not a request to
    // make — the query never fires and the guard shows the fallback screen.
    enabled: playerId !== null,
    // Retry behaviour is the client default (`queryClient.ts`), which does not
    // re-attempt a 4xx: an unknown player id is a settled answer, and retrying
    // it only delays the fallback screen a developer is waiting to read.
    ...PLAYER_POLICY,
  });

  const value = useMemo<SessionState>(() => {
    const player = query.data;

    const session: PortalSession | null = player
      ? {
          playerId: player.id,
          guildDbId: player.guildId,
          displayName: displayNameFor(player.id),
          discordUserId: player.discordUserId,
          // The player resource carries the internal guild id, not the
          // snowflake; the env value is the only source when one is wanted.
          discordGuildId: portalEnv.defaultDiscordGuildId,
        }
      : null;

    let status: SessionState['status'];
    if (session) {
      status = 'ready';
    } else if (playerId === null) {
      status = 'unresolved'; // nothing to resolve — bad or absent env value
    } else {
      status = query.isPending && !query.isError ? 'loading' : 'unresolved';
    }

    return {
      status,
      session,
      error: playerId === null ? new InvalidPlayerIdError(configuredPlayerId) : query.error,
      configuredPlayerId,
      retry: () => void query.refetch(),
    };
  }, [query, playerId, configuredPlayerId]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
