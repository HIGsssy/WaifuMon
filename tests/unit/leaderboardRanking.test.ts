/**
 * Pure leaderboard ranking — competition ("1224") ties, deterministic
 * secondary sort, and `me.rank` for players inside and outside a page.
 */
import { describe, expect, it } from 'vitest';
import { assignRanks, rankOf } from '../../src/modules/leaderboards/leaderboardRanking';

describe('assignRanks', () => {
  it('ranks by value descending', () => {
    const ranked = assignRanks([
      { playerId: 1, value: 10 },
      { playerId: 2, value: 30 },
      { playerId: 3, value: 20 },
    ]);
    expect(ranked).toEqual([
      { rank: 1, playerId: 2 },
      { rank: 2, playerId: 3 },
      { rank: 3, playerId: 1 },
    ]);
  });

  it('uses standard competition ranking for ties (1, 2, 2, 4)', () => {
    const ranked = assignRanks([
      { playerId: 1, value: 100 },
      { playerId: 2, value: 90 },
      { playerId: 3, value: 90 },
      { playerId: 4, value: 80 },
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });

  it('orders tied players deterministically by ascending playerId without changing rank', () => {
    const a = assignRanks([
      { playerId: 9, value: 50 },
      { playerId: 3, value: 50 },
      { playerId: 7, value: 50 },
    ]);
    const b = assignRanks([
      { playerId: 7, value: 50 },
      { playerId: 9, value: 50 },
      { playerId: 3, value: 50 },
    ]);
    // Same input regardless of arrival order.
    expect(a).toEqual(b);
    // All share rank 1 (competition ranking), presented by ascending id.
    expect(a).toEqual([
      { rank: 1, playerId: 3 },
      { rank: 1, playerId: 7 },
      { rank: 1, playerId: 9 },
    ]);
  });

  it('handles an empty board', () => {
    expect(assignRanks([])).toEqual([]);
  });
});

describe('rankOf', () => {
  const ranked = assignRanks(
    Array.from({ length: 30 }, (_, i) => ({ playerId: i + 1, value: 1000 - i })),
  );

  it('finds a player inside the top N', () => {
    // playerId 1 has the highest value.
    expect(rankOf(ranked, 1)).toBe(1);
  });

  it('finds a player outside a top-N page', () => {
    // playerId 30 has the lowest value → rank 30, well outside a top-10 page.
    expect(rankOf(ranked, 30)).toBe(30);
  });

  it('returns null for a player not on the board', () => {
    expect(rankOf(ranked, 9999)).toBeNull();
  });
});
