/**
 * Collection queries (plan §11, §13, §14).
 *
 * `placeholderData: keepPreviousData` on the list is the mechanical form of
 * §14's first rule: turning a page or changing the rarity filter keeps the
 * previous grid on screen while the next one loads, so the artwork never
 * flashes away. `isPlaceholderData` is what the toolbar's quiet refetching
 * indicator reads.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { PLAYER_POLICY } from '../cachePolicy';
import {
  COLLECTION_PAGE_SIZE,
  getAppearances,
  getBuddy,
  getCollection,
  getEntireCollection,
  getCollectionEntry,
  getCollectionStats,
  getRecentCatches,
  RECENT_CATCH_COUNT,
} from '../collection';
import { queryKeys } from '../queryKeys';
import type { AppearanceGallery, DexStats, OwnedEntry, Page, Rarity } from '../types';

export interface UseCollectionArgs {
  playerId: number;
  page: number;
  rarity?: Rarity | undefined;
}

export function useCollection({
  playerId,
  page,
  rarity,
}: UseCollectionArgs): UseQueryResult<Page<OwnedEntry>> {
  return useQuery({
    queryKey: queryKeys.collectionList(playerId, page, rarity),
    queryFn: ({ signal }) =>
      getCollection({ playerId, page, pageSize: COLLECTION_PAGE_SIZE, rarity }, signal),
    placeholderData: keepPreviousData,
    ...PLAYER_POLICY,
  });
}

/**
 * Complete collection used when filters and pagination must share one dataset.
 *
 * `enabled` exists so the shared Collection renderer can call this hook
 * unconditionally — keeping hook order stable — while the *public* mode leaves
 * it switched off. Without it, viewing a guild-mate's collection would also
 * fetch the viewer's own on every mount, which is both a wasted walk and the
 * exact adjacency where the two datasets could get confused.
 */
export function useEntireCollection(
  playerId: number,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<OwnedEntry[]> {
  return useQuery({
    queryKey: queryKeys.collectionAll(playerId),
    queryFn: ({ signal }) => getEntireCollection(playerId, signal),
    placeholderData: keepPreviousData,
    enabled,
    ...PLAYER_POLICY,
  });
}

export function useCollectionEntry(playerId: number, waifuId: number): UseQueryResult<OwnedEntry> {
  return useQuery({
    queryKey: queryKeys.collectionEntry(playerId, waifuId),
    queryFn: ({ signal }) => getCollectionEntry(playerId, waifuId, signal),
    enabled: Number.isInteger(waifuId) && waifuId > 0,
    ...PLAYER_POLICY,
  });
}

/**
 * The player's most recent captures, newest first.
 *
 * One request for one short page — the server sorts, so nothing here walks the
 * collection or re-sorts a page it was handed. Shares `PLAYER_POLICY` with the
 * rest of the player-scoped queries, so a capture made in Discord shows up when
 * the tab regains focus.
 */
export function useRecentCatches(
  playerId: number,
  limit: number = RECENT_CATCH_COUNT,
): UseQueryResult<OwnedEntry[]> {
  return useQuery({
    queryKey: queryKeys.collectionRecent(playerId, limit),
    queryFn: ({ signal }) => getRecentCatches(playerId, limit, signal),
    ...PLAYER_POLICY,
  });
}

export function useCollectionStats(playerId: number): UseQueryResult<DexStats> {
  return useQuery({
    queryKey: queryKeys.collectionStats(playerId),
    queryFn: ({ signal }) => getCollectionStats(playerId, signal),
    ...PLAYER_POLICY,
  });
}

/**
 * `null` is a valid, expected result — the player simply has no buddy (§8.4).
 *
 * `enabled` is off in the public Collection view: the *viewer's* buddy has no
 * bearing on somebody else's grid, and the owner's arrives on each entry as
 * `isBuddy` instead. See the note in `CollectionPage`.
 */
export function useBuddy(
  playerId: number,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<OwnedEntry | null> {
  return useQuery({
    queryKey: queryKeys.buddy(playerId),
    queryFn: ({ signal }) => getBuddy(playerId, signal),
    enabled,
    ...PLAYER_POLICY,
  });
}

/**
 * One copy's appearance gallery.
 *
 * `isUnlocked` is **always** the server's answer — the Portal never derives it.
 * That is what keeps Discord and the Portal from ever disagreeing about what a
 * player has earned, and it is why new unlock sources need no Portal change.
 */
export function useWaifuAppearances(
  playerId: number,
  waifuId: number,
): UseQueryResult<AppearanceGallery> {
  return useQuery({
    queryKey: queryKeys.waifuAppearances(playerId, waifuId),
    queryFn: ({ signal }) => getAppearances(playerId, waifuId, signal),
    enabled: Number.isInteger(waifuId) && waifuId > 0,
    ...PLAYER_POLICY,
  });
}
