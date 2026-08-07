/** `/api/v1/players/*` — identity, the composite profile, and Discord lookup. */
import { getData } from './client';
import type { Player, PlayerLookup, PlayerProfile } from './types';

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
