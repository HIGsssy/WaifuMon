/**
 * Roll quality — the display-only "how good is this roll" percentage.
 * Pinned here because both the Portal API and its sort depend on one formula:
 * `(rolled − min) / (max − min)`, 0–100, single-value ranges at 100.
 */
import { describe, expect, it } from 'vitest';
import { rollQualityPercent } from '../../src/modules/equipment/equipmentRoll';

const range = (min: number, max: number) => ({ multiplierMinBp: min, multiplierMaxBp: max });

describe('rollQualityPercent', () => {
  it('maps the configured range onto 0–100', () => {
    expect(rollQualityPercent(range(6_500, 8_500), 6_500)).toBe(0);
    expect(rollQualityPercent(range(6_500, 8_500), 8_000)).toBe(75);
    expect(rollQualityPercent(range(6_500, 8_500), 8_500)).toBe(100);
    expect(rollQualityPercent(range(4_000, 6_000), 5_500)).toBe(75);
  });

  it('rounds to a whole percent', () => {
    expect(rollQualityPercent(range(4_000, 7_000), 5_000)).toBe(33);
    expect(rollQualityPercent(range(4_000, 7_000), 6_000)).toBe(67);
  });

  it('treats a single-value range as 100%', () => {
    expect(rollQualityPercent(range(5_000, 5_000), 5_000)).toBe(100);
  });

  it('clamps a roll a later retune left outside the range', () => {
    expect(rollQualityPercent(range(5_000, 6_000), 4_000)).toBe(0);
    expect(rollQualityPercent(range(5_000, 6_000), 7_000)).toBe(100);
  });
});
