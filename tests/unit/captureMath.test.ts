import { describe, expect, it } from 'vitest';
import {
  clamp,
  computeCaptureChance,
  describeCaptureChance,
  rarityAtLeast,
  RARITY_RANK,
  type CaptureConfig,
} from '../../src/modules/capture/captureMath';
import type { Rarity } from '../../src/db/schema';

const config: CaptureConfig = {
  baseRatesByRarity: { N: 0.5, R: 0.35, SR: 0.22, SSR: 0.12, UR: 0.06, LR: 0.03, EX: 0.03 },
  minChance: 0.02,
  maxChance: 0.95,
  announceMinRarity: 'SSR',
  hereMentionMinRarity: 'UR',
};

describe('computeCaptureChance', () => {
  it('uses base × modifier when not guaranteed', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'R',
        captureModifier: 1.5,
        config,
      }),
    ).toBeCloseTo(0.525, 5);
  });

  it('honors species-level baseCaptureRate override', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.9,
        rarity: 'LR', // rarity is ignored when override is set
        captureModifier: 1,
        config,
      }),
    ).toBeCloseTo(0.9, 5);
  });

  it('clamps below the floor', () => {
    // LR (0.03) × Basic (1.0) = 0.03 — inside the [0.02, 0.95] band.
    // Push it lower to trip the floor.
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.001,
        rarity: 'LR',
        captureModifier: 1,
        config,
      }),
    ).toBe(config.minChance);
  });

  it('clamps above the ceiling', () => {
    // N (0.5) × Prismatic (4.0) = 2.0 → clamped to 0.95.
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'N',
        captureModifier: 4,
        config,
      }),
    ).toBe(config.maxChance);
  });

  it('Mythic Contract bypasses the formula entirely', () => {
    expect(
      computeCaptureChance({
        guaranteed: true,
        // These inputs would clamp to 0.02 non-guaranteed, but guaranteed = 1.0.
        baseCaptureRate: 0.0001,
        rarity: 'LR',
        captureModifier: null,
        config,
      }),
    ).toBe(1);
  });

  it('defaults captureModifier to 1 when null and not guaranteed', () => {
    // Mythic-like odd case where item has no modifier and is not guaranteed —
    // treat as 1× so we don't accidentally kill the odds.
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'SSR',
        captureModifier: null,
        config,
      }),
    ).toBeCloseTo(0.12, 5);
  });

  it('table of (rarity × charm) → clamped chance', () => {
    const modifiers: Record<string, number> = { basic: 1, silk: 1.5, velvet: 2.25, prismatic: 4 };
    const rarities: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR', 'LR'];
    for (const r of rarities) {
      for (const [, m] of Object.entries(modifiers)) {
        const c = computeCaptureChance({
          guaranteed: false,
          baseCaptureRate: null,
          rarity: r,
          captureModifier: m,
          config,
        });
        expect(c).toBeGreaterThanOrEqual(config.minChance);
        expect(c).toBeLessThanOrEqual(config.maxChance);
      }
    }
  });
});

describe('computeCaptureChance — buddy affinity modifier (5D)', () => {
  it('applies the charm multiplier first, then the flat buddy bonus', () => {
    // R base 0.35 × Silk 1.5 = 0.525, then +0.04 → 0.565.
    // (If the bonus were added before the multiplier it would be 0.585.)
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'R',
        captureModifier: 1.5,
        config,
        buddyAffinityModifier: 0.04,
      }),
    ).toBeCloseTo(0.565, 10);
  });

  it('defaults to no modifier when the field is omitted', () => {
    const withoutField = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
    });
    const withZero = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
      buddyAffinityModifier: 0,
    });
    expect(withoutField).toBeCloseTo(0.22, 10);
    expect(withZero).toBe(withoutField);
  });

  it('still clamps to the ceiling with a bonus applied', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.94,
        rarity: 'N',
        captureModifier: 1,
        config,
        buddyAffinityModifier: 0.06,
      }),
    ).toBe(config.maxChance);
  });

  it('still clamps to the floor with a (hypothetical) penalty applied', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.03,
        rarity: 'LR',
        captureModifier: 1,
        config,
        buddyAffinityModifier: -0.02,
      }),
    ).toBe(config.minChance);
  });

  it('a guaranteed capture ignores the buddy bonus entirely', () => {
    expect(
      computeCaptureChance({
        guaranteed: true,
        baseCaptureRate: null,
        rarity: 'LR',
        captureModifier: null,
        config,
        buddyAffinityModifier: 0.06,
      }),
    ).toBe(1);
  });
});

describe('capture bonus modifier (Microdose)', () => {
  it('adds after the charm multiplier, not before it', () => {
    // R (0.35) × Silk (1.5) = 0.525, then +0.03 → 0.555.
    // Multiplying first would give (0.35 + 0.03) × 1.5 = 0.57.
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'R',
        captureModifier: 1.5,
        config,
        captureBonusModifier: 0.03,
      }),
    ).toBeCloseTo(0.555, 5);
  });

  it('stacks additively alongside the buddy affinity term', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'SR', // 0.22
        captureModifier: 1,
        config,
        buddyAffinityModifier: 0.04,
        captureBonusModifier: 0.03,
      }),
    ).toBeCloseTo(0.29, 5);
  });

  it('is applied before the clamp, never past the ceiling', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.94,
        rarity: 'N',
        captureModifier: 1,
        config,
        captureBonusModifier: 0.03,
      }),
    ).toBe(config.maxChance);
  });

  it('is ignored entirely on a guaranteed capture', () => {
    expect(
      computeCaptureChance({
        guaranteed: true,
        baseCaptureRate: null,
        rarity: 'LR',
        captureModifier: null,
        config,
        captureBonusModifier: 0.03,
      }),
    ).toBe(1);
  });

  it('defaults to no bonus when omitted', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: null,
        rarity: 'R',
        captureModifier: 1,
        config,
      }),
    ).toBeCloseTo(0.35, 5);
  });
});

describe('clamp', () => {
  it('clamps as expected', () => {
    expect(clamp(0.5, 0.1, 0.9)).toBe(0.5);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });
});

describe('rarity ordering', () => {
  it('ranks the ladder in the expected order', () => {
    expect(RARITY_RANK.N).toBeLessThan(RARITY_RANK.R);
    expect(RARITY_RANK.R).toBeLessThan(RARITY_RANK.SR);
    expect(RARITY_RANK.SR).toBeLessThan(RARITY_RANK.SSR);
    expect(RARITY_RANK.SSR).toBeLessThan(RARITY_RANK.UR);
    expect(RARITY_RANK.UR).toBeLessThan(RARITY_RANK.LR);
    expect(RARITY_RANK.LR).toBeLessThan(RARITY_RANK.EX);
  });

  it('rarityAtLeast matches the announcement / @here rules', () => {
    // Announce threshold = SSR: SSR/UR/LR/EX qualify.
    expect(rarityAtLeast('SR', 'SSR')).toBe(false);
    expect(rarityAtLeast('SSR', 'SSR')).toBe(true);
    expect(rarityAtLeast('LR', 'SSR')).toBe(true);
    // @here threshold = UR: SSR doesn't @here, UR+ does.
    expect(rarityAtLeast('SSR', 'UR')).toBe(false);
    expect(rarityAtLeast('UR', 'UR')).toBe(true);
    expect(rarityAtLeast('LR', 'UR')).toBe(true);
    expect(rarityAtLeast('EX', 'UR')).toBe(true);
  });
});

describe('Buddy Bonus capture term', () => {
  it('scales the assembled chance relatively, not in percentage points', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.5,
        rarity: 'N',
        captureModifier: 1,
        config,
        buddyBonusPercent: 10,
      }),
    ).toBeCloseTo(0.55, 6);
  });

  it('scales the whole chance, additive terms included', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.4,
        rarity: 'N',
        captureModifier: 1,
        config,
        buddyAffinityModifier: 0.1,
        buddyBonusPercent: 100,
      }),
    ).toBeCloseTo(0.95, 6); // (0.4 + 0.1) × 2, then clamped at max 0.95
  });

  it('changes nothing at 0, or when omitted', () => {
    const base = {
      guaranteed: false,
      baseCaptureRate: 0.3,
      rarity: 'R' as const,
      captureModifier: 1,
      config,
    };
    expect(computeCaptureChance({ ...base, buddyBonusPercent: 0 })).toBeCloseTo(0.3, 10);
    expect(computeCaptureChance(base)).toBeCloseTo(0.3, 10);
  });

  it('never escapes the configured clamp', () => {
    expect(
      computeCaptureChance({
        guaranteed: false,
        baseCaptureRate: 0.9,
        rarity: 'N',
        captureModifier: 1,
        config,
        buddyBonusPercent: 500,
      }),
    ).toBe(config.maxChance);
  });

  it('is bypassed entirely by a guaranteed capture', () => {
    expect(
      computeCaptureChance({
        guaranteed: true,
        baseCaptureRate: 0.1,
        rarity: 'LR',
        captureModifier: 1,
        config,
        buddyBonusPercent: 100,
      }),
    ).toBe(1);
  });
});

describe('describeCaptureChance — capture-chance breakdown (incident diagnostics)', () => {
  it('LR species + Basic Charm with no bonuses stays near the LR base rate', () => {
    // The production incident: an LR encounter with only a Basic Charm
    // (no multiplier, no affinity, no buddy, no item bonus). With the correct
    // LR base rate (0.03) this is a ~3% capture — nowhere near 0.95.
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'LR',
      captureModifier: null,
      config,
    });
    expect(b.baseCaptureChance).toBeCloseTo(0.03, 10);
    expect(b.speciesCaptureModifier).toBeNull();
    expect(b.itemModifier).toBe(1);
    expect(b.playerCaptureModifier).toBe(0);
    expect(b.affinityModifier).toBe(0);
    expect(b.itemCaptureBonus).toBe(0);
    expect(b.buddyGlobalModifier).toBe(0);
    expect(b.buddyConditionalModifier).toBe(0);
    expect(b.otherModifiers).toBe(0);
    expect(b.chanceBeforeClamp).toBeCloseTo(0.03, 10);
    expect(b.finalChance).toBeCloseTo(0.03, 10);
  });

  it('reproduces the production incident when baseCaptureRate is (wrongly) 1', () => {
    // Documents the exact bad path: a species override of 1.0 makes an LR a
    // 100% base capture, which the +0.03 affinity pushes over the 0.95 ceiling.
    // The breakdown makes the culprit obvious: speciesCaptureModifier === 1.
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: 1,
      rarity: 'LR',
      captureModifier: null,
      config,
      buddyAffinityModifier: 0.03,
    });
    expect(b.speciesCaptureModifier).toBe(1);
    expect(b.baseCaptureChance).toBe(1);
    expect(b.chanceBeforeClamp).toBeCloseTo(1.03, 10);
    expect(b.finalChance).toBe(config.maxChance);
  });

  it('an LR + Basic Charm + a +3pp affinity modifier cannot silently become a 95% capture', () => {
    // The core regression guard. With the configured LR balance (base 0.03),
    // the only additive help being a +0.03 affinity bonus, the achievable
    // chance is ~0.06 — the game balance does NOT explicitly produce 0.95, so
    // the calculation must not either.
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'LR',
      captureModifier: null, // Basic Charm: no multiplier
      config,
      buddyAffinityModifier: 0.03,
    });
    expect(b.finalChance).toBeCloseTo(0.06, 10);
    expect(b.finalChance).toBeLessThan(0.1);
    expect(b.finalChance).not.toBe(config.maxChance);
  });

  it('LR species + favorable affinity adds flat points, still far below the cap', () => {
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'LR',
      captureModifier: 1,
      config,
      buddyAffinityModifier: 0.05,
    });
    expect(b.affinityModifier).toBe(0.05);
    expect(b.finalChance).toBeCloseTo(0.08, 10);
  });

  it('LR species + a relevant global buddy capture bonus scales the whole chance', () => {
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'LR',
      captureModifier: 1,
      config,
      buddyBonusPercent: 50,
    });
    expect(b.buddyGlobalModifier).toBe(50);
    expect(b.buddyConditionalModifier).toBe(0);
    // 0.03 × (1 + 50/100) = 0.045
    expect(b.chanceBeforeClamp).toBeCloseTo(0.045, 10);
    expect(b.finalChance).toBeCloseTo(0.045, 10);
  });

  it('an irrelevant conditional buddy bonus (0%) does nothing and is attributed conditionally', () => {
    // A targeted bonus that does not match this species arrives here as 0%.
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'LR',
      captureModifier: 1,
      config,
      buddyBonusPercent: 0,
      buddyBonusIsConditional: true,
    });
    expect(b.buddyGlobalModifier).toBe(0);
    expect(b.buddyConditionalModifier).toBe(0);
    expect(b.finalChance).toBeCloseTo(0.03, 10);
  });

  it('a matching conditional buddy bonus is attributed to the conditional field only', () => {
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SR',
      captureModifier: 1,
      config,
      buddyBonusPercent: 20,
      buddyBonusIsConditional: true,
    });
    expect(b.buddyGlobalModifier).toBe(0);
    expect(b.buddyConditionalModifier).toBe(20);
    // 0.22 × 1.2 = 0.264
    expect(b.finalChance).toBeCloseTo(0.264, 10);
  });

  it('common/normal species baseline uses the rarity default', () => {
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'N',
      captureModifier: 1,
      config,
    });
    expect(b.baseCaptureChance).toBe(0.5);
    expect(b.speciesCaptureModifier).toBeNull();
    expect(b.finalChance).toBeCloseTo(0.5, 10);
  });

  it('max clamp behavior: chanceBeforeClamp records the pre-clamp value', () => {
    const b = describeCaptureChance({
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'N',
      captureModifier: 4, // 0.5 × 4 = 2.0
      config,
    });
    expect(b.chanceBeforeClamp).toBeCloseTo(2.0, 10);
    expect(b.finalChance).toBe(config.maxChance);
  });

  it('guaranteed capture behavior: 1.0, unclamped, modifiers reported but inert', () => {
    const b = describeCaptureChance({
      guaranteed: true,
      baseCaptureRate: 0.0001,
      rarity: 'LR',
      captureModifier: 2,
      config,
      buddyAffinityModifier: 0.03,
      buddyBonusPercent: 100,
    });
    expect(b.guaranteed).toBe(true);
    expect(b.chanceBeforeClamp).toBe(1);
    expect(b.finalChance).toBe(1);
  });

  it('the displayed chance equals the resolution chance for identical inputs', () => {
    const input = {
      guaranteed: false,
      baseCaptureRate: null,
      rarity: 'SSR' as const,
      captureModifier: 1.5,
      config,
      buddyAffinityModifier: 0.04,
      captureBonusModifier: 0.02,
      buddyBonusPercent: 10,
    };
    // `computeCaptureChance` (the display/quote helper) and the breakdown's
    // `finalChance` (what resolution rolls against) share one body, so they
    // cannot disagree.
    expect(describeCaptureChance(input).finalChance).toBe(computeCaptureChance(input));
  });
});
