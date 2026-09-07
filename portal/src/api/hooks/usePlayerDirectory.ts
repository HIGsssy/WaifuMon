/**
 * The Players directory, and the public profile it links to.
 *
 * ## Why these hooks take a `guildDbId` they never send
 *
 * The server scopes the request to the session's selected guild on its own —
 * the id is not a request parameter and cannot be one. It is here purely to
 * discriminate the *cache*: TanStack Query would otherwise happily serve guild
 * A's roster for guild B's first render, because as far as it is concerned the
 * key did not change. Passing the guild in makes A and B different entries, so
 * a switch produces a fresh fetch rather than a flash of the previous server's
 * players.
 *
 * ## Fail closed while the guild is resolving
 *
 * `enabled: guildDbId !== undefined` — with no resolved guild the query does
 * not run and the page renders its loading state. It never renders "no players"
 * or, worse, the last guild's list, during a switch.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import { getPlayerDirectory, getPublicPlayerProfile } from '../players';
import { queryKeys } from '../queryKeys';
import type { DirectoryPlayer, DirectorySort, Page, PublicPlayerProfile } from '../types';

export interface UsePlayerDirectoryArgs {
  /** The session's selected guild. Cache scope only — never sent. */
  guildDbId: number | undefined;
  page: number;
  search: string;
  sort: DirectorySort;
}

export function usePlayerDirectory({
  guildDbId,
  page,
  search,
  sort,
}: UsePlayerDirectoryArgs): UseQueryResult<Page<DirectoryPlayer>> {
  return useQuery({
    // `guildDbId ?? -1` is unreachable while `enabled` is false; it exists only
    // because the key must be a value. -1 is not a guild id, so even if a
    // future refactor enabled the query it could not collide with a real one.
    queryKey: queryKeys.playerDirectory(guildDbId ?? -1, { page, search, sort }),
    queryFn: ({ signal }) => getPlayerDirectory({ page, search, sort }, signal),
    // Paging and re-sorting keep the current rows on screen; switching *guild*
    // does not, because that changes the key's guild segment and there is no
    // previous data under it.
    placeholderData: keepPreviousData,
    enabled: guildDbId !== undefined,
    ...PLAYER_POLICY,
  });
}

export function usePublicPlayerProfile(
  guildDbId: number | undefined,
  playerId: number,
): UseQueryResult<PublicPlayerProfile> {
  return useQuery({
    queryKey: queryKeys.publicProfile(guildDbId ?? -1, playerId),
    queryFn: ({ signal }) => getPublicPlayerProfile(playerId, signal),
    enabled: guildDbId !== undefined && Number.isInteger(playerId) && playerId > 0,
    ...PLAYER_POLICY,
  });
}
