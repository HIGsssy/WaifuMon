/**
 * `/api/v1/players/{id}/achievements` — a player's own achievement wall.
 *
 * Self-scoped on the backend: the Portal only ever asks for the current
 * session's own player. Progress and hidden-safe presentation are resolved
 * server-side (plan §6) — this client neither evaluates criteria nor knows a
 * hidden achievement's threshold.
 */
import { getData } from './client';
import type { AchievementsResponse } from './types';

export function getAchievements(
  playerId: number,
  signal?: AbortSignal,
): Promise<AchievementsResponse> {
  return getData<AchievementsResponse>(
    `/v1/players/${playerId}/achievements`,
    signal ? { signal } : {},
  );
}
