/**
 * Achievement query hook (plan §6, §7).
 *
 * A single player-scoped query for the whole wall — summary and every resolved
 * badge — under `PLAYER_POLICY`, so a capture or level-up in Discord is caught
 * on the next window focus. The Portal renders what the backend resolved; it
 * never recomputes progress.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { getAchievements } from '../achievements';
import { PLAYER_POLICY } from '../cachePolicy';
import { queryKeys } from '../queryKeys';
import type { AchievementsResponse } from '../types';

export function useAchievements(playerId: number): UseQueryResult<AchievementsResponse> {
  return useQuery({
    queryKey: queryKeys.achievements(playerId),
    queryFn: ({ signal }) => getAchievements(playerId, signal),
    ...PLAYER_POLICY,
  });
}
