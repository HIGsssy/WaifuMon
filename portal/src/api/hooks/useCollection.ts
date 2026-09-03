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

/** Complete collection used when filters and pagination must share one dataset. */
export function useEntireCollection(playerId: number): UseQueryResult<OwnedEntry[]> {
  return useQuery({
    queryKey: queryKeys.collectionAll(playerId),
    queryFn: ({ signal }) => getEntireCollection(playerId, signal),
    placeholderData: keepPreviousData,
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

export function useCollectionStats(playerId: number): UseQueryResult<DexStats> {
  return useQuery({
    queryKey: queryKeys.collectionStats(playerId),
    queryFn: ({ signal }) => getCollectionStats(playerId, signal),
    ...PLAYER_POLICY,
  });
}

/** `null` is a valid, expected result — the player simply has no buddy (§8.4). */
export function useBuddy(playerId: number): UseQueryResult<OwnedEntry | null> {
  return useQuery({
    queryKey: queryKeys.buddy(playerId),
    queryFn: ({ signal }) => getBuddy(playerId, signal),
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
