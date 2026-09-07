/**
 * Leaderboard ranking — the pure core (Achievements & Leaderboards, Phase 1).
 *
 * Ranking lives here, apart from both SQL and the Portal, so tie semantics are
 * defined and tested in one place (§11). The database orders rows; this module
 * turns an order into *ranks*, and a raw metric value never leaves it.
 *
 * ## Tie semantics: standard competition ranking ("1224")
 *
 * Players with equal metric values share a rank, and the next distinct value
 * skips the gap: values [100, 90, 90, 80] rank [1, 2, 2, 4]. This is the
 * ranking players expect from a scoreboard — two joint-seconds, and the next is
 * fourth, not third.
 *
 * ## Determinism
 *
 * Ordering is fully deterministic: descending by value, then **ascending by
 * playerId** as a stable secondary sort. The secondary sort only decides the
 * presentation order *within* a tie; it never changes the shared rank number.
 * Two requests a second apart over unchanged data return byte-identical order,
 * so a player's rank never flickers.
 */

export interface RankedRow {
  playerId: number;
  /** The metric value. Used only to compute rank; must never be serialised. */
  value: number;
}

export interface RankAssignment {
  rank: number;
  playerId: number;
}

/**
 * Order rows and assign competition ranks. Input order is irrelevant — the
 * function sorts deterministically before ranking.
 */
export function assignRanks(rows: readonly RankedRow[]): RankAssignment[] {
  const sorted = [...rows].sort((a, b) => b.value - a.value || a.playerId - b.playerId);

  const out: RankAssignment[] = [];
  let lastValue: number | undefined;
  let lastRank = 0;
  sorted.forEach((row, index) => {
    // A new distinct value takes the 1-based position; equal values inherit the
    // rank of the first row in the tie (the "skip the gap" rule).
    const rank = lastValue !== undefined && row.value === lastValue ? lastRank : index + 1;
    out.push({ rank, playerId: row.playerId });
    lastValue = row.value;
    lastRank = rank;
  });
  return out;
}

/** The rank of one player within an assignment, or null if not present. */
export function rankOf(assignments: readonly RankAssignment[], playerId: number): number | null {
  const found = assignments.find((a) => a.playerId === playerId);
  return found ? found.rank : null;
}
