/** `/api/v1/players/*` — identity, the composite profile, and Discord lookup. */
import { getData, getPage } from './client';
import type {
  DirectoryPlayer,
  DirectorySort,
  Page,
  Player,
  PlayerLookup,
  PlayerProfile,
  PublicPlayerProfile,
} from './types';

export function getPlayer(playerId: number, signal?: AbortSignal): Promise<Player> {
  return getData<Player>(`/v1/players/${playerId}`, signal ? { signal } : {});
}

export function getPlayerProfile(playerId: number, signal?: AbortSignal): Promise<PlayerProfile> {
  return getData<PlayerProfile>(`/v1/players/${playerId}/profile`, signal ? { signal } : {});
}

/**
 * Resolves a Discord identity to an internal player id. Never provisions.
 *
 * Unused by v1's dev auth (which takes the internal id straight from the env),
 * but it is the endpoint the future OAuth provider calls (plan §6), so it lives
 * here rather than being written twice.
 */
export function getPlayerLookup(
  params: { discordGuildId: string; discordUserId: string },
  signal?: AbortSignal,
): Promise<PlayerLookup> {
  return getData<PlayerLookup>('/v1/players/lookup', { params, ...(signal ? { signal } : {}) });
}

// ── Guild player directory ──────────────────────────────────────────────────

/**
 * The Players directory for the session's **currently selected guild**.
 *
 * Note what is not a parameter: the guild. The server reads it from the
 * authenticated Portal session, so this client cannot ask for another server's
 * players even if a caller wanted it to — the same arrangement the admin
 * clients use. `guildDbId` still reaches the *cache key* (see `queryKeys`),
 * because a cache entry from guild A must never be served while guild B is
 * selected; it just never reaches the wire.
 */
export const DIRECTORY_PAGE_SIZE = 25;

export function getPlayerDirectory(
  params: {
    page: number;
    pageSize?: number;
    search?: string | undefined;
    sort: DirectorySort;
  },
  signal?: AbortSignal,
): Promise<Page<DirectoryPlayer>> {
  return getPage<DirectoryPlayer>('/v1/players', {
    params: {
      page: params.page,
      pageSize: params.pageSize ?? DIRECTORY_PAGE_SIZE,
      sort: params.sort,
      ...(params.search ? { search: params.search } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/** Another player's public profile. 404s for anyone outside the selected guild. */
export function getPublicPlayerProfile(
  playerId: number,
  signal?: AbortSignal,
): Promise<PublicPlayerProfile> {
  return getData<PublicPlayerProfile>(
    `/v1/players/${playerId}/public`,
    signal ? { signal } : {},
  );
}
