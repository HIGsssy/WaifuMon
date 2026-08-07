/**
 * Which species the player has discovered, and how many of each.
 *
 * The Encyclopedia needs a per-slug ownership overlay (plan §8.7). No endpoint
 * returns one, so v1 derives it by paging through `/collection/owned` once and
 * caching the result for the session — exactly what §8.7 prescribes.
 *
 * **This is presentation grouping, not gameplay logic.** It counts rows the API
 * returned, by a field the API returned. Nothing is inferred about capture
 * rates, rarity weighting or dex rules.
 *
 * ### Why the cache policy differs from `PLAYER_POLICY`
 *
 * Every other player query is 30-second stale. This one walks the whole
 * collection — one request per 25 owned copies — so re-running it that often
 * would turn a 200-copy collection into eight requests every half minute. Five
 * minutes is the compromise, and it is a compromise the API can retire: §25.5's
 * `GET /players/{id}/collection/dex` would make this a single short-lived
 * request and this file would shrink to a `useQuery` call.
 *
 * The walk is bounded so a pagination bug on either side cannot spin forever.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { COLLECTION_PAGE_SIZE, getCollection } from '../collection';
import { queryKeys } from '../queryKeys';

/** Long enough to avoid re-walking constantly; short enough to catch new finds. */
const OWNED_SLUGS_STALE_TIME = 5 * 60_000;

/** ~1,000 owned copies at 25 a page. Far past any real collection. */
const MAX_PAGES = 40;

export interface OwnedSlugSummary {
  /** Species slug → how many active copies the player owns. */
  countBySlug: Record<string, number>;
  /** Species slug → the highest-level copy's owned id, for deep links. */
  bestCopyBySlug: Record<string, number>;
  /** True when the walk stopped at the page cap rather than the end. */
  truncated: boolean;
}

async function walkCollection(
  playerId: number,
  signal: AbortSignal | undefined,
): Promise<OwnedSlugSummary> {
  const countBySlug: Record<string, number> = {};
  const bestCopyBySlug: Record<string, number> = {};
  const bestLevelBySlug: Record<string, number> = {};

  let page = 1;
  let truncated = false;

  for (;;) {
    const result = await getCollection({ playerId, page, pageSize: COLLECTION_PAGE_SIZE }, signal);

    for (const entry of result.items) {
      const slug = entry.species.slug;
      countBySlug[slug] = (countBySlug[slug] ?? 0) + 1;
      if (entry.waifu.level >= (bestLevelBySlug[slug] ?? -1)) {
        bestLevelBySlug[slug] = entry.waifu.level;
        bestCopyBySlug[slug] = entry.waifu.id;
      }
    }

    const seen = result.page * result.pageSize;
    // The service clamps an out-of-range page, so trust its echoed `page`
    // rather than our own counter when deciding whether to continue.
    if (result.items.length === 0 || seen >= result.total) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    page += 1;
  }

  return { countBySlug, bestCopyBySlug, truncated };
}

export function useOwnedSlugs(playerId: number): UseQueryResult<OwnedSlugSummary> {
  return useQuery({
    queryKey: queryKeys.ownedSlugs(playerId),
    queryFn: ({ signal }) => walkCollection(playerId, signal),
    staleTime: OWNED_SLUGS_STALE_TIME,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
