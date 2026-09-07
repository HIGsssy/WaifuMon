/**
 * Leaderboard query hook (plan §12, §13).
 *
 * Keyed by guild so switching servers never renders one guild's ladder under
 * another's, and disabled until a guild is resolved (the same guard the
 * directory uses). Under `PLAYER_POLICY` because ranks move as guild-mates play.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getLeaderboard, LEADERBOARD_LIMIT } from '../leaderboards';
import { PLAYER_POLICY } from '../cachePolicy';
import { queryKeys } from '../queryKeys';
import type { LeaderboardMetric, LeaderboardResponse } from '../types';

export function useLeaderboard(
  guildDbId: number | undefined,
  metric: LeaderboardMetric,
): UseQueryResult<LeaderboardResponse> {
  return useQuery({
    queryKey: queryKeys.leaderboard(guildDbId ?? -1, metric),
    queryFn: ({ signal }) => getLeaderboard(metric, LEADERBOARD_LIMIT, signal),
    enabled: guildDbId !== undefined,
    ...PLAYER_POLICY,
  });
}
