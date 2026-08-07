/**
 * Cache policy — the executable form of plan §13.
 *
 * The plan's table is the contract; this file is the single place its numbers
 * live, and `src/api/__tests__/cachePolicy.test.ts` locks them so a distracted
 * config change cannot quietly turn the Portal stale (§22.5, §26 "Cache TTLs
 * drift").
 *
 * The shape of the rule matters more than the exact seconds:
 *
 *   content      effectively static — only an admin "Save + Reload" changes it,
 *                so it never refetches on focus and never goes stale
 *   shop         changes rarely; players notice a slow shop far more than an
 *                occasionally-stale price
 *   player data  captures, care ticks and purchases move these numbers, so a
 *                short window plus refetch-on-focus catches a player up when
 *                they alt-tab back from Discord
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export interface CachePolicy {
  staleTime: number;
  gcTime: number;
  refetchOnWindowFocus: boolean;
}

/** Content endpoints — the snapshot the admin panel republishes atomically. */
export const CONTENT_POLICY: CachePolicy = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 6 * HOUR,
  refetchOnWindowFocus: false,
};

/** The shop catalog — long-lived, but not frozen. */
export const SHOP_POLICY: CachePolicy = {
  staleTime: 5 * MINUTE,
  gcTime: 30 * MINUTE,
  refetchOnWindowFocus: true,
};

/** Everything scoped to a player: profile, collection, buddy, care, inventory. */
export const PLAYER_POLICY: CachePolicy = {
  staleTime: 30 * SECOND,
  gcTime: 10 * MINUTE,
  refetchOnWindowFocus: true,
};

/**
 * Spreads a policy into a TanStack Query options object.
 *
 * Written as a function rather than an inline spread so a hook cannot pick up
 * three of the four fields and silently disagree with the table.
 */
export function withPolicy(policy: CachePolicy): CachePolicy {
  return { ...policy };
}
