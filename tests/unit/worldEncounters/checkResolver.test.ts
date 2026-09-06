/**
 * Unit tests for the world-encounter check resolver.
 *
 * Pure logic — no DB, no service graph. The whole point is that these
 * assertions cannot drift from the Discord runtime or the admin preview:
 * every SP-based encounter check runs through {@link rollCheck} or its
 * side-effect-free sibling {@link computeChance}, and the numbers here are
 * what those callers see.
 */
import { describe, expect, it } from 'vitest';
import { seededRng } from '../../../src/shared/random';
import {
  computeChance,
  rollCheck,
} from '../../../src/modules/worldEncounters/checkResolver';
import type {
  BuddyProfile,
  CheckSpec,
  EncounterCheckContext,
} from '../../../src/modules/worldEncounters/types';

function buddy(overrides: Partial<BuddyProfile> = {}): BuddyProfile {
  return {
    waifuId: 1,
    speciesSlug: 'test',
    speciesName: 'Test',
    level: 10,
    affinity: 'switch',
    baseSp: 40,
    currentSp: 60,
    rarity: 'R',
    raceTags: ['human'],
    ...overrides,
  };
}

function ctx(overrides: Partial<EncounterCheckContext> = {}): EncounterCheckContext {
  return {
    playerId: 1,
    playerLevel: 20,
    buddy: buddy(),
    buddyBonusPercent: 0,
    ...overrides,
  };
}

describe('computeChance — no-op check', () => {
  it('returns chance 1.0 for check type "none"', () => {
    const result = computeChance({ type: 'none' }, ctx());
    expect(result.chance).toBe(1);
    expect(result.success).toBe(true);
  });
});

describe('computeChance — SP check', () => {
  it('lands at ~50% when SP matches difficulty and no modifiers apply', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }) }));
    expect(result.chance).toBeCloseTo(0.5, 3);
  });

  it('rewards SP overage — buddy above difficulty', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 40 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 80, level: 1 }) }));
    // (80 - 40)/200 = 0.20 → chance ~0.70
    expect(result.chance).toBeCloseTo(0.7, 3);
  });

  it('penalises SP shortfall — buddy below difficulty', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 100 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 20, level: 1 }) }));
    // (20 - 100)/200 = -0.40 → chance 0.10
    expect(result.chance).toBeCloseTo(0.1, 3);
  });

  it('clamps SP contribution to ±0.4', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 0 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 1000, level: 1 }) }));
    // Uncapped: 5.0. Capped: +0.4 → 0.9 → also clamped to MAX 0.95.
    expect(result.chance).toBeLessThanOrEqual(0.95);
    expect(result.breakdown.spTerm).toBeCloseTo(0.4, 3);
  });

  it('clamps final chance to [0.05, 0.95]', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 500, baseBias: -0.5 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 0, level: 1 }) }));
    expect(result.chance).toBe(0.05);
  });

  it('level term adds a small linear boost, capped at 0.2', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const low = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }) }));
    const mid = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 11 }) }));
    const high = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 100 }) }));
    expect(low.breakdown.levelTerm).toBe(0);
    expect(mid.breakdown.levelTerm).toBeCloseTo(0.1, 3);
    expect(high.breakdown.levelTerm).toBe(0.2);
  });

  it('adds affinity advantage when buddy affinity matches', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60, affinityAdvantage: 'dominant' };
    const matched = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1, affinity: 'dominant' }) }));
    const mismatched = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1, affinity: 'submissive' }) }));
    expect(matched.chance - mismatched.chance).toBeCloseTo(0.15, 3);
  });

  it('adds race advantage when any tag matches', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60, raceAdvantage: ['valkyrie', 'demon'] };
    const matched = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1, raceTags: ['human', 'valkyrie'] }) }));
    const mismatched = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1, raceTags: ['human'] }) }));
    expect(matched.chance - mismatched.chance).toBeCloseTo(0.1, 3);
  });

  it('folds in buddyBonusPercent as a small additive term', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const base = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }), buddyBonusPercent: 0 }));
    const bonus = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }), buddyBonusPercent: 5 }));
    expect(bonus.chance - base.chance).toBeCloseTo(0.05, 3);
  });

  it('penalises a check with no buddy equipped', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const result = computeChance(check, ctx({ buddy: null }));
    expect(result.breakdown.spTerm).toBeCloseTo(-0.3, 3);
  });
});

describe('computeChance — new SP model (baseChance present)', () => {
  const NEUTRAL_SP = 200; // SP_NEUTRAL_REFERENCE — spModifier is 0 here
  const STRONG_SP = 350; // reaches the full +cap
  const WEAK_SP = 50; // reaches the full −cap

  it('returns baseChance exactly at neutral SP with no advantages', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: NEUTRAL_SP }) }));
    expect(result.chance).toBeCloseTo(0.4, 6);
    expect(result.breakdown.base).toBe(0.4);
    expect(result.breakdown.spTerm).toBeCloseTo(0, 6);
    // The new model never uses a separate level term or baseBias.
    expect(result.breakdown.levelTerm).toBe(0);
    expect(result.breakdown.baseBias).toBe(0);
  });

  it('a weak buddy produces a negative bounded SP modifier', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: WEAK_SP }) }));
    expect(result.breakdown.spTerm).toBeCloseTo(-0.15, 6);
    expect(result.chance).toBeCloseTo(0.25, 6);
  });

  it('a strong buddy produces a positive bounded SP modifier', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: STRONG_SP }) }));
    expect(result.breakdown.spTerm).toBeCloseTo(0.15, 6);
    expect(result.chance).toBeCloseTo(0.55, 6);
  });

  it('caps the SP modifier at the configured maximum however high SP goes', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4, maxSpModifier: 0.15 };
    const huge = computeChance(check, ctx({ buddy: buddy({ currentSp: 9999 }) }));
    expect(huge.breakdown.spTerm).toBeCloseTo(0.15, 6);
    const tiny = computeChance(check, ctx({ buddy: buddy({ currentSp: 0 }) }));
    expect(tiny.breakdown.spTerm).toBeCloseTo(-0.15, 6);
  });

  it('honours a custom maxSpModifier', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4, maxSpModifier: 0.05 };
    const strong = computeChance(check, ctx({ buddy: buddy({ currentSp: STRONG_SP }) }));
    expect(strong.breakdown.spTerm).toBeCloseTo(0.05, 6);
  });

  it('defaults maxSpModifier to 0.15 when omitted', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const strong = computeChance(check, ctx({ buddy: buddy({ currentSp: STRONG_SP }) }));
    expect(strong.breakdown.spTerm).toBeCloseTo(0.15, 6);
  });

  it('applies affinity advantage on top of base + SP', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4, affinityAdvantage: 'dominant' };
    const matched = computeChance(
      check,
      ctx({ buddy: buddy({ currentSp: NEUTRAL_SP, affinity: 'dominant' }) }),
    );
    expect(matched.chance).toBeCloseTo(0.55, 6);
    expect(matched.breakdown.affinityMod).toBeCloseTo(0.15, 6);
  });

  it('applies race advantage when any listed tag matches, and stacks with affinity', () => {
    const check: CheckSpec = {
      type: 'sp',
      baseChance: 0.4,
      affinityAdvantage: 'dominant',
      raceAdvantage: ['demon', 'valkyrie'],
    };
    const ideal = computeChance(
      check,
      ctx({
        buddy: buddy({ currentSp: STRONG_SP, affinity: 'dominant', raceTags: ['valkyrie'] }),
      }),
    );
    // 0.40 base + 0.15 sp + 0.15 affinity + 0.10 race = 0.80
    expect(ideal.chance).toBeCloseTo(0.8, 6);
  });

  it('does not stack race advantage when a buddy matches several listed tags', () => {
    const oneTag: CheckSpec = { type: 'sp', baseChance: 0.4, raceAdvantage: ['demon'] };
    const twoTags: CheckSpec = { type: 'sp', baseChance: 0.4, raceAdvantage: ['demon', 'valkyrie'] };
    const b = buddy({ currentSp: NEUTRAL_SP, raceTags: ['demon', 'valkyrie'] });
    const a = computeChance(oneTag, ctx({ buddy: b }));
    const c = computeChance(twoTags, ctx({ buddy: b }));
    expect(a.breakdown.raceMod).toBeCloseTo(0.1, 6);
    expect(c.breakdown.raceMod).toBeCloseTo(0.1, 6); // matching two tags still adds 0.10 once
  });

  it('folds a Buddy Bonus in exactly once', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const base = computeChance(check, ctx({ buddy: buddy({ currentSp: NEUTRAL_SP }), buddyBonusPercent: 0 }));
    const bonus = computeChance(check, ctx({ buddy: buddy({ currentSp: NEUTRAL_SP }), buddyBonusPercent: 10 }));
    expect(bonus.chance - base.chance).toBeCloseTo(0.1, 6);
    expect(bonus.breakdown.buddyBonusMod).toBeCloseTo(0.1, 6);
  });

  it('pays the full negative SP cap when no buddy is equipped', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.4, maxSpModifier: 0.15 };
    const result = computeChance(check, ctx({ buddy: null }));
    expect(result.breakdown.spTerm).toBeCloseTo(-0.15, 6);
    expect(result.chance).toBeCloseTo(0.25, 6);
  });

  it('clamps to the 5% floor for a hard check even against a mismatched buddy', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.1 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: WEAK_SP }) }));
    // 0.10 − 0.15 = −0.05 → clamped up to the 0.05 floor.
    expect(result.chance).toBe(0.05);
  });

  it('clamps to the 95% ceiling for an easy check with ideal advantages', () => {
    const check: CheckSpec = {
      type: 'sp',
      baseChance: 0.85,
      affinityAdvantage: 'dominant',
      raceAdvantage: ['valkyrie'],
    };
    const result = computeChance(
      check,
      ctx({ buddy: buddy({ currentSp: STRONG_SP, affinity: 'dominant', raceTags: ['valkyrie'] }) }),
    );
    // 0.85 + 0.15 + 0.15 + 0.10 = 1.25 → clamped to 0.95.
    expect(result.chance).toBe(0.95);
  });

  it('a very high-SP buddy does NOT automatically max out an ordinary new-model check', () => {
    // The core design goal: a moderate encounter stays risky no matter the SP.
    const check: CheckSpec = { type: 'sp', baseChance: 0.4 };
    const godlike = computeChance(check, ctx({ buddy: buddy({ currentSp: 99_999 }) }));
    // Base + full SP cap only = 0.55, well short of the 0.95 ceiling.
    expect(godlike.chance).toBeCloseTo(0.55, 6);
    expect(godlike.chance).toBeLessThan(0.95);
  });

  it('a deliberately hard check stays risky even for a strong, matched buddy', () => {
    const check: CheckSpec = { type: 'sp', baseChance: 0.25, affinityAdvantage: 'dominant' };
    const result = computeChance(
      check,
      ctx({ buddy: buddy({ currentSp: STRONG_SP, affinity: 'dominant' }) }),
    );
    // 0.25 + 0.15 + 0.15 = 0.55 — meaningfully below certainty.
    expect(result.chance).toBeCloseTo(0.55, 6);
    expect(result.chance).toBeLessThan(0.7);
  });
});

describe('computeChance — legacy model is untouched by the new fields', () => {
  it('still centres on 50% when SP matches difficulty', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const result = computeChance(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }) }));
    expect(result.chance).toBeCloseTo(0.5, 6);
    expect(result.breakdown.base).toBe(0.5);
  });

  it('produces the same numbers as before this change for a representative legacy check', () => {
    // difficulty 70, dominant advantage, valkyrie race, mid buddy — a shipped
    // seed shape. Locks the legacy formula against accidental drift.
    const check: CheckSpec = {
      type: 'sp',
      difficulty: 70,
      affinityAdvantage: 'dominant',
      raceAdvantage: ['valkyrie'],
    };
    const result = computeChance(
      check,
      ctx({
        buddy: buddy({ currentSp: 150, level: 20, affinity: 'dominant', raceTags: ['valkyrie'] }),
      }),
    );
    // base 0.5 + sp (150-70)/200=0.4 + level (20-1)/100=0.19 + aff 0.15 + race 0.10 = 1.34 → 0.95
    expect(result.chance).toBe(0.95);
    expect(result.breakdown.spTerm).toBeCloseTo(0.4, 6);
    expect(result.breakdown.levelTerm).toBeCloseTo(0.19, 6);
  });
});

describe('rollCheck', () => {
  it('is deterministic given a seeded RNG', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const rngA = seededRng(1234);
    const rngB = seededRng(1234);
    const a = rollCheck(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }) }), rngA);
    const b = rollCheck(check, ctx({ buddy: buddy({ currentSp: 60, level: 1 }) }), rngB);
    expect(a.success).toBe(b.success);
    expect(a.roll).toBe(b.roll);
  });

  it('always succeeds on type "none"', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 20; i++) {
      expect(rollCheck({ type: 'none' }, ctx(), rng).success).toBe(true);
    }
  });

  it('produces an expected success rate close to computeChance across many rolls', () => {
    const check: CheckSpec = { type: 'sp', difficulty: 60 };
    const c = ctx({ buddy: buddy({ currentSp: 80, level: 1 }) });
    const expected = computeChance(check, c).chance;
    const rng = seededRng(999);
    let successes = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (rollCheck(check, c, rng).success) successes++;
    const observed = successes / N;
    expect(Math.abs(observed - expected)).toBeLessThan(0.03);
  });
});
