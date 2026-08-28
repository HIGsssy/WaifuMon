/**
 * Boss battle damage — the formula, its rounding, and the rapid-response
 * bracket boundaries.
 *
 * The worked example from the specification is pinned first and literally:
 * a 200 SP buddy with both bonuses must quote 1,955–2,645. Everything else
 * here exists to stop that example from being right by coincidence.
 */
import { describe, expect, it } from 'vitest';
import {
  BOSS_DAMAGE_FORMULA_VERSION,
  DEFAULT_ATTACKS_PER_PARTICIPATION,
  DEFAULT_PERFORMANCE_MAX_PERCENT,
  DEFAULT_PERFORMANCE_MIN_PERCENT,
  DEFAULT_RESPONSE_BRACKETS,
  computeBattleDamage,
  estimateDamageRange,
  formatBonusPercent,
  formatDamage,
  responseBonusFor,
} from '../../src/modules/bosses/bossDamage';

const MINUTE = 60_000;
const START = new Date('2026-08-26T12:00:00.000Z');
const at = (ms: number) => new Date(START.getTime() + ms);

describe('the specification example', () => {
  const base = {
    currentSp: 200,
    attacks: 10,
    affinityBonus: 0.1,
    responseBonus: 0.05,
  };

  it('quotes 1,955 at the low end of the performance range', () => {
    expect(computeBattleDamage({ ...base, performancePercent: 85 })).toBe(1955);
  });

  it('quotes 2,645 at the high end', () => {
    expect(computeBattleDamage({ ...base, performancePercent: 115 })).toBe(2645);
  });

  it('is exactly the range the preview shows', () => {
    expect(estimateDamageRange(base)).toEqual({ min: 1955, max: 2645 });
  });
});

describe('damage formula', () => {
  it('multiplies Current SP by the attack count with no bonuses', () => {
    expect(
      computeBattleDamage({
        currentSp: 100,
        attacks: 10,
        performancePercent: 100,
        affinityBonus: 0,
        responseBonus: 0,
      }),
    ).toBe(1000);
  });

  it('adds the percentage bonuses to each other before applying them', () => {
    // ×1.15 once, not ×1.10 then ×1.05 (which would be 1155).
    expect(
      computeBattleDamage({
        currentSp: 100,
        attacks: 10,
        performancePercent: 100,
        affinityBonus: 0.1,
        responseBonus: 0.05,
      }),
    ).toBe(1150);
  });

  it('reaches both performance endpoints exactly', () => {
    const flat = { currentSp: 100, attacks: 10, affinityBonus: 0, responseBonus: 0 };
    expect(computeBattleDamage({ ...flat, performancePercent: 85 })).toBe(850);
    expect(computeBattleDamage({ ...flat, performancePercent: 115 })).toBe(1150);
  });

  it('rounds an exact half up rather than letting float error floor it', () => {
    // 1 SP × 1 attack × 85% × 1.0 = 0.85 → 1. And the case the integer form
    // exists for: a numerator that lands on a true .5 must round up.
    expect(
      computeBattleDamage({
        currentSp: 1,
        attacks: 1,
        performancePercent: 85,
        affinityBonus: 0,
        responseBonus: 0,
      }),
    ).toBe(1);
    // 5 × 1 × 110% × 1.0 = 5.5 → 6.
    expect(
      computeBattleDamage({
        currentSp: 5,
        attacks: 1,
        performancePercent: 110,
        affinityBonus: 0,
        responseBonus: 0,
      }),
    ).toBe(6);
  });

  it('agrees with the naive float expression everywhere it is unambiguous', () => {
    // A sweep: wherever the true value is not an exact half, the integer form
    // and the float form must agree. Where it *is* a half, the integer form is
    // the authority — see the rounding test above.
    for (let sp = 90; sp <= 400; sp += 7) {
      for (const perf of [85, 92, 100, 107, 115]) {
        for (const [aff, resp] of [
          [0, 0],
          [0.1, 0],
          [0, 0.05],
          [0.1, 0.02],
          [0.1, 0.05],
        ] as const) {
          const exact = (sp * 10 * perf * (10000 + aff * 10000 + resp * 10000)) / 1_000_000;
          const actual = computeBattleDamage({
            currentSp: sp,
            attacks: 10,
            performancePercent: perf,
            affinityBonus: aff,
            responseBonus: resp,
          });
          expect(Math.abs(actual - exact)).toBeLessThanOrEqual(0.5);
        }
      }
    }
  });

  it('is monotone in Current SP and in the performance modifier', () => {
    const shared = { attacks: 10, affinityBonus: 0.1, responseBonus: 0.02 };
    let previous = 0;
    for (let sp = 50; sp <= 500; sp += 25) {
      const value = computeBattleDamage({ ...shared, currentSp: sp, performancePercent: 100 });
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
    previous = 0;
    for (let perf = 85; perf <= 115; perf++) {
      const value = computeBattleDamage({ ...shared, currentSp: 200, performancePercent: perf });
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('rejects a non-integer Current SP rather than silently rounding it', () => {
    expect(() =>
      computeBattleDamage({
        currentSp: 100.5,
        attacks: 10,
        performancePercent: 100,
        affinityBonus: 0,
        responseBonus: 0,
      }),
    ).toThrow(RangeError);
  });

  it('pins the shipped constants and the formula version', () => {
    expect(BOSS_DAMAGE_FORMULA_VERSION).toBe(1);
    expect(DEFAULT_ATTACKS_PER_PARTICIPATION).toBe(10);
    expect(DEFAULT_PERFORMANCE_MIN_PERCENT).toBe(85);
    expect(DEFAULT_PERFORMANCE_MAX_PERCENT).toBe(115);
  });
});

describe('rapid-response brackets', () => {
  /** `m:ss` as milliseconds elapsed — the boundaries are read off a clock. */
  const elapsed = (minutes: number, seconds = 0, millis = 0) =>
    minutes * MINUTE + seconds * 1000 + millis;

  it('pays +5% for a commitment inside the first ten minutes', () => {
    expect(responseBonusFor(START, at(0))).toBe(0.05);
    expect(responseBonusFor(START, at(elapsed(9)))).toBe(0.05);
    expect(responseBonusFor(START, at(elapsed(9, 59)))).toBe(0.05);
    expect(responseBonusFor(START, at(elapsed(9, 59, 999)))).toBe(0.05);
  });

  it('drops to +2% at exactly ten minutes — the boundary is strict', () => {
    expect(responseBonusFor(START, at(elapsed(10)))).toBe(0.02);
    expect(responseBonusFor(START, at(elapsed(10, 0, 1)))).toBe(0.02);
    expect(responseBonusFor(START, at(elapsed(19)))).toBe(0.02);
    expect(responseBonusFor(START, at(elapsed(19, 59)))).toBe(0.02);
    expect(responseBonusFor(START, at(elapsed(19, 59, 999)))).toBe(0.02);
  });

  it('pays nothing from exactly twenty minutes to the deadline', () => {
    expect(responseBonusFor(START, at(elapsed(20)))).toBe(0);
    expect(responseBonusFor(START, at(elapsed(25)))).toBe(0);
    expect(responseBonusFor(START, at(elapsed(29, 59)))).toBe(0);
    expect(responseBonusFor(START, at(elapsed(29, 59, 999)))).toBe(0);
    // The deadline itself. Commitment is refused at this point (see the
    // encounter-service tests); the bracket is zero either way.
    expect(responseBonusFor(START, at(elapsed(30)))).toBe(0);
  });

  it.each([
    ['9:59', elapsed(9, 59), 0.05],
    ['10:00', elapsed(10), 0.02],
    ['19:59', elapsed(19, 59), 0.02],
    ['20:00', elapsed(20), 0],
    ['29:59', elapsed(29, 59), 0],
    ['30:00 (deadline)', elapsed(30), 0],
  ])('at %s the bonus is %d', (_label, ms, expected) => {
    expect(responseBonusFor(START, at(ms))).toBe(expected);
  });

  it('treats a commitment before the start as elapsed zero', () => {
    // Clock skew between two bot processes must not produce a negative elapsed
    // time and fall through every bracket.
    expect(responseBonusFor(START, at(-5 * MINUTE))).toBe(0.05);
  });

  it('honours retuned brackets', () => {
    const custom = [
      { withinMinutes: 5, bonus: 0.2 },
      { withinMinutes: 10, bonus: 0.1 },
    ];
    expect(responseBonusFor(START, at(1 * MINUTE), custom)).toBe(0.2);
    expect(responseBonusFor(START, at(7 * MINUTE), custom)).toBe(0.1);
    expect(responseBonusFor(START, at(11 * MINUTE), custom)).toBe(0);
  });

  it('ships the two documented tiers, sized to the 30-minute window', () => {
    expect(DEFAULT_RESPONSE_BRACKETS).toEqual([
      { withinMinutes: 10, bonus: 0.05 },
      { withinMinutes: 20, bonus: 0.02 },
    ]);
  });
});

describe('formatting', () => {
  it('trims trailing zeros from bonus percentages', () => {
    expect(formatBonusPercent(0.1)).toBe('+10%');
    expect(formatBonusPercent(0.05)).toBe('+5%');
    expect(formatBonusPercent(0.02)).toBe('+2%');
    expect(formatBonusPercent(0)).toBe('+0%');
    expect(formatBonusPercent(0.025)).toBe('+2.5%');
  });

  it('groups damage numbers', () => {
    expect(formatDamage(17342)).toBe('17,342');
    expect(formatDamage(999)).toBe('999');
  });
});
