/**
 * `/api/v1/leaderboards` — guild-scoped rankings for one metric.
 *
 * The guild is the session's, resolved server-side; this client never names a
 * guild. The response carries ranks only — never a raw metric value (plan §10).
 */
import { getData } from './client';
import type { LeaderboardMetric, LeaderboardResponse } from './types';

export const LEADERBOARD_LIMIT = 25;

export function getLeaderboard(
  metric: LeaderboardMetric,
  limit = LEADERBOARD_LIMIT,
  signal?: AbortSignal,
): Promise<LeaderboardResponse> {
  return getData<LeaderboardResponse>('/v1/leaderboards', {
    params: { metric, limit },
    ...(signal ? { signal } : {}),
  });
}
