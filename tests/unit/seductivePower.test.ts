/**
 * Seductive Power — the pure domain module. No DB, no I/O.
 *
 * These tests pin the two things that must never drift: the rarity ladder, and
 * the rounding. Both are consumed by the API, the inspect embed, the trainer
 * profile and (later) combat, so a change here is a change everywhere.
 */
import { describe, expect, it } from 'vitest';
import { RARITIES } from '../../src/db/schema';
import {
  currentSeductivePower,
  DEFAULT_SP_RANGES_BY_RARITY,
  formatSeductivePower,
  InvalidLevelError,
  isValidBaseSeductivePower,
  rangeForRarity,
  rollBaseSeductivePower,
  seductivePowerView,
  SP_FORMULA_VERSION,
  SP_LEVEL_SCALAR,
  UnknownRarityError,
} from '../../src/modules/power/seductivePower';
import { loadShippedContent } from '../helpers/fixtures';

/** An Rng that returns a fixed point of the requested inclusive range. */
function pinnedRng(pick: 'min' | 'max' | 'mid') {
  return {
    intInclusive(min: number, max: number) {
      if (pick === 'min') return min;
      if (pick === 'max') return max;
      return Math.floor((min + max) / 2);
    },
  };
}

/** The uniform mapping `Rng.intInclusive` performs, driven by a raw fraction. */
function fractionRng(fraction: number) {
  return {
    intInclusive(min: number, max: number) {
      return Math.floor(fraction * (max - min + 1)) + min;
    },
  };
}

// ──────────────────────────── the rarity ladder ──────────────────────────

describe('rarity ranges', () => {
  it.each([
    ['N', 90, 100],
    ['R', 105, 115],
    ['SR', 120, 130],
    ['SSR', 135, 145],
    ['UR', 150, 160],
    ['LR', 165, 175],
    ['EX', 180, 190],
  ])('%s spans %i-%i inclusive', (rarity, min, max) => {
    expect(rangeForRarity(rarity as string)).toEqual({ min, max });
  });

  it('covers every rarity the database recognises — EX included', () => {
    for (const rarity of RARITIES) {
      expect(() => rangeForRarity(rarity)).not.toThrow();
    }
    expect(Object.keys(DEFAULT_SP_RANGES_BY_RARITY).sort()).toEqual([...RARITIES].sort());
  });

  it('throws on a rarity the ladder does not define, rather than substituting', () => {
    expect(() => rangeForRarity('SSS')).toThrow(UnknownRarityError);
    expect(() => rangeForRarity('')).toThrow(UnknownRarityError);
    // Never quietly answers with a neighbour's band.
    expect(() => rollBaseSeductivePower('SSS', pinnedRng('min'))).toThrow(UnknownRarityError);
  });

  it('is the same table the shipped content carries', () => {
    // Content is the tunable copy; the constant is the schema's default. If
    // these two ever disagree, a re-tune has silently half-landed.
    const content = loadShippedContent();
    expect(content.tables.seductivePower.rangesByRarity).toEqual(DEFAULT_SP_RANGES_BY_RARITY);
  });
});

// ───────────────────────────── rolling Base SP ───────────────────────────

describe('rollBaseSeductivePower', () => {
  it.each(RARITIES)('rolls the inclusive minimum for %s', (rarity) => {
    const { min } = rangeForRarity(rarity);
    expect(rollBaseSeductivePower(rarity, pinnedRng('min'))).toBe(min);
  });

  it.each(RARITIES)('rolls the inclusive maximum for %s', (rarity) => {
    const { max } = rangeForRarity(rarity);
    expect(rollBaseSeductivePower(rarity, pinnedRng('max'))).toBe(max);
  });

  it('maps a uniform fraction onto every integer in the range, none skipped', () => {
    for (const rarity of RARITIES) {
      const { min, max } = rangeForRarity(rarity);
      const span = max - min + 1;
      const seen = new Set<number>();
      // Sample the middle of each of the `span` equal buckets — the mapping is
      // uniform exactly when that lands on each integer once.
      for (let i = 0; i < span; i++) {
        seen.add(rollBaseSeductivePower(rarity, fractionRng((i + 0.5) / span)));
      }
      expect([...seen].sort((a, b) => a - b)).toEqual(
        Array.from({ length: span }, (_, i) => min + i),
      );
    }
  });

  it('never rolls outside the band for any fraction in [0, 1)', () => {
    for (const rarity of RARITIES) {
      const { min, max } = rangeForRarity(rarity);
      for (let i = 0; i < 1000; i++) {
        const value = rollBaseSeductivePower(rarity, fractionRng(i / 1000));
        expect(value).toBeGreaterThanOrEqual(min);
        expect(value).toBeLessThanOrEqual(max);
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it('honours a re-tuned range from content rather than the constant', () => {
    const retuned = { ...DEFAULT_SP_RANGES_BY_RARITY, N: { min: 200, max: 200 } };
    expect(rollBaseSeductivePower('N', pinnedRng('min'), retuned)).toBe(200);
    expect(rollBaseSeductivePower('N', pinnedRng('max'), retuned)).toBe(200);
  });
});

describe('isValidBaseSeductivePower', () => {
  it('accepts the endpoints and rejects just outside them', () => {
    expect(isValidBaseSeductivePower(90, 'N')).toBe(true);
    expect(isValidBaseSeductivePower(100, 'N')).toBe(true);
    expect(isValidBaseSeductivePower(89, 'N')).toBe(false);
    expect(isValidBaseSeductivePower(101, 'N')).toBe(false);
    expect(isValidBaseSeductivePower(95.5, 'N')).toBe(false);
  });
});

// ──────────────────────────── the Current SP formula ─────────────────────

describe('currentSeductivePower', () => {
  it('is the identity at level 1 for every band endpoint', () => {
    for (const rarity of RARITIES) {
      const { min, max } = rangeForRarity(rarity);
      expect(currentSeductivePower(min, 1)).toBe(min);
      expect(currentSeductivePower(max, 1)).toBe(max);
    }
  });

  // The spec's boundary table, verbatim. Two of these (100 and 180) land on an
  // exact .5 and are the reason the rounding must be half-up.
  it.each([
    [90, 1, 90],
    [100, 1, 100],
    [90, 50, 200],
    [100, 50, 223],
    [105, 50, 234],
    [115, 50, 256],
    [120, 50, 267],
    [130, 50, 289],
    [135, 50, 300],
    [145, 50, 323],
    [150, 50, 334],
    [160, 50, 356],
    [165, 50, 367],
    [175, 50, 389],
    [180, 50, 401],
    [190, 50, 423],
  ])('base %i at level %i is %i SP', (base, level, expected) => {
    expect(currentSeductivePower(base, level)).toBe(expected);
  });

  it('rounds exact halves up, not to even', () => {
    // 100 x 2.225 = 222.5 and 180 x 2.225 = 400.5. Banker's rounding would
    // give 222 and 400; the spec's table requires 223 and 401.
    expect(currentSeductivePower(100, 50)).toBe(223);
    expect(currentSeductivePower(180, 50)).toBe(401);
  });

  it('grows by 2.5% of base per level, additively from level 1', () => {
    expect(SP_LEVEL_SCALAR).toBe(0.025);
    // A base of 40 makes each step exactly 1 SP, so the ladder is checkable
    // without any rounding ambiguity at all.
    for (let level = 1; level <= 50; level++) {
      expect(currentSeductivePower(40, level)).toBe(40 + (level - 1));
    }
  });

  it.each([
    [100, 2, 103],
    [100, 10, 123],
    [100, 25, 160],
    [123, 17, 172],
    [147, 33, 265],
    [190, 49, 418],
  ])('rounds intermediate level %2$i correctly for base %1$i', (base, level, expected) => {
    expect(currentSeductivePower(base, level)).toBe(expected);
  });

  it('rejects invalid levels instead of clamping them', () => {
    expect(() => currentSeductivePower(100, 0)).toThrow(InvalidLevelError);
    expect(() => currentSeductivePower(100, -3)).toThrow(InvalidLevelError);
    expect(() => currentSeductivePower(100, 1.5)).toThrow(InvalidLevelError);
    expect(() => currentSeductivePower(100, Number.NaN)).toThrow(InvalidLevelError);
  });

  it('rejects a level above the supplied ceiling, and accepts the ceiling itself', () => {
    expect(() => currentSeductivePower(100, 51, 50)).toThrow(InvalidLevelError);
    expect(currentSeductivePower(100, 50, 50)).toBe(223);
    // With no ceiling supplied the domain has no opinion — that is the caller's.
    expect(currentSeductivePower(100, 51)).toBe(225);
  });

  it('rejects a nonsensical base', () => {
    expect(() => currentSeductivePower(0, 1)).toThrow(RangeError);
    expect(() => currentSeductivePower(-5, 1)).toThrow(RangeError);
    expect(() => currentSeductivePower(90.5, 1)).toThrow(RangeError);
  });

  it('agrees with the max-level ceiling the shipped content configures', () => {
    const content = loadShippedContent();
    const maxLevel = content.tables.waifuProgression.maxLevel;
    expect(maxLevel).toBe(50);
    expect(() => currentSeductivePower(100, maxLevel, maxLevel)).not.toThrow();
    expect(() => currentSeductivePower(100, maxLevel + 1, maxLevel)).toThrow(InvalidLevelError);
  });
});

describe('seductivePowerView', () => {
  it('bundles base, current and the formula version', () => {
    expect(seductivePowerView(120, 50)).toEqual({
      base: 120,
      current: 267,
      formulaVersion: SP_FORMULA_VERSION,
    });
  });

  it('leaves base untouched as the level climbs — only current moves', () => {
    const levels = [1, 10, 25, 50];
    const views = levels.map((level) => seductivePowerView(137, level));
    expect(views.map((v) => v.base)).toEqual([137, 137, 137, 137]);
    expect(new Set(views.map((v) => v.current)).size).toBe(levels.length);
  });
});

describe('formatSeductivePower', () => {
  it('renders the canonical player-facing line', () => {
    expect(formatSeductivePower(216)).toBe('Seductive Power: 216 SP');
  });
});
