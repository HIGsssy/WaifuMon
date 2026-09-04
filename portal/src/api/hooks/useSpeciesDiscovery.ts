/**
 * "Is this player allowed to see this species?" — the single answer every
 * artwork gate in the Portal reads.
 *
 * ### Why it is tri-state
 *
 * `discovered: boolean` is the shape that produced the leak this file exists to
 * close. A boolean has no room for *"the Portal does not know yet"*, so every
 * call site had to invent one, and the two obvious inventions are both wrong in
 * the same direction:
 *
 *   - `owned.data?.countBySlug[slug] ?? 0 > 0` reads a missing overlay as
 *     "zero copies", which is the right answer by luck — but only because the
 *     ambient default happened to be falsy.
 *   - a page that gates on `owned.isPending` and then indexes the overlay is
 *     correct only while `isPending` actually means "no answer yet", and
 *     `placeholderData: keepPreviousData` means it does not.
 *
 * So the answer here is `true | false | undefined`, and `undefined` is a real
 * state a caller has to handle rather than a hole it can fall through. The
 * components that consume it (`SpeciesArtwork`) treat anything that is not
 * `true` as locked, which makes the fail-closed direction the *default* one
 * instead of a rule everyone has to remember.
 *
 * ### What "positively established" means
 *
 * Exactly one thing: an overlay is in hand **and it is stamped with the player
 * currently in session**. That stamp is the whole reason `OwnedSlugSummary`
 * carries a `playerId`. React Query serves the previous key's data as
 * placeholder while a new key resolves, and the key carries the player id — so
 * on a session/player change the previous trainer's dex arrives as a
 * `success`-status, non-pending, fully-populated answer for the *wrong person*.
 * Comparing the stamp is what turns that into "unknown" rather than into a
 * strictly larger set of unlocked species.
 *
 * A same-player refresh (the owned count moved after a capture in Discord) is
 * deliberately still trusted: its worst case is under-reporting a species the
 * player just caught, which shows a silhouette for something they own — the
 * acceptable direction, and the one `keepPreviousData` was added to smooth.
 *
 * ### Why a failed walk is "settled", not "unknown"
 *
 * `undefined` means *keep waiting*, and a page that keeps waiting shows a
 * skeleton. A walk that has failed is not going to answer, so leaving it as
 * `undefined` would pin the Encyclopedia on a loading state that never
 * resolves. An error is a definite answer for gating purposes — "nothing can be
 * authorized" — so it settles as `false`, which renders the page with every
 * entry locked. That is both fail-closed and exactly what the Encyclopedia did
 * before any of this existed.
 */
import { useMemo } from 'react';

import { useOwnedSlugs } from './useOwnedSlugs';

export interface SpeciesDiscovery {
  /**
   * `true` when the player owns at least one active copy, `false` when the
   * overlay positively says they own none, and `undefined` while the Portal
   * has no trustworthy answer for *this* player — loading, errored, or holding
   * another player's overlay.
   */
  isDiscovered: (slug: string) => boolean | undefined;
  /**
   * How many copies, or `undefined` when discovery is unknown. Same rules as
   * `isDiscovered`; callers rendering a count must not print `0` for unknown.
   */
  copiesOf: (slug: string) => number | undefined;
  /** The best copy's id for a deep link, when discovery is known. */
  bestCopyOf: (slug: string) => number | undefined;
  /**
   * True once the Portal has an answer to act on — a trustworthy overlay, or a
   * failure that means nothing can be authorized. False only while the answer
   * is still in flight, which is the one state a page should show a skeleton
   * for.
   */
  isSettled: boolean;
}

/**
 * The discovery overlay for one player, as a fail-closed lookup.
 *
 * Shares the underlying `useOwnedSlugs` query, so a page may call this
 * alongside `useOwnedSlugs` (for counts, filters and totals) without issuing a
 * second walk.
 */
export function useSpeciesDiscovery(playerId: number): SpeciesDiscovery {
  const owned = useOwnedSlugs(playerId);
  const summary = owned.data;

  const failed = owned.isError;

  return useMemo(() => {
    // The one condition under which anything below may answer `true`.
    const trusted = summary !== undefined && summary.playerId === playerId ? summary : undefined;
    // No overlay is coming. Settled at "nothing is authorized" — see above.
    const denied = trusted === undefined && failed;

    return {
      isSettled: trusted !== undefined || denied,
      isDiscovered: (slug: string) => {
        if (trusted !== undefined) return (trusted.countBySlug[slug] ?? 0) > 0;
        return denied ? false : undefined;
      },
      copiesOf: (slug: string) => {
        if (trusted !== undefined) return trusted.countBySlug[slug] ?? 0;
        return denied ? 0 : undefined;
      },
      bestCopyOf: (slug: string) =>
        trusted === undefined ? undefined : trusted.bestCopyBySlug[slug],
    };
  }, [summary, playerId, failed]);
}
