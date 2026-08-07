/**
 * Player queries (plan §11): hooks wrap the helpers 1:1 and add nothing but
 * cache policy. Anything that looks like a derivation belongs on the API.
 */
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import { getPlayerProfile } from '../players';
import { queryKeys } from '../queryKeys';
import type { PlayerProfile } from '../types';

/**
 * `/profile` is a composite of `/players/{id}` and `/players/{id}/currency`, so
 * its response already contains the player row the session provider fetched
 * separately at startup. Writing it back into `playerRecord` means that query
 * never has to go and ask again — a background refresh of the dashboard keeps
 * the session's copy of the player fresh for free.
 *
 * This is deduplication *through the cache*, which is the point: no hook is
 * merged, no composite request is invented, and either query still works alone.
 */
function seedPlayerRecord(client: QueryClient, profile: PlayerProfile): PlayerProfile {
  client.setQueryData(queryKeys.playerRecord(profile.player.id), profile.player);
  return profile;
}

export function usePlayerProfile(playerId: number): UseQueryResult<PlayerProfile> {
  const client = useQueryClient();

  return useQuery({
    queryKey: queryKeys.playerProfile(playerId),
    queryFn: ({ signal }) =>
      getPlayerProfile(playerId, signal).then((profile) => seedPlayerRecord(client, profile)),
    ...PLAYER_POLICY,
  });
}
