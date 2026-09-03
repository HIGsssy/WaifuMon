/**
 * `/api/v1/players/{id}/collection/*` — dex stats, the owned list, one copy,
 * and the buddy.
 *
 * `pageSize` is capped at 25 by the service (it was written for Discord select
 * menus) and the API returns a 400 above that, so the Portal's page size is
 * pinned to the ceiling rather than guessed at call sites.
 */
import { getData, getPage, isPortalApiError } from './client';
import type { AppearanceGallery, DexStats, OwnedEntry, Page, Rarity } from './types';

/** The service's own ceiling — asking for more is a 400, not a truncated page. */
export const COLLECTION_PAGE_SIZE = 25;

/**
 * The orders the endpoint sorts by.
 *
 *   `rarity`  the browse order, and the API's default — rarest first.
 *   `newest`  most recently caught first.
 *
 * `newest` is not a cosmetic re-arrangement. Page 1 of the browse order is the
 * *rarest* 25 copies, which says nothing about recent captures, so without this
 * a "recent catches" strip would have to walk every page of the collection.
 */
export type CollectionSort = 'rarity' | 'newest';

/** How many recent catches the Dashboard strip shows. */
export const RECENT_CATCH_COUNT = 5;

export interface CollectionQuery {
  playerId: number;
  page?: number;
  pageSize?: number;
  /** The one server-side filter the endpoint accepts today (plan §8.2). */
  rarity?: Rarity | undefined;
  /** Omitted means the API's default, `rarity`. */
  sort?: CollectionSort | undefined;
}

export function getCollection(
  { playerId, page = 1, pageSize = COLLECTION_PAGE_SIZE, rarity, sort }: CollectionQuery,
  signal?: AbortSignal,
): Promise<Page<OwnedEntry>> {
  return getPage<OwnedEntry>(`/v1/players/${playerId}/collection/owned`, {
    params: { page, pageSize, ...(rarity ? { rarity } : {}), ...(sort ? { sort } : {}) },
    ...(signal ? { signal } : {}),
  });
}

/**
 * The player's most recent captures — **one short page, never a walk.**
 *
 * The server does the ordering, so this is a single request for exactly the
 * rows that get rendered. It is deliberately not built on
 * {@link getEntireCollection}: that helper exists so the Collection page can
 * filter across the whole set, and borrowing it here would turn a five-item
 * strip into one request per 25 copies owned, on every Dashboard mount.
 */
export function getRecentCatches(
  playerId: number,
  limit: number = RECENT_CATCH_COUNT,
  signal?: AbortSignal,
): Promise<OwnedEntry[]> {
  return getCollection({ playerId, page: 1, pageSize: limit, sort: 'newest' }, signal).then(
    (result) => result.items,
  );
}

/** Fetch every API page so UI filters can run before UI pagination. */
export async function getEntireCollection(
  playerId: number,
  signal?: AbortSignal,
): Promise<OwnedEntry[]> {
  const entries: OwnedEntry[] = [];
  let requestedPage = 1;
  let total = Number.POSITIVE_INFINITY;

  while (entries.length < total) {
    const result = await getCollection(
      { playerId, page: requestedPage, pageSize: COLLECTION_PAGE_SIZE },
      signal,
    );
    total = result.total;
    entries.push(...result.items);

    // The echoed page detects an unexpected server clamp and prevents a loop.
    if (result.items.length === 0 || result.page !== requestedPage) break;
    requestedPage += 1;
  }

  return entries;
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
 * This copy's appearance gallery — locked entries included, each with its
 * requirement.
 *
 * The API acknowledges newly-qualified appearances as a side effect of this
 * read, which is what makes retroactively-added artwork notify correctly. The
 * Portal does not (and must not) compute unlock state itself: `isUnlocked`
 * comes from the server, always.
 */
export function getAppearances(
  playerId: number,
  waifuId: number,
  signal?: AbortSignal,
): Promise<AppearanceGallery> {
  return getData<AppearanceGallery>(
    `/v1/players/${playerId}/collection/owned/${waifuId}/appearances`,
    signal ? { signal } : {},
  );
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
