/**
 * Equipment 3.0 effective SP (formula 3): equipped flat SP — primary
 * `rolled_properties.flatSp` plus additional `flat_sp` bonuses — is added to
 * natural Current SP once, before ATK / DEF / HP are derived. Pure arithmetic,
 * the storage rules a fixed grant must pass, and how flat SP reads.
 */
import { describe, expect, it } from 'vitest';
import { buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import {
  aggregateCombatBonuses,
  combatBonusListIssues,
  formatCombatBonus,
  maxCombatBonusValueBp,
  readStoredCombatBonuses,
  sortCombatBonuses,
  type CombatBonus,
} from '../../src/modules/equipment/combatBonuses';
import {
  assembleCombatStats,
  deriveStat,
  EQUIPMENT_FORMULA_VERSION,
  flatSpOf,
  itemFlatSpOf,
  readPrimaryFlatSp,
  type CombatBuddy,
  type CombatSlotItem,
} from '../../src/modules/equipment/equipmentMath';
import { rolledPropertiesOf, validateFixedRoll } from '../../src/modules/equipment/equipmentRoll';
import { ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import {
  EQUIPMENT_FLAT_SP_MAX_PER_ITEM,
  EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT,
} from '../../src/modules/equipment/vocabulary';
import { toCombatBonusResources } from '../../src/api/routes/v1/equipment';
import { gearSpSuffix } from '../../src/discord/combatSpFormat';
import { explainLine } from '../../src/discord/onboardingPresenter';

const buddy = (currentSp: number): CombatBuddy => ({
  waifuId: 1,
  speciesSlug: 'mira',
  name: 'Mira',
  level: 1,
  baseSp: currentSp,
  currentSp,
});

const item = (
  equipmentId: number,
  multiplierBp: number,
  opts: { flatSp?: number; combatBonuses?: CombatBonus[]; rolledProperties?: Record<string, unknown> } = {},
): CombatSlotItem => ({
  equipmentId,
  definitionKey: `def_${equipmentId}`,
  name: `Item ${equipmentId}`,
  definitionName: `Item ${equipmentId}`,
  affixKey: null,
  rarity: 'SSR',
  multiplierBp,
  combatBonuses: opts.combatBonuses ?? [],
  rolledProperties: opts.rolledProperties ?? (opts.flatSp ? { flatSp: opts.flatSp } : {}),
});

const flat = (valueBp: number): CombatBonus => ({ stat: 'flat_sp', valueBp });

describe('effective SP in assembleCombatStats', () => {
  it('natural 250 + primary 20 + additional 11 = effective 281, used by every stat', () => {
    const stats = assembleCombatStats({
      buddy: buddy(250),
      loadoutId: 1,
      slots: {
        attack: item(1, 8_000, { flatSp: 20, combatBonuses: [flat(11)] }),
        defense: item(2, 7_000),
        health: item(3, 26_000),
      },
    });
    expect(stats.formulaVersion).toBe(3);
    expect(EQUIPMENT_FORMULA_VERSION).toBe(3);
    expect(stats.sp).toEqual({
      natural: 250,
      primaryFlat: 20,
      additionalFlat: 11,
      equipmentBonus: 31,
      effective: 281,
      capped: false,
    });
    expect(stats.buddy!.currentSp).toBe(250);
    // The SP sits on the attack piece, yet DEF and HP rise with it.
    expect(stats.stats).toEqual({
      attack: deriveStat(281, 8_000),
      defense: deriveStat(281, 7_000),
      maxHp: deriveStat(281, 26_000),
    });
  });

  it('stacks flat SP from several equipped items', () => {
    const stats = assembleCombatStats({
      buddy: buddy(250),
      loadoutId: 1,
      slots: {
        attack: item(1, 8_000, { flatSp: 20 }),
        defense: item(2, 7_000, { flatSp: 30 }),
        health: item(3, 26_000, { combatBonuses: [flat(15)] }),
      },
    });
    expect(stats.sp).toMatchObject({ primaryFlat: 50, additionalFlat: 15, equipmentBonus: 65, effective: 315 });
    expect(stats.stats.attack).toBe(deriveStat(315, 8_000));
  });

  it('an empty slot adds nothing; the remaining items still count', () => {
    const stats = assembleCombatStats({
      buddy: buddy(250),
      loadoutId: 1,
      slots: { attack: item(1, 8_000, { flatSp: 20 }), defense: null, health: item(3, 26_000) },
    });
    expect(stats.sp).toMatchObject({ equipmentBonus: 20, effective: 270 });
    expect(stats.stats).toEqual({ attack: deriveStat(270, 8_000), defense: null, maxHp: deriveStat(270, 26_000) });
  });

  it('without flat SP, every stat is exactly the formula-2 number from natural SP', () => {
    for (const sp of [1, 99, 250, 333, 4_321]) {
      const stats = assembleCombatStats({
        buddy: buddy(sp),
        loadoutId: 1,
        slots: {
          attack: item(1, 4_500, { combatBonuses: [{ stat: 'crit_chance_bp', valueBp: 300 }] }),
          defense: item(2, 3_500),
          health: item(3, 20_000),
        },
      });
      expect(stats.sp).toMatchObject({ natural: sp, equipmentBonus: 0, effective: sp, capped: false });
      expect(stats.stats).toEqual({
        attack: deriveStat(sp, 4_500),
        defense: deriveStat(sp, 3_500),
        maxHp: deriveStat(sp, 20_000),
      });
    }
  });

  it('flat SP never enters the combat modifiers, and the modifier totals are unchanged', () => {
    const crit: CombatBonus = { stat: 'crit_chance_bp', valueBp: 425 };
    const slots = {
      attack: item(1, 8_000, { combatBonuses: [crit, flat(40)] }),
      defense: item(2, 7_000, { combatBonuses: [flat(25)] }),
      health: null,
    };
    const stats = assembleCombatStats({ buddy: buddy(250), loadoutId: 1, slots });
    expect(stats.combatModifiers).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 425 });
    expect(aggregateCombatBonuses([{ combatBonuses: [flat(200)] }]).modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
  });

  it('carries no SP block without a Buddy', () => {
    const stats = assembleCombatStats({ buddy: null, loadoutId: 1, slots: { attack: item(1, 8_000, { flatSp: 20 }), defense: null, health: null } });
    expect(stats.sp).toBeNull();
    expect(stats.stats).toEqual({ attack: null, defense: null, maxHp: null });
  });
});

describe('flat SP ceilings', () => {
  it('are the provisional technical rails: +200 per copy, +400 per loadout', () => {
    expect(EQUIPMENT_FLAT_SP_MAX_PER_ITEM).toBe(200);
    expect(EQUIPMENT_FLAT_SP_MAX_PER_LOADOUT).toBe(400);
    expect(maxCombatBonusValueBp('flat_sp')).toBe(200);
  });

  it('the loadout total is held to 400 deterministically; stored values are reported uncut', () => {
    const items = [item(1, 8_000, { flatSp: 150, combatBonuses: [flat(50)] }), item(2, 7_000, { flatSp: 200 }), item(3, 26_000, { flatSp: 120 })];
    expect(flatSpOf(items)).toEqual({ primaryFlat: 470, additionalFlat: 50, equipmentBonus: 400, capped: true });
    const stats = assembleCombatStats({
      buddy: buddy(250),
      loadoutId: 1,
      slots: { attack: items[0]!, defense: items[1]!, health: items[2]! },
    });
    expect(stats.sp).toMatchObject({ equipmentBonus: 400, effective: 650, capped: true });
    expect(stats.stats.attack).toBe(deriveStat(650, 8_000));
  });

  it('a copy over the per-copy ceiling (reached the table another way) contributes 200', () => {
    expect(itemFlatSpOf(item(1, 8_000, { flatSp: 180, combatBonuses: [flat(90)] }))).toEqual({
      primary: 180,
      additional: 90,
      contribution: 200,
    });
    expect(flatSpOf([item(1, 8_000, { flatSp: 180, combatBonuses: [flat(90)] })])).toMatchObject({ equipmentBonus: 200, capped: true });
  });

  it('is applied in an order-independent way', () => {
    const a = item(1, 8_000, { flatSp: 300 });
    const b = item(2, 7_000, { flatSp: 150 });
    const c = item(3, 26_000, { combatBonuses: [flat(120)] });
    expect(flatSpOf([a, b, c])).toEqual(flatSpOf([c, a, b]));
  });
});

describe('reading stored flat SP', () => {
  it.each([
    [{}, 0],
    [{ flatSp: 20 }, 20],
    [{ flatSp: 0 }, 0],
    [{ flatSp: -5 }, 0],
    [{ flatSp: 2.5 }, 0],
    [{ flatSp: '20' }, 0],
    [{ other: 1 }, 0],
    [null, 0],
    [[], 0],
  ])('rolled_properties %j reads as primary flat SP %d', (props, expected) => {
    expect(readPrimaryFlatSp(props)).toBe(expected);
  });

  it('a stored flat_sp bonus survives the stored-bonus reader and sorts last', () => {
    const stored = readStoredCombatBonuses([
      { stat: 'flat_sp', valueBp: 11 },
      { stat: 'crit_chance_bp', valueBp: 500 },
    ]);
    expect(stored).toEqual([
      { stat: 'crit_chance_bp', valueBp: 500 },
      { stat: 'flat_sp', valueBp: 11 },
    ]);
    // Existing family orders do not move: flat_sp is appended to the canonical order.
    expect(sortCombatBonuses([{ stat: 'lifesteal_bp', valueBp: 1 }, { stat: 'crit_chance_bp', valueBp: 1 }]).map((b) => b.stat)).toEqual([
      'crit_chance_bp',
      'lifesteal_bp',
    ]);
  });

  it('rolledPropertiesOf stores { flatSp } only when there is some', () => {
    expect(rolledPropertiesOf({})).toEqual({});
    expect(rolledPropertiesOf({ flatSp: 0 })).toEqual({});
    expect(rolledPropertiesOf({ flatSp: 20 })).toEqual({ flatSp: 20 });
  });
});

describe('storage validation', () => {
  const definition = { slot: 'attack', rarity: 'SSR', multiplierMinBp: 11_000, multiplierMaxBp: 11_000, multiplierStepBp: 100 };
  const affixes = buildAffixCatalogue([]);
  const fixed = (over: Record<string, unknown>) => validateFixedRoll(definition, { rolledMultiplierBp: 11_000, affixKey: null, ...over }, affixes);

  it('a fixed roll may carry primary and additional flat SP within the per-copy ceiling', () => {
    expect(fixed({ flatSp: 20, combatBonuses: [flat(11)] })).toEqual([]);
    expect(fixed({ flatSp: 200 })).toEqual([]);
    expect(fixed({ combatBonuses: [flat(200)] })).toEqual([]);
    expect(fixed({ flatSp: 0 })).toEqual([]);
  });

  it('refuses negative, fractional, non-numeric and over-ceiling values before storage', () => {
    for (const flatSp of [-1, 2.5, '20', 201]) {
      expect(fixed({ flatSp }).map((i) => i.path)).toContain('roll.flatSp');
    }
    expect(fixed({ flatSp: 150, combatBonuses: [flat(51)] })).toEqual([
      expect.objectContaining({ path: 'roll.flatSp', message: expect.stringContaining('total 201') }),
    ]);
    expect(combatBonusListIssues([flat(201)])[0]!.message).toMatch(/from 1 to 200/);
    expect(combatBonusListIssues([flat(0)])[0]!.message).toMatch(/from 1 to 200/);
  });

  it('three distinct bonuses (one of them flat SP) are a valid stored list; a repeated flat_sp is not', () => {
    expect(
      combatBonusListIssues([
        { stat: 'crit_chance_bp', valueBp: 500 },
        { stat: 'lifesteal_bp', valueBp: 100 },
        flat(10),
      ]),
    ).toEqual([]);
    expect(combatBonusListIssues([flat(10), flat(20)])[0]!.message).toMatch(/duplicate combat bonus "flat_sp"/);
  });
});

describe('Discord SP lines', () => {
  const sp = (equipmentBonus: number) => ({
    natural: 250,
    primaryFlat: equipmentBonus,
    additionalFlat: 0,
    equipmentBonus,
    effective: 250 + equipmentBonus,
    capped: false,
  });

  it('adds nothing when gear adds no SP, so existing screens read exactly as before', () => {
    expect(gearSpSuffix(null)).toBe('');
    expect(gearSpSuffix(undefined)).toBe('');
    expect(gearSpSuffix(sp(0))).toBe('');
  });

  it('names the gear SP and the combat SP when there is some', () => {
    expect(gearSpSuffix(sp(31))).toBe(' · Gear +31 SP → 281 combat SP');
    expect(gearSpSuffix(sp(31), { bold: true })).toBe(' · Gear **+31** SP → **281** combat SP');
  });

  it('the onboarding explanation multiplies the SP the stat was actually derived from', () => {
    const slot = item(1, 4_500);
    expect(explainLine(281, slot, 'attack', deriveStat(281, 4_500))).toBe(`281 × 0.45 = ${deriveStat(281, 4_500)} ATK`);
  });
});

describe('how flat SP reads', () => {
  it('as a whole-SP line on Discord and in the API', () => {
    expect(formatCombatBonus(flat(11))).toBe('+11 SP');
    expect(formatCombatBonus({ stat: 'crit_chance_bp', valueBp: 425 })).toBe('+4.25% Crit Chance');
    expect(toCombatBonusResources([flat(11), { stat: 'crit_chance_bp', valueBp: 425 }])).toEqual([
      { stat: 'flat_sp', label: 'SP', percent: null, sp: 11, text: '+11 SP' },
      { stat: 'crit_chance', label: 'Crit Chance', percent: 4.25, sp: null, text: '+4.25% Crit Chance' },
    ]);
  });
});
