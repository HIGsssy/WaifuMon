/**
 * The pure equipment math: stat derivation and CombatStats assembly.
 *
 * Two properties matter most. Derivation is integer arithmetic with half-up
 * rounding (the SP/boss convention), and an unavailable stat is `null` —
 * never `0` — so no consumer can confuse "not equipped" with "weak".
 */
import { describe, expect, it } from 'vitest';
import {
  assembleCombatStats,
  deriveStat,
  emptySlots,
  EQUIPMENT_FORMULA_VERSION,
  type CombatBuddy,
  type CombatSlotItem,
} from '../../src/modules/equipment/equipmentMath';

const buddy = (currentSp: number): CombatBuddy => ({
  waifuId: 1,
  speciesSlug: 'cafe_maid',
  name: 'Cafe Maid',
  level: 10,
  baseSp: currentSp,
  currentSp,
});

const item = (equipmentId: number, multiplierBp: number): CombatSlotItem => ({
  equipmentId,
  definitionKey: `gear_${equipmentId}`,
  name: `Gear ${equipmentId}`,
  definitionName: `Gear ${equipmentId}`,
  affixKey: null,
  rarity: 'R',
  multiplierBp,
  rolledProperties: {},
});

describe('deriveStat', () => {
  it('reproduces the design examples exactly', () => {
    expect(deriveStat(300, 8_000)).toBe(240);
    expect(deriveStat(300, 6_000)).toBe(180);
    expect(deriveStat(300, 30_000)).toBe(900);
    expect(deriveStat(420, 8_000)).toBe(336);
    expect(deriveStat(420, 5_500)).toBe(231);
    expect(deriveStat(420, 32_000)).toBe(1_344);
  });

  it('rounds exact halves up', () => {
    expect(deriveStat(1, 5_000)).toBe(1); // 0.5
    expect(deriveStat(3, 5_000)).toBe(2); // 1.5
    expect(deriveStat(101, 5_000)).toBe(51); // 50.5
    expect(deriveStat(223, 2_500)).toBe(56); // 55.75
    expect(deriveStat(222, 2_500)).toBe(56); // 55.5
  });

  it('rounds just below a half down', () => {
    expect(deriveStat(1, 4_999)).toBe(0);
    expect(deriveStat(9_999, 1)).toBe(1); // 0.9999
    expect(deriveStat(4_999, 1)).toBe(0); // 0.4999
  });

  it('treats zero SP and zero multiplier as zero', () => {
    expect(deriveStat(0, 8_000)).toBe(0);
    expect(deriveStat(300, 0)).toBe(0);
  });

  it.each([
    [1.5, 8_000],
    [-1, 8_000],
    [300, 0.8],
    [300, -1],
    [Number.NaN, 8_000],
  ])('refuses non-integer or negative input (%s, %s)', (sp, bp) => {
    expect(() => deriveStat(sp, bp)).toThrow(RangeError);
  });

  it('stays exact at the extremes', () => {
    expect(deriveStat(10_000, 80_000)).toBe(80_000);
    expect(deriveStat(401, 38_000)).toBe(1_524); // 1523.8
  });
});

describe('assembleCombatStats', () => {
  it('derives every stat for a complete loadout', () => {
    const stats = assembleCombatStats({
      buddy: buddy(420),
      loadoutId: 7,
      slots: { attack: item(1, 8_000), defense: item(2, 5_500), health: item(3, 32_000) },
    });
    expect(stats.stats).toEqual({ attack: 336, defense: 231, maxHp: 1_344 });
    expect(stats.missingSlots).toEqual([]);
    expect(stats.isComplete).toBe(true);
    expect(stats.unavailableReason).toBeNull();
    expect(stats.formulaVersion).toBe(EQUIPMENT_FORMULA_VERSION);
    expect(stats.appliedEffects).toEqual([]);
    expect(stats.loadout.loadoutId).toBe(7);
  });

  it('leaves an empty slot’s stat null — never zero, never a fallback', () => {
    const stats = assembleCombatStats({
      buddy: buddy(420),
      loadoutId: 7,
      slots: { ...emptySlots(), attack: item(1, 8_000) },
    });
    expect(stats.stats).toEqual({ attack: 336, defense: null, maxHp: null });
    expect(stats.missingSlots).toEqual(['defense', 'health']);
    expect(stats.isComplete).toBe(false);
    expect(stats.unavailableReason).toBe('incomplete_loadout');
  });

  it('keeps a genuine zero distinct from unavailable', () => {
    const stats = assembleCombatStats({
      buddy: buddy(0),
      loadoutId: 1,
      slots: { attack: item(1, 8_000), defense: item(2, 5_500), health: item(3, 32_000) },
    });
    expect(stats.stats).toEqual({ attack: 0, defense: 0, maxHp: 0 });
    expect(stats.isComplete).toBe(true);
  });

  it('reports every stat null with no Buddy, even when fully equipped', () => {
    const stats = assembleCombatStats({
      buddy: null,
      loadoutId: 3,
      slots: { attack: item(1, 8_000), defense: item(2, 5_500), health: item(3, 32_000) },
    });
    expect(stats.stats).toEqual({ attack: null, defense: null, maxHp: null });
    expect(stats.missingSlots).toEqual([]);
    expect(stats.isComplete).toBe(false);
    expect(stats.unavailableReason).toBe('no_buddy');
  });

  it('prefers no_buddy over incomplete_loadout', () => {
    const stats = assembleCombatStats({ buddy: null, loadoutId: null, slots: emptySlots() });
    expect(stats.unavailableReason).toBe('no_buddy');
    expect(stats.missingSlots).toEqual(['attack', 'defense', 'health']);
    expect(stats.loadout.loadoutId).toBeNull();
  });

  it('is JSON-safe, so it can be stored as a snapshot', () => {
    const stats = assembleCombatStats({
      buddy: buddy(300),
      loadoutId: 1,
      slots: { ...emptySlots(), health: item(9, 30_000) },
    });
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });
});
