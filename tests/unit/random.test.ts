/**
 * Weighted-roll and seeded-RNG behavior. Pure logic — no DB.
 */
import { describe, expect, it } from 'vitest';
import { rollWeighted, seededRng, type WeightedEntry } from '../../src/shared/random';

describe('seededRng', () => {
  it('is deterministic for a given seed', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const r = seededRng(1);
    for (let i = 0; i < 200; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('intInclusive covers the closed range and stays inside it', () => {
    const r = seededRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const v = r.intInclusive(1, 5);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3, 4, 5]));
  });
});

describe('rollWeighted', () => {
  it('respects the requested distribution within tolerance', () => {
    const rng = seededRng(12345);
    const entries: WeightedEntry<string>[] = [
      { weight: 70, value: 'encounter' },
      { weight: 12, value: 'item' },
      { weight: 8, value: 'wb' },
      { weight: 5, value: 'ess' },
      { weight: 3, value: 'rare' },
      { weight: 2, value: 'flavor' },
    ];
    const N = 20_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const v = rollWeighted(entries, rng);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const expected: Record<string, number> = {
      encounter: 0.7,
      item: 0.12,
      wb: 0.08,
      ess: 0.05,
      rare: 0.03,
      flavor: 0.02,
    };
    for (const [k, want] of Object.entries(expected)) {
      const got = (counts.get(k) ?? 0) / N;
      // Loose tolerance for a small PRNG at 20k samples.
      expect(Math.abs(got - want)).toBeLessThan(0.02);
    }
  });

  it('never picks a zero-weight entry', () => {
    const rng = seededRng(99);
    const entries: WeightedEntry<string>[] = [
      { weight: 0, value: 'never' },
      { weight: 1, value: 'always' },
    ];
    for (let i = 0; i < 500; i++) {
      expect(rollWeighted(entries, rng)).toBe('always');
    }
  });

  it('rejects empty input and non-positive total weight', () => {
    const rng = seededRng(1);
    expect(() => rollWeighted([], rng)).toThrow(RangeError);
    expect(() =>
      rollWeighted([{ weight: 0, value: 'a' } as WeightedEntry<string>], rng),
    ).toThrow(RangeError);
  });
});
