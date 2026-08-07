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
 *   identity     who the Portal is acting as. Changes when a developer switches
 *                players, which is an explicit act — never behind your back —
 *                so it does not refetch on focus at all
 *   content      effectively static — only an admin "Save + Reload" changes it,
 *                so it never refetches on focus and never goes stale
 *   shop         changes rarely; players notice a slow shop far more than an
 *                occasionally-stale price
 *   player data  captures, care ticks and purchases move these numbers, so a
 *                short window plus refetch-on-focus catches a player up when
 *                they alt-tab back from Discord
 *
 * ### `refetchOnReconnect` is per-policy, not global
 *
 * It used to be `true` for everything at the client level. On a link that drops
 * briefly — a laptop lid, a Tailscale re-handshake — that fires *every* mounted
 * query at once, which is the worst possible moment to ask a recovering
 * connection for a burst. Data that cannot have changed while offline (content)
 * opts out; data that can (player state) keeps it.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export interface CachePolicy {
  staleTime: number;
  gcTime: number;
  refetchOnWindowFocus: boolean;
  refetchOnReconnect: boolean;
}

/**
 * The acting player's identity — the session provider's own resolution.
 *
 * Medium-lived and deliberately **not** focus-refetched. The player row backing
 * a session changes on level-up, but the session only reads id, guild, name and
 * avatar from it; re-fetching that every time the tab regains focus was one
 * request per focus event for a value that had not moved. The dashboard's
 * `/profile` call refreshes the same row through `usePlayerProfile`, so the
 * data still stays current without a second request.
 */
export const IDENTITY_POLICY: CachePolicy = {
  staleTime: 2 * MINUTE,
  gcTime: 30 * MINUTE,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
};

/** Content endpoints — the snapshot the admin panel republishes atomically. */
export const CONTENT_POLICY: CachePolicy = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 6 * HOUR,
  refetchOnWindowFocus: false,
  // Nothing an operator does while your laptop is asleep changes the content
  // snapshot in a way worth a reconnect burst; a reload picks it up.
  refetchOnReconnect: false,
};

/** The shop catalog — long-lived, but not frozen. */
export const SHOP_POLICY: CachePolicy = {
  staleTime: 5 * MINUTE,
  gcTime: 30 * MINUTE,
  // Player-independent and five-minute stale: a focus refetch is a request for
  // a price that almost certainly has not moved.
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
};

/**
 * Everything scoped to a player: profile, collection, buddy, care, inventory.
 *
 * 45 seconds rather than 30: the Portal is read-only, so nothing it shows can
 * be *its own* fault for being stale, and the extra fifteen seconds measurably
 * cuts the request count on a page with several player-scoped tiles.
 */
export const PLAYER_POLICY: CachePolicy = {
  staleTime: 45 * SECOND,
  gcTime: 10 * MINUTE,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
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
