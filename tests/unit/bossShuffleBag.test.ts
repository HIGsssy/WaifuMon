/**
 * The persistent shuffle bag — exhaustion, refill, the seam repeat, and the
 * best-effort affinity spacing.
 *
 * Every draw here uses the seeded RNG, so a failure is reproducible rather
 * than "it happened once in CI".
 */
import { describe, expect, it } from 'vitest';
import {
  avoidHeadCollision,
  drawFromBag,
  emptyShuffleBagState,
  parseShuffleBagState,
  refillBag,
  shuffle,
  type ShuffleBagCandidate,
  type ShuffleBagState,
} from '../../src/modules/bosses/bossShuffleBag';
import { seededRng } from '../../src/shared/random';
import type { Affinity } from '../../src/db/schema';
import { loadShippedContent } from '../helpers/fixtures';

/** Ten candidates, two per affinity — the shipped pool's shape. */
const POOL: ShuffleBagCandidate[] = (
  ['dominant', 'submissive', 'caregiver', 'primal', 'switch'] as Affinity[]
).flatMap((affinity) => [
  { id: `${affinity}_a`, affinity },
  { id: `${affinity}_b`, affinity },
]);

/** Draw `count` bosses in sequence, threading the state as production does. */
function drawSequence(
  count: number,
  seed: number,
  candidates: ShuffleBagCandidate[] = POOL,
  initial: ShuffleBagState = emptyShuffleBagState(),
): { ids: string[]; state: ShuffleBagState; refills: number } {
  const rng = seededRng(seed);
  let state = initial;
  const ids: string[] = [];
  let refills = 0;
  for (let i = 0; i < count; i++) {
    const draw = drawFromBag(state, candidates, rng);
    if (!draw) throw new Error('bag returned nothing');
    ids.push(draw.bossId);
    if (draw.refilled) refills += 1;
    state = draw.state;
  }
  return { ids, state, refills };
}

describe('bag guarantee', () => {
  it('draws every boss exactly once before repeating any', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { ids } = drawSequence(POOL.length, seed);
      expect(new Set(ids).size).toBe(POOL.length);
    }
  });

  it('refills exactly once per bag, at the start of each', () => {
    const { refills } = drawSequence(POOL.length * 3, 7);
    expect(refills).toBe(3);
  });

  it('holds across three consecutive bags', () => {
    const { ids } = drawSequence(POOL.length * 3, 11);
    for (let bag = 0; bag < 3; bag++) {
      const slice = ids.slice(bag * POOL.length, (bag + 1) * POOL.length);
      expect(new Set(slice).size).toBe(POOL.length);
    }
  });

  it('reports how many bags have been exhausted', () => {
    const { state } = drawSequence(POOL.length * 2, 3);
    expect(state.bagsCompleted).toBe(2);
    expect(state.remaining).toHaveLength(0);
  });
});

describe('no repeat across the bag boundary', () => {
  it('never opens a bag with the boss that closed the previous one', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { ids } = drawSequence(POOL.length * 3, seed);
      // The seams are at indices 10 and 20.
      expect(ids[POOL.length]).not.toBe(ids[POOL.length - 1]);
      expect(ids[POOL.length * 2]).not.toBe(ids[POOL.length * 2 - 1]);
    }
  });

  it('rotates a colliding head to second place', () => {
    expect(avoidHeadCollision(['a', 'b', 'c'], 'a')).toEqual(['b', 'a', 'c']);
    expect(avoidHeadCollision(['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c']);
    expect(avoidHeadCollision(['a', 'b', 'c'], null)).toEqual(['a', 'b', 'c']);
  });

  it('accepts the repeat when there is only one boss to draw', () => {
    // The bag guarantee wins: a one-boss region cannot avoid repeating, and
    // refusing to draw would be worse than the repeat.
    const solo: ShuffleBagCandidate[] = [{ id: 'only', affinity: 'switch' }];
    const { ids } = drawSequence(3, 5, solo);
    expect(ids).toEqual(['only', 'only', 'only']);
  });
});

describe('affinity spacing', () => {
  it('avoids consecutive same-affinity draws whenever the bag allows it', () => {
    // With two bosses per affinity in a ten-boss bag, a repeat is only forced
    // at the very end of a bag. Allow a small budget rather than demanding
    // zero, and assert it is genuinely rare.
    let repeats = 0;
    let comparisons = 0;
    const affinityById = new Map(POOL.map((c) => [c.id, c.affinity]));
    for (let seed = 1; seed <= 30; seed++) {
      const { ids } = drawSequence(POOL.length * 2, seed);
      for (let i = 1; i < ids.length; i++) {
        comparisons += 1;
        if (affinityById.get(ids[i]!) === affinityById.get(ids[i - 1]!)) repeats += 1;
      }
    }
    // Random ordering would put this near 1 in 9 (~11%). The spacing rule must
    // do dramatically better than that.
    expect(repeats / comparisons).toBeLessThan(0.03);
  });

  it('never breaks the bag guarantee to achieve spacing', () => {
    // A pathological pool: every boss shares one affinity, so spacing is
    // impossible. The bag must still deliver each boss exactly once.
    const monotone: ShuffleBagCandidate[] = ['a', 'b', 'c'].map((id) => ({
      id,
      affinity: 'primal' as Affinity,
    }));
    const { ids } = drawSequence(3, 9, monotone);
    expect(new Set(ids).size).toBe(3);
  });

  it('flags the draw when spacing had to be sacrificed', () => {
    const monotone: ShuffleBagCandidate[] = [
      { id: 'a', affinity: 'primal' },
      { id: 'b', affinity: 'primal' },
    ];
    const rng = seededRng(2);
    const first = drawFromBag(emptyShuffleBagState(), monotone, rng)!;
    const second = drawFromBag(first.state, monotone, rng)!;
    expect(first.affinityRepeat).toBe(false);
    expect(second.affinityRepeat).toBe(true);
  });
});

describe('persistence and content drift', () => {
  it('resumes mid-bag from persisted state without rerolling', () => {
    const rng = seededRng(4);
    const partial: ShuffleBagState = {
      remaining: ['primal_a', 'switch_b', 'dominant_a'],
      lastBossId: 'caregiver_a',
      lastAffinity: 'caregiver',
      bagsCompleted: 1,
    };
    const draw = drawFromBag(partial, POOL, rng)!;
    expect(draw.bossId).toBe('primal_a');
    expect(draw.refilled).toBe(false);
    expect(draw.state.remaining).toEqual(['switch_b', 'dominant_a']);
    expect(draw.state.bagsCompleted).toBe(1);
  });

  it('drops ids that content has since disabled', () => {
    const reduced = POOL.filter((c) => c.id !== 'primal_a');
    const stale: ShuffleBagState = {
      remaining: ['primal_a', 'switch_b'],
      lastBossId: null,
      lastAffinity: null,
      bagsCompleted: 1,
    };
    const draw = drawFromBag(stale, reduced, seededRng(6))!;
    // The retired boss is skipped rather than drawn, and the bag is not
    // refilled just because one entry vanished.
    expect(draw.bossId).toBe('switch_b');
    expect(draw.refilled).toBe(false);
  });

  it('returns null when the region has no enabled bosses', () => {
    expect(drawFromBag(emptyShuffleBagState(), [], seededRng(1))).toBeNull();
  });

  it('normalizes a null, malformed or hand-edited jsonb column', () => {
    expect(parseShuffleBagState(null)).toEqual(emptyShuffleBagState());
    expect(parseShuffleBagState('nonsense')).toEqual(emptyShuffleBagState());
    expect(parseShuffleBagState({ remaining: [1, 'ok', null] })).toEqual({
      remaining: ['ok'],
      lastBossId: null,
      lastAffinity: null,
      bagsCompleted: 0,
    });
  });

  it('round-trips through JSON exactly', () => {
    const { state } = drawSequence(4, 8);
    expect(parseShuffleBagState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe('shuffle', () => {
  it('is a permutation, not a filter', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    for (let seed = 1; seed <= 20; seed++) {
      expect([...shuffle(input, seededRng(seed))].sort()).toEqual([...input].sort());
    }
  });

  it('does not mutate its input', () => {
    const input = ['a', 'b', 'c'];
    shuffle(input, seededRng(1));
    expect(input).toEqual(['a', 'b', 'c']);
  });

  it('refill advances the bag counter and fills from the candidates', () => {
    const state = refillBag(emptyShuffleBagState(), POOL, seededRng(1));
    expect(state.remaining).toHaveLength(POOL.length);
    expect(state.bagsCompleted).toBe(1);
  });
});

describe('shipped bosses feed the bag correctly', () => {
  it('the shipped pool is ten bosses, two per affinity', () => {
    const bosses = loadShippedContent().bosses.filter((b) => b.enabled);
    expect(bosses).toHaveLength(10);
    const byAffinity = new Map<string, number>();
    for (const boss of bosses) {
      byAffinity.set(boss.affinity, (byAffinity.get(boss.affinity) ?? 0) + 1);
    }
    expect([...byAffinity.entries()].sort()).toEqual([
      ['caregiver', 2],
      ['dominant', 2],
      ['primal', 2],
      ['submissive', 2],
      ['switch', 2],
    ]);
  });

  it('draws all ten shipped bosses before repeating', () => {
    const content = loadShippedContent();
    const candidates = content.bosses
      .filter((b) => b.enabled)
      .map((b) => ({ id: b.id, affinity: b.affinity }));
    const { ids } = drawSequence(candidates.length, 13, candidates);
    expect(new Set(ids)).toEqual(new Set(candidates.map((c) => c.id)));
  });
});
