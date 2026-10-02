/**
 * Combat damage math: the defense curve, the one rounding rule, the minimum
 * hit and the HP clamp.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFENSE_SCALING,
  MIN_DAMAGE,
  basicAttackDamage,
  hpAfterDamage,
  rawBasicAttackDamage,
  roundDamage,
} from '../../../src/modules/combat/combatMath';

describe('basic attack damage', () => {
  it('is ATK × 100 / (100 + DEF)', () => {
    expect(DEFENSE_SCALING).toBe(100);
    expect(rawBasicAttackDamage(50, 25)).toBeCloseTo(40);
    expect(basicAttackDamage(50, 25)).toBe(40);
    expect(basicAttackDamage(80, 60)).toBe(50);
  });

  it('deals full ATK into zero defense', () => {
    expect(basicAttackDamage(37, 0)).toBe(37);
  });

  it('has diminishing returns on DEF: 100 halves, 300 quarters, never zero', () => {
    expect(basicAttackDamage(100, 100)).toBe(50);
    expect(basicAttackDamage(100, 300)).toBe(25);
    // Each further 100 DEF buys less than the one before.
    const d = [0, 100, 200, 300].map((def) => rawBasicAttackDamage(100, def));
    const gains = [d[0]! - d[1]!, d[1]! - d[2]!, d[2]! - d[3]!];
    expect(gains[0]).toBeGreaterThan(gains[1]!);
    expect(gains[1]).toBeGreaterThan(gains[2]!);
  });

  it('never drops below the minimum against very high defense', () => {
    expect(MIN_DAMAGE).toBe(1);
    expect(basicAttackDamage(1, 1_000_000)).toBe(1);
    expect(basicAttackDamage(0, 0)).toBe(1);
  });

  it('rounds once, half up, in one place', () => {
    expect(roundDamage(10.49)).toBe(10);
    expect(roundDamage(10.5)).toBe(11);
    expect(roundDamage(0.2)).toBe(1);
    // 10 × 100/150 = 6.67 → 7
    expect(basicAttackDamage(10, 50)).toBe(7);
    expect(Number.isInteger(basicAttackDamage(13, 17))).toBe(true);
  });
});

describe('hpAfterDamage', () => {
  it('subtracts and clamps at zero', () => {
    expect(hpAfterDamage(50, 20)).toBe(30);
    expect(hpAfterDamage(20, 20)).toBe(0);
    expect(hpAfterDamage(5, 999)).toBe(0);
  });
});
