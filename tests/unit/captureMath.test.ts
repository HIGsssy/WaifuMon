import { describe, expect, it } from 'vitest';
import {
  clamp,
  computeCaptureChance,
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
