/**
 * `/api/v1/players/{id}/public/collection/*` — a guild-mate's collection.
 *
 * A deliberately separate module from `collection.ts`, not a flag on it. The
 * two resources answer different questions ("my copies" vs "theirs"), are
 * authorized differently (session player vs session *guild*), and carry
 * different payloads — the public one has no XP, affection or Seductive Power.
 * Keeping them apart is what makes it impossible to reach for the wrong one by
 * passing the wrong argument.
 *
 * Note what is *not* a parameter here either: the guild. The server reads it
 * from the session cookie, so this client cannot ask about a player in a server
 * the viewer has not selected.
 */
import { getData, getPage } from './client';
import { COLLECTION_PAGE_SIZE, type CollectionSort } from './collection';
import type { Page, PublicOwnedEntry, Rarity } from './types';

export interface PublicCollectionQuery {
  playerId: number;
  page?: number;
  pageSize?: number;
  rarity?: Rarity | undefined;
  sort?: CollectionSort | undefined;
}

export function getPublicCollection(
  { playerId, page = 1, pageSize = COLLECTION_PAGE_SIZE, rarity, sort }: PublicCollectionQuery,
  signal?: AbortSignal,
): Promise<Page<PublicOwnedEntry>> {
  return getPage<PublicOwnedEntry>(`/v1/players/${playerId}/public/collection`, {
    params: { page, pageSize, ...(rarity ? { rarity } : {}), ...(sort ? { sort } : {}) },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Every page of a guild-mate's collection, walked once.
 *
 * The same shape as `getEntireCollection`, and for the same reason: the
 * Collection page's search, race and affinity filters are client-side across
 * the whole set, because no endpoint on this API filters by those server-side.
 * Reusing the pattern is what lets one renderer serve both modes; inventing
 * server-side filters here would have meant a gameplay-service change for one
 * screen and two collection surfaces that could disagree.
 */
export async function getEntirePublicCollection(
  playerId: number,
  signal?: AbortSignal,
): Promise<PublicOwnedEntry[]> {
  const entries: PublicOwnedEntry[] = [];
  let requestedPage = 1;
  let total = Number.POSITIVE_INFINITY;

  while (entries.length < total) {
    const result = await getPublicCollection(
      { playerId, page: requestedPage, pageSize: COLLECTION_PAGE_SIZE },
      signal,
    );
    total = result.total;
    entries.push(...result.items);
    // A page that comes back empty ends the walk rather than looping forever
    // on a total the server and the page disagree about.
    if (result.items.length === 0) break;
    requestedPage += 1;
  }

  return entries;
}

export function getPublicCollectionEntry(
  playerId: number,
  waifuId: number,
  signal?: AbortSignal,
): Promise<PublicOwnedEntry> {
  return getData<PublicOwnedEntry>(
    `/v1/players/${playerId}/public/collection/${waifuId}`,
    signal ? { signal } : {},
  );
}
