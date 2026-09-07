/**
 * Queries for a guild-mate's collection.
 *
 * ## The cache boundary is the whole point of this file
 *
 * Three things must never be confused, and the key shape is what keeps them
 * apart:
 *
 *   - **the viewer's collection** — `['player', viewerId, 'collection', …]`
 *   - **a guild-mate's collection** — `['players', guildDbId, 'collection',
 *     ownerId, …]`
 *   - **the same guild-mate, viewed from a different guild** — a different
 *     `guildDbId` segment, therefore a different entry
 *
 * The owner's id is a *segment of the key*, not merely an argument to the
 * fetcher, so navigating from one player's collection to another's cannot serve
 * the first player's cards while the second loads. And the public keys live
 * under the `['players', guildDbId, …]` prefix rather than `['player', id, …]`,
 * so a future per-player invalidation of the viewer's own subtree cannot reach
 * into — or be reached by — somebody else's.
 *
 * ## Fail closed
 *
 * Every hook here is disabled until both the guild and the owner are resolved.
 * A page mid-guild-switch renders its loading state; it never renders the
 * previous guild's data and never issues a request that the server would have
 * to refuse.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import { getEntirePublicCollection, getPublicCollectionEntry } from '../publicCollection';
import { queryKeys } from '../queryKeys';
import type { PublicOwnedEntry } from '../types';

export interface PublicCollectionArgs {
  /** The viewer's selected guild. Cache scope only — never sent. */
  guildDbId: number | undefined;
  /** The owner whose collection is being viewed. */
  playerId: number | undefined;
  enabled?: boolean;
}

export function useEntirePublicCollection({
  guildDbId,
  playerId,
  enabled = true,
}: PublicCollectionArgs): UseQueryResult<PublicOwnedEntry[]> {
  const ready = enabled && guildDbId !== undefined && playerId !== undefined && playerId > 0;
  return useQuery({
    // The `?? -1` placeholders are unreachable while `ready` is false, and -1
    // is not a valid id, so they cannot collide with a real cache entry.
    queryKey: queryKeys.publicCollection(guildDbId ?? -1, playerId ?? -1),
    queryFn: ({ signal }) => getEntirePublicCollection(playerId as number, signal),
    // Keeps the grid on screen while *paging or filtering* within one player.
    // Switching player changes the key's owner segment, where there is no
    // previous data — so the grid goes to skeletons rather than flashing the
    // last trainer's cards.
    placeholderData: keepPreviousData,
    enabled: ready,
    ...PLAYER_POLICY,
  });
}

export function usePublicCollectionEntry(
  guildDbId: number | undefined,
  playerId: number | undefined,
  waifuId: number,
): UseQueryResult<PublicOwnedEntry> {
  const ready =
    guildDbId !== undefined &&
    playerId !== undefined &&
    playerId > 0 &&
    Number.isInteger(waifuId) &&
    waifuId > 0;
  return useQuery({
    queryKey: queryKeys.publicCollectionEntry(guildDbId ?? -1, playerId ?? -1, waifuId),
    queryFn: ({ signal }) => getPublicCollectionEntry(playerId as number, waifuId, signal),
    enabled: ready,
    ...PLAYER_POLICY,
  });
}
