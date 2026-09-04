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
