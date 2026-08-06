/**
 * `/api/v1/players/{id}/collection/*` — dex stats, the owned list, one copy,
 * and the buddy.
 *
 * `pageSize` is capped at 25 by the service (it was written for Discord select
 * menus) and the API returns a 400 above that, so the Portal's page size is
 * pinned to the ceiling rather than guessed at call sites.
 */
import { getData, getPage, isPortalApiError } from './client';
import type { DexStats, OwnedEntry, Page, Rarity } from './types';

/** The service's own ceiling — asking for more is a 400, not a truncated page. */
export const COLLECTION_PAGE_SIZE = 25;

export interface CollectionQuery {
  playerId: number;
  page?: number;
  pageSize?: number;
  /** The one server-side filter the endpoint accepts today (plan §8.2). */
  rarity?: Rarity | undefined;
}

export function getCollection(
  { playerId, page = 1, pageSize = COLLECTION_PAGE_SIZE, rarity }: CollectionQuery,
  signal?: AbortSignal,
): Promise<Page<OwnedEntry>> {
  return getPage<OwnedEntry>(`/v1/players/${playerId}/collection/owned`, {
    params: { page, pageSize, ...(rarity ? { rarity } : {}) },
    ...(signal ? { signal } : {}),
  });
}

export function getCollectionEntry(
  playerId: number,
  waifuId: number,
  signal?: AbortSignal,
): Promise<OwnedEntry> {
  return getData<OwnedEntry>(
    `/v1/players/${playerId}/collection/owned/${waifuId}`,
    signal ? { signal } : {},
  );
}

export function getCollectionStats(playerId: number, signal?: AbortSignal): Promise<DexStats> {
  return getData<DexStats>(`/v1/players/${playerId}/collection/stats`, signal ? { signal } : {});
}

/**
 * The active buddy, or `null` when none is set.
 *
 * The API answers `404 BUDDY_NOT_SET` for "no buddy", which is a normal state
 * rather than an error for every screen that shows a buddy. Translating it to
 * `null` once here keeps the empty-state branch out of three feature folders;
 * every other 404 still propagates.
 */
export async function getBuddy(playerId: number, signal?: AbortSignal): Promise<OwnedEntry | null> {
  try {
    return await getData<OwnedEntry>(
      `/v1/players/${playerId}/collection/buddy`,
      signal ? { signal } : {},
    );
  } catch (error) {
    if (isPortalApiError(error) && error.code === 'BUDDY_NOT_SET') return null;
    throw error;
  }
}
