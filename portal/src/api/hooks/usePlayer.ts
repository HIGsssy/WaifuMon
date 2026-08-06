/**
 * Player queries (plan §11): hooks wrap the helpers 1:1 and add nothing but
 * cache policy. Anything that looks like a derivation belongs on the API.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import { getPlayerProfile } from '../players';
import { queryKeys } from '../queryKeys';
import type { PlayerProfile } from '../types';

export function usePlayerProfile(playerId: number): UseQueryResult<PlayerProfile> {
  return useQuery({
    queryKey: queryKeys.playerProfile(playerId),
    queryFn: ({ signal }) => getPlayerProfile(playerId, signal),
    ...PLAYER_POLICY,
  });
}
