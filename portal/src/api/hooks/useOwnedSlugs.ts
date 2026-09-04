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
 * Every other player query is 45-second stale and refetches on focus. This one
 * walks the whole collection — one request per 25 owned copies — so re-running
 * it that often would turn a 200-copy collection into eight requests every
 * time the tab regains focus. It is a compromise the API can retire: §25.5's
 * `GET /players/{id}/collection/dex` would make this a single short-lived
 * request and this file would shrink to a `useQuery` call.
 *
 * ### How a capture reaches the overlay
 *
 * A long stale time alone made this query *wrong*, not merely slow. The
 * overlay is what the Encyclopedia's `discovered` flag reads, so a species
 * caught in Discord kept rendering as a silhouette — the locked presentation
 * for something the player now owned — until the timer happened to expire.
 * Capture happens in Discord, so the Portal has no mutation to invalidate
 * from; it has to notice.
 *
 * `collection/stats.owned` is what it notices with: one cheap request, already
 * on `PLAYER_POLICY` (45s, refetch on focus), and it moves on exactly the
 * events that change ownership. Folding it into the query key means the walk
 * re-runs when — and only when — that count moves, which is both correct and
 * *fewer* requests than a short stale time would have cost. `keepPreviousData`
 * keeps the previous overlay on screen while the new walk runs, so tiles never
 * flash back to silhouettes mid-refresh.
 *
 * The stale time stays as a backstop for the one case the count cannot see: a
 * capture and a release between two reads of `stats` net to the same number
 * with a different set of slugs.
 *
 * The walk is bounded so a pagination bug on either side cannot spin forever.
 */
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { COLLECTION_PAGE_SIZE, getCollection } from '../collection';
import { queryKeys } from '../queryKeys';
import { useCollectionStats } from './useCollection';

/** Backstop only — the owned count in the key is the primary trigger. */
const OWNED_SLUGS_STALE_TIME = 5 * 60_000;

/** ~1,000 owned copies at 25 a page. Far past any real collection. */
const MAX_PAGES = 40;

export interface OwnedSlugSummary {
  /**
   * Whose collection this overlay was walked from.
   *
   * Load-bearing, not diagnostic. `placeholderData: keepPreviousData` keeps the
   * previous query's answer on screen while a new key resolves — and the key
   * carries the player id, so on a player switch the *previous player's* dex is
   * served with `status: 'success'` and `isPending: false`. Anything reading
   * this summary to decide whether artwork may be revealed has to be able to
   * tell whose answer it is holding; see `useSpeciesDiscovery`, which refuses
   * to trust a summary that is not stamped with the current player.
   */
  playerId: number;
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

  return { playerId, countBySlug, bestCopyBySlug, truncated };
}

export function useOwnedSlugs(playerId: number): UseQueryResult<OwnedSlugSummary> {
  const stats = useCollectionStats(playerId);
  const ownedCount = stats.data?.owned;

  // Wait for the count before walking, so the first overlay is already keyed
  // on it rather than stranded under the `unknown` sentinel. The count is an
  // optimisation for *when* to walk, never a precondition for walking: if it
  // fails, the walk still runs under the sentinel and the page behaves exactly
  // as it did before this key existed — stale-time only.
  const ready = ownedCount !== undefined || stats.isError;

  return useQuery({
    queryKey: queryKeys.ownedSlugs(playerId, ownedCount),
    queryFn: ({ signal }) => walkCollection(playerId, signal),
    enabled: ready,
    // The overlay for the previous count stays on screen while the new walk
    // runs — a refresh must never flash owned species back to silhouettes.
    placeholderData: keepPreviousData,
    staleTime: OWNED_SLUGS_STALE_TIME,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}
