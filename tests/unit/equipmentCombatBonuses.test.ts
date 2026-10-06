/**
 * Equipment combat bonuses — the pure rules: the catalogue's validation, how
 * many bonuses each rarity rolls, which families and magnitudes, what a fixed
 * grant may dictate, how equipped bonuses aggregate and cap, and how they
 * read. Persistence is `tests/integration/equipmentCombatBonuses.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMBAT_MODIFIER_CAPS, ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import { EQUIPMENT_AFFIX_POOLS, buildAffixCatalogue, type EquipmentAffix } from '../../src/modules/equipment/affixCatalogue';
import {
  COMBAT_BONUS_RARITIES,
  COMBAT_BONUS_STATS,
  CombatBonusPoolError,
  EQUIPMENT_COMBAT_BONUS_FILE,
  EquipmentCombatBonusFileSchema,
  MAX_COMBAT_BONUSES_PER_ITEM,
  aggregateCombatBonuses,
  combatBonusCatalogueFromFile,
  combatBonusListIssues,
  combatBonusValues,
  combatModifierRows,
  eligibleCombatBonusFamilies,
  formatBonusPercent,
  formatCombatBonus,
  readStoredCombatBonuses,
  rollCombatBonuses,
  sortCombatBonuses,
  type CombatBonus,
  type CombatBonusCatalogue,
  type CombatBonusStat,
  type EquipmentCombatBonusFile,
} from '../../src/modules/equipment/combatBonuses';
import { assembleCombatStats, EQUIPMENT_FORMULA_VERSION, type CombatSlotItem } from '../../src/modules/equipment/equipmentMath';
import { rollEquipmentInstance, validateFixedRoll } from '../../src/modules/equipment/equipmentRoll';
import { EQUIPMENT_SLOTS } from '../../src/modules/equipment/vocabulary';
import { STARTER_ROLLS } from '../../src/modules/onboarding/vocabulary';
import { seededRng, type Rng } from '../../src/shared/random';
import { CONTENT_DIR } from '../helpers/fixtures';

const shippedFile = (): EquipmentCombatBonusFile =>
  EquipmentCombatBonusFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_COMBAT_BONUS_FILE), 'utf8')));
const SHIPPED: CombatBonusCatalogue = combatBonusCatalogueFromFile(shippedFile());
const family = (stat: CombatBonusStat) => SHIPPED.bonuses.find((b) => b.stat === stat)!;

/** A mutable copy of the shipped file, for validation tests. */
const draft = (): EquipmentCombatBonusFile => JSON.parse(JSON.stringify(shippedFile())) as EquipmentCombatBonusFile;
const issuesOf = (file: unknown) => {
  const result = EquipmentCombatBonusFileSchema.safeParse(file);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

/** Answers `intInclusive` from a script, to pin exact picks. */
function scripted(...picks: number[]): Rng & { draws: number } {
  const rng = {
    draws: 0,
    next: () => 0,
    intInclusive(min: number, max: number) {
      const v = picks[rng.draws];
      rng.draws += 1;
      if (v === undefined) throw new Error(`unexpected draw #${rng.draws} over [${min}, ${max}]`);
      if (v < min || v > max) throw new Error(`scripted pick ${v} outside [${min}, ${max}]`);
      return v;
    },
  };
  return rng;
}

const gear = (slot: string, rarity: string) => ({ slot, rarity });
const roll = (slot: string, rarity: string, rng: Rng, catalogue: CombatBonusCatalogue | null = SHIPPED) =>
  rollCombatBonuses(gear(slot, rarity), { rng, catalogue });

describe('the shipped combat-bonus catalogue', () => {
  it('ships the five families under stable keys', () => {
    expect(COMBAT_BONUS_STATS).toEqual([
      'crit_chance_bp',
      'crit_damage_bonus_bp',
      'double_attack_chance_bp',
      'armor_penetration_bp',
      'lifesteal_bp',
    ]);
    expect(SHIPPED.bonuses.map((b) => b.stat)).toEqual([...COMBAT_BONUS_STATS]);
    expect(SHIPPED.bonuses.every((b) => b.enabled)).toBe(true);
  });

  it('ships the rarity bonus-count rules: N 65% for one, R always one, SR always two', () => {
    expect(SHIPPED.rarityRules).toEqual({
      N: { bonusChanceBp: 6_500, bonusCount: 1 },
      R: { bonusChanceBp: 10_000, bonusCount: 1 },
      SR: { bonusChanceBp: 10_000, bonusCount: 2 },
    });
  });

  it('ships the initial-tuning ranges and steps', () => {
    const table = Object.fromEntries(
      SHIPPED.bonuses.map((b) => [b.stat, [b.stepBp, ...COMBAT_BONUS_RARITIES.map((r) => [b.ranges[r].minBp, b.ranges[r].maxBp])]]),
    );
    expect(table).toEqual({
      crit_chance_bp: [25, [100, 300], [250, 500], [450, 800]],
      crit_damage_bonus_bp: [50, [500, 1_000], [800, 1_500], [1_200, 2_000]],
      double_attack_chance_bp: [25, [50, 200], [150, 350], [300, 600]],
      armor_penetration_bp: [50, [200, 500], [400, 800], [700, 1_200]],
      lifesteal_bp: [25, [100, 200], [150, 300], [250, 500]],
    });
  });

  it('a higher rarity never rolls a weaker range', () => {
    for (const b of SHIPPED.bonuses) {
      expect(b.ranges.R.minBp).toBeGreaterThanOrEqual(b.ranges.N.minBp);
      expect(b.ranges.SR.minBp).toBeGreaterThanOrEqual(b.ranges.R.minBp);
      expect(b.ranges.R.maxBp).toBeGreaterThan(b.ranges.N.maxBp);
      expect(b.ranges.SR.maxBp).toBeGreaterThan(b.ranges.R.maxBp);
    }
  });

  it('every pool can supply its rarity’s distinct bonuses', () => {
    for (const slot of EQUIPMENT_SLOTS) {
      for (const rarity of COMBAT_BONUS_RARITIES) {
        const pool = eligibleCombatBonusFamilies(SHIPPED, slot, rarity);
        expect(pool.length, `${slot}.${rarity}`).toBeGreaterThanOrEqual(SHIPPED.rarityRules[rarity].bonusCount);
        expect(new Set(pool.map((f) => f.stat)).size).toBe(pool.length);
      }
    }
  });

  it('eligibility is authored per slot and overlaps: Crit Chance, Double Attack and Lifesteal roll on all three', () => {
    for (const stat of ['crit_chance_bp', 'double_attack_chance_bp', 'lifesteal_bp'] as const) {
      for (const slot of EQUIPMENT_SLOTS) expect(SHIPPED.eligibility[slot]).toContain(stat);
    }
    // …and not everything rolls everywhere.
    expect(SHIPPED.eligibility.health).not.toContain('armor_penetration_bp');
    expect(SHIPPED.eligibility.defense).not.toContain('crit_damage_bonus_bp');
  });

  it('three max-rolled SR pieces stay under every safety cap', () => {
    for (const b of SHIPPED.bonuses) {
      const modifier = aggregateCombatBonuses(Array.from({ length: 3 }, () => ({ combatBonuses: [{ stat: b.stat, valueBp: b.ranges.SR.maxBp }] })));
      expect(modifier.capped, b.stat).toEqual([]);
    }
  });
});

describe('catalogue validation', () => {
  it('accepts the shipped file', () => {
    expect(issuesOf(shippedFile())).toEqual([]);
  });

  it('refuses an SR pool that cannot supply two distinct families', () => {
    const file = draft();
    file.eligibility.health = ['lifesteal_bp'];
    expect(issuesOf(file)).toEqual(['eligibility.health: pool health.SR needs 2 distinct enabled bonus families but only 1 are eligible']);
  });

  it('counts only enabled families toward a pool', () => {
    const file = draft();
    file.eligibility.defense = ['crit_chance_bp', 'lifesteal_bp'];
    file.bonuses.find((b) => b.stat === 'lifesteal_bp')!.enabled = false;
    expect(issuesOf(file)).toContain('eligibility.defense: pool defense.SR needs 2 distinct enabled bonus families but only 1 are eligible');
  });

  it('refuses an R pool with nothing to roll', () => {
    const file = draft();
    file.eligibility.attack = [];
    const issues = issuesOf(file);
    expect(issues).toContain('eligibility.attack: pool attack.R needs 1 distinct enabled bonus families but only 0 are eligible');
    expect(issues).toContain('eligibility.attack: pool attack.N needs 1 distinct enabled bonus families but only 0 are eligible');
  });

  it('refuses a duplicate family in a slot’s eligibility', () => {
    const file = draft();
    file.eligibility.attack = ['crit_chance_bp', 'crit_chance_bp', 'lifesteal_bp'];
    expect(issuesOf(file)).toContain('eligibility.attack.1: duplicate stat "crit_chance_bp"');
  });

  it.each([
    ['max below min', { minBp: 500, maxBp: 400 }, 'must be at least minBp (500)'],
    ['a step that does not divide the range', { minBp: 100, maxBp: 310 }, 'stepBp 25 must divide the range evenly (310 - 100 = 210)'],
    ['a range above the combat cap', { minBp: 100, maxBp: 5_025 }, 'must be at most 5000, the combat cap for crit_chance_bp'],
    ['a zero minimum', { minBp: 0, maxBp: 300 }, 'Number must be greater than or equal to 1'],
    ['a fractional value', { minBp: 100.5, maxBp: 300 }, 'Expected integer, received float'],
  ])('refuses %s', (_label, range, message) => {
    const file = draft();
    file.bonuses[0]!.ranges.N = range;
    expect(issuesOf(file).join('\n')).toContain(message);
  });

  it('refuses unknown stats, unknown fields, duplicate families and out-of-range rules', () => {
    const unknownStat = draft() as unknown as { bonuses: { stat: string }[] };
    unknownStat.bonuses[0]!.stat = 'dodge_bp';
    expect(issuesOf(unknownStat).length).toBeGreaterThan(0);

    const extra = draft() as unknown as { bonuses: Record<string, unknown>[] };
    extra.bonuses[0]!.weight = 3;
    expect(issuesOf(extra).join('\n')).toContain('Unrecognized key');

    const duplicate = draft();
    duplicate.bonuses[1] = { ...duplicate.bonuses[0]! };
    expect(issuesOf(duplicate).join('\n')).toContain('duplicate bonus family "crit_chance_bp"');

    const threeBonuses = draft();
    threeBonuses.rarityRules.SR.bonusCount = 3;
    expect(issuesOf(threeBonuses).length).toBeGreaterThan(0);

    const badChance = draft();
    badChance.rarityRules.N.bonusChanceBp = 10_001;
    expect(issuesOf(badChance).length).toBeGreaterThan(0);

    const ssr = draft() as unknown as { rarityRules: Record<string, unknown> };
    ssr.rarityRules.SSR = { bonusChanceBp: 10_000, bonusCount: 2 };
    expect(issuesOf(ssr).join('\n')).toContain('Unrecognized key');
  });
});

describe('rarity controls the bonus count', () => {
  it('N rolls no bonus when its chance roll fails, and draws nothing else', () => {
    const rng = scripted(6_501);
    expect(roll('attack', 'N', rng)).toEqual([]);
    expect(rng.draws).toBe(1);
  });

  it('N rolls exactly one bonus when its chance roll succeeds', () => {
    // Chance 6500 (succeeds at the boundary), family index 0, magnitude step 0.
    const rng = scripted(6_500, 0, 0);
    expect(roll('attack', 'N', rng)).toEqual([{ stat: 'crit_chance_bp', valueBp: 100 }]);
    expect(rng.draws).toBe(3);
  });

  it('the N decision is deterministic for a seed', () => {
    const a = Array.from({ length: 50 }, (_, seed) => roll('defense', 'N', seededRng(seed)));
    const b = Array.from({ length: 50 }, (_, seed) => roll('defense', 'N', seededRng(seed)));
    expect(b).toEqual(a);
    expect(a.some((r) => r.length === 0)).toBe(true);
    expect(a.some((r) => r.length === 1)).toBe(true);
    expect(a.every((r) => r.length <= 1)).toBe(true);
  });

  it('N gets a bonus at about the configured 65%', () => {
    const rng = seededRng(20261006);
    const trials = 20_000;
    let withBonus = 0;
    for (let i = 0; i < trials; i += 1) if (roll('attack', 'N', rng).length === 1) withBonus += 1;
    expect(Math.abs(withBonus / trials - 0.65)).toBeLessThan(0.015);
  });

  it('the N chance comes from the catalogue, not from the roll', () => {
    const always = { ...SHIPPED, rarityRules: { ...SHIPPED.rarityRules, N: { bonusChanceBp: 10_000, bonusCount: 1 } } };
    const never = { ...SHIPPED, rarityRules: { ...SHIPPED.rarityRules, N: { bonusChanceBp: 0, bonusCount: 1 } } };
    const rng = seededRng(1);
    for (let i = 0; i < 200; i += 1) {
      expect(roll('health', 'N', rng, always)).toHaveLength(1);
      expect(roll('health', 'N', rng, never)).toEqual([]);
    }
    // A guaranteed or impossible bonus spends no chance draw.
    const guaranteed = scripted(0, 0);
    roll('attack', 'N', guaranteed, always);
    expect(guaranteed.draws).toBe(2);
    const none = scripted();
    roll('attack', 'N', none, never);
    expect(none.draws).toBe(0);
  });

  it.each(EQUIPMENT_SLOTS)('R %s gear always rolls exactly one bonus', (slot) => {
    const rng = seededRng(99);
    for (let i = 0; i < 2_000; i += 1) expect(roll(slot, 'R', rng)).toHaveLength(1);
  });

  it.each(EQUIPMENT_SLOTS)('SR %s gear always rolls exactly two bonuses of distinct families', (slot) => {
    const rng = seededRng(7);
    for (let i = 0; i < 2_000; i += 1) {
      const bonuses = roll(slot, 'SR', rng);
      expect(bonuses).toHaveLength(2);
      expect(bonuses[0]!.stat).not.toBe(bonuses[1]!.stat);
    }
  });

  it('SR picks its second family from what is left, so a repeat is impossible', () => {
    // Family index 0 twice: the second pick is index 0 of the *remaining* four.
    const rng = scripted(0, 0, 0, 0);
    expect(roll('attack', 'SR', rng).map((b) => b.stat)).toEqual(['crit_chance_bp', 'crit_damage_bonus_bp']);
    // An index only valid for a five-entry pool is refused on the second pick.
    expect(() => roll('attack', 'SR', scripted(0, 4, 0, 0))).toThrow(/outside \[0, 3\]/);
  });

  it('every eligible family is reachable, and no ineligible one ever rolls', () => {
    for (const slot of EQUIPMENT_SLOTS) {
      for (const rarity of ['R', 'SR'] as const) {
        const rng = seededRng(5);
        const seen = new Set<string>();
        for (let i = 0; i < 1_000; i += 1) for (const b of roll(slot, rarity, rng)) seen.add(b.stat);
        expect([...seen].sort(), `${slot}.${rarity}`).toEqual([...SHIPPED.eligibility[slot]].sort());
      }
    }
  });

  it('fails loudly, before drawing, when a pool cannot supply distinct families', () => {
    const thin: CombatBonusCatalogue = { ...SHIPPED, eligibility: { ...SHIPPED.eligibility, health: ['lifesteal_bp'] } };
    const rng = scripted();
    expect(() => roll('health', 'SR', rng, thin)).toThrow(CombatBonusPoolError);
    expect(() => roll('health', 'SR', rng, thin)).toThrow('combat bonus pool "health.SR" needs 2 distinct bonus families but has 1');
    expect(rng.draws).toBe(0);
  });

  it.each(['SSR', 'UR', 'LR', 'EX', 'nonsense'])('a rarity without rules (%s) rolls no bonus and draws nothing', (rarity) => {
    const rng = scripted();
    expect(roll('attack', rarity, rng)).toEqual([]);
    expect(rng.draws).toBe(0);
  });

  it('without a catalogue nothing is rolled', () => {
    const rng = scripted();
    expect(roll('attack', 'SR', rng, null)).toEqual([]);
    expect(rng.draws).toBe(0);
  });

  it('returns bonuses in canonical family order whatever order they were picked in', () => {
    // attack pool index 4 = lifesteal first, then index 0 = crit chance.
    expect(roll('attack', 'SR', scripted(4, 0, 0, 0)).map((b) => b.stat)).toEqual(['crit_chance_bp', 'lifesteal_bp']);
  });
});

describe('rarity controls the magnitude', () => {
  it.each(COMBAT_BONUS_RARITIES)('%s rolls stay inside that rarity’s range, on its steps, and reach both ends', (rarity) => {
    const rng = seededRng(31);
    const seen = new Map<string, Set<number>>();
    const always = { ...SHIPPED, rarityRules: { ...SHIPPED.rarityRules, N: { bonusChanceBp: 10_000, bonusCount: 1 } } };
    for (let i = 0; i < 6_000; i += 1) {
      for (const b of roll('attack', rarity, rng, always)) {
        const { minBp, maxBp } = family(b.stat).ranges[rarity];
        expect(b.valueBp).toBeGreaterThanOrEqual(minBp);
        expect(b.valueBp).toBeLessThanOrEqual(maxBp);
        expect((b.valueBp - minBp) % family(b.stat).stepBp).toBe(0);
        expect(Number.isInteger(b.valueBp)).toBe(true);
        seen.set(b.stat, (seen.get(b.stat) ?? new Set()).add(b.valueBp));
      }
    }
    for (const b of SHIPPED.bonuses) {
      expect([...seen.get(b.stat)!].sort((x, y) => x - y), `${b.stat} @ ${rarity}`).toEqual(combatBonusValues(b, rarity));
    }
  });

  it('the boundaries are rollable: the first and last step', () => {
    const crit = family('crit_chance_bp');
    expect(combatBonusValues(crit, 'R')).toEqual([250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500]);
    expect(roll('attack', 'R', scripted(0, 0))).toEqual([{ stat: 'crit_chance_bp', valueBp: 250 }]);
    expect(roll('attack', 'R', scripted(0, 10))).toEqual([{ stat: 'crit_chance_bp', valueBp: 500 }]);
    expect(() => roll('attack', 'R', scripted(0, 11))).toThrow(/outside \[0, 10\]/);
  });

  it('an SR roll is stronger than an N roll of the same family can be', () => {
    for (const b of SHIPPED.bonuses) expect(b.ranges.SR.minBp).toBeGreaterThan(b.ranges.N.minBp);
  });

  it('a random instance roll draws multiplier, then affix, then bonuses', () => {
    const list: EquipmentAffix[] = EQUIPMENT_AFFIX_POOLS.map((pool) => ({ key: pool.replace('.', '_').toLowerCase(), suffix: `of ${pool}`, pool, enabled: true }));
    const definition = { key: 'railcarbine', slot: 'attack', rarity: 'SR', multiplierMinBp: 9_500, multiplierMaxBp: 12_000, multiplierStepBp: 500 };
    // multiplier step 4 (×1.15), affix 0, families 0 and 1 (of the remaining four), magnitudes 8 and 5.
    const rng = scripted(4, 0, 0, 1, 8, 5);
    expect(rollEquipmentInstance(definition, { rng, affixes: buildAffixCatalogue(list), combatBonuses: SHIPPED })).toEqual({
      rolledMultiplierBp: 11_500,
      affixKey: 'attack_sr',
      combatBonuses: [
        { stat: 'crit_chance_bp', valueBp: 650 },
        { stat: 'double_attack_chance_bp', valueBp: 425 },
      ],
    });
    expect(rng.draws).toBe(6);
  });
});

describe('what an instance may store', () => {
  const ok = (value: unknown) => expect(combatBonusListIssues(value)).toEqual([]);
  const bad = (value: unknown, fragment: string) => expect(combatBonusListIssues(value).map((i) => `${i.path} ${i.message}`).join('\n')).toContain(fragment);

  it('accepts none, one or two distinct bonuses in whole basis points', () => {
    ok([]);
    ok([{ stat: 'crit_chance_bp', valueBp: 425 }]);
    ok([
      { stat: 'crit_chance_bp', valueBp: 625 },
      { stat: 'double_attack_chance_bp', valueBp: 400 },
    ]);
    expect(MAX_COMBAT_BONUSES_PER_ITEM).toBe(2);
  });

  it('accepts values outside the rarity ranges — a fixed grant states what a copy carries', () => {
    ok([{ stat: 'lifesteal_bp', valueBp: 1_234 }]);
    ok([{ stat: 'crit_chance_bp', valueBp: COMBAT_MODIFIER_CAPS.critChanceBp }]);
  });

  it('refuses a third bonus, a repeated family, an unknown family and bad values', () => {
    bad(
      [
        { stat: 'crit_chance_bp', valueBp: 100 },
        { stat: 'lifesteal_bp', valueBp: 100 },
        { stat: 'armor_penetration_bp', valueBp: 100 },
      ],
      'at most 2 combat bonuses per item, got 3',
    );
    bad(
      [
        { stat: 'crit_chance_bp', valueBp: 100 },
        { stat: 'crit_chance_bp', valueBp: 200 },
      ],
      'combatBonuses[1].stat duplicate combat bonus "crit_chance_bp" on one item',
    );
    bad([{ stat: 'dodge_bp', valueBp: 100 }], 'combatBonuses[0].stat must be one of');
    bad([{ stat: 'crit_chance_bp', valueBp: 4.25 }], 'combatBonuses[0].valueBp must be whole basis points from 1 to 5000');
    bad([{ stat: 'crit_chance_bp', valueBp: 0 }], 'must be whole basis points');
    bad([{ stat: 'crit_chance_bp', valueBp: 5_001 }], 'from 1 to 5000');
    bad([{ stat: 'crit_chance_bp', valueBp: '425' }], 'must be whole basis points');
    bad([{ stat: 'crit_chance_bp', valueBp: 100, label: 'Crit' }], 'unknown field(s): label');
    bad('crit', 'must be an array');
    bad([null], 'must be an object');
  });

  it('a fixed roll may dictate bonuses, or omit them for none', () => {
    const definition = { slot: 'attack', rarity: 'SR', multiplierMinBp: 9_500, multiplierMaxBp: 12_000, multiplierStepBp: 500 };
    const affixes = buildAffixCatalogue([]);
    expect(validateFixedRoll(definition, { rolledMultiplierBp: 11_500, affixKey: null }, affixes)).toEqual([]);
    expect(
      validateFixedRoll(definition, { rolledMultiplierBp: 11_500, affixKey: null, combatBonuses: [{ stat: 'lifesteal_bp', valueBp: 300 }] }, affixes),
    ).toEqual([]);
    expect(
      validateFixedRoll(definition, { rolledMultiplierBp: 11_500, affixKey: null, combatBonuses: [{ stat: 'nope', valueBp: 1 }] }, affixes).map((i) => i.path),
    ).toEqual(['roll.combatBonuses[0].stat']);
    // An SSR definition — no random rules — still takes explicit bonuses.
    expect(
      validateFixedRoll({ ...definition, rarity: 'SSR' }, { rolledMultiplierBp: 11_500, affixKey: null, combatBonuses: [{ stat: 'crit_chance_bp', valueBp: 1_200 }] }, affixes),
    ).toEqual([]);
  });

  it('the onboarding starters dictate no bonuses', () => {
    for (const slot of EQUIPMENT_SLOTS) expect(STARTER_ROLLS[slot]).not.toHaveProperty('combatBonuses');
  });

  it('reads stored data defensively: old or malformed rows have no bonuses', () => {
    expect(readStoredCombatBonuses(undefined)).toEqual([]);
    expect(readStoredCombatBonuses(null)).toEqual([]);
    expect(readStoredCombatBonuses({})).toEqual([]);
    expect(readStoredCombatBonuses('[]')).toEqual([]);
    expect(readStoredCombatBonuses([{ stat: 'retired_family_bp', valueBp: 100 }, null, { stat: 'crit_chance_bp', valueBp: 1.5 }])).toEqual([]);
    expect(
      readStoredCombatBonuses([
        { stat: 'lifesteal_bp', valueBp: 275 },
        { stat: 'crit_chance_bp', valueBp: 450 },
      ]),
    ).toEqual([
      { stat: 'crit_chance_bp', valueBp: 450 },
      { stat: 'lifesteal_bp', valueBp: 275 },
    ]);
  });

  it('sortCombatBonuses is canonical and does not mutate', () => {
    const input: CombatBonus[] = [
      { stat: 'lifesteal_bp', valueBp: 1 },
      { stat: 'crit_chance_bp', valueBp: 2 },
    ];
    expect(sortCombatBonuses(input).map((b) => b.stat)).toEqual(['crit_chance_bp', 'lifesteal_bp']);
    expect(input[0]!.stat).toBe('lifesteal_bp');
  });
});

describe('aggregateCombatBonuses', () => {
  const item = (...combatBonuses: CombatBonus[]) => ({ combatBonuses });

  it('defaults to zero for nothing, empty slots and bonus-free or pre-system gear', () => {
    expect(aggregateCombatBonuses([]).modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(aggregateCombatBonuses([null, undefined, item(), {}, { combatBonuses: null }]).modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
  });

  it('adds the same stat across three separate items', () => {
    const { modifiers, capped } = aggregateCombatBonuses([
      item({ stat: 'crit_chance_bp', valueBp: 325 }),
      item({ stat: 'crit_chance_bp', valueBp: 200 }),
      item({ stat: 'crit_chance_bp', valueBp: 450 }, { stat: 'lifesteal_bp', valueBp: 275 }),
    ]);
    expect(modifiers).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 975, lifestealBp: 275 });
    expect(capped).toEqual([]);
  });

  it('takes both stats from one SR item', () => {
    expect(
      aggregateCombatBonuses([item({ stat: 'crit_chance_bp', valueBp: 650 }, { stat: 'double_attack_chance_bp', valueBp: 425 })]).modifiers,
    ).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 650, doubleAttackChanceBp: 425 });
  });

  it('adds a mixed loadout family by family, Crit Damage included', () => {
    const { modifiers } = aggregateCombatBonuses([
      item({ stat: 'crit_damage_bonus_bp', valueBp: 1_000 }, { stat: 'armor_penetration_bp', valueBp: 750 }),
      item({ stat: 'crit_damage_bonus_bp', valueBp: 750 }),
      item({ stat: 'lifesteal_bp', valueBp: 250 }, { stat: 'double_attack_chance_bp', valueBp: 400 }),
    ]);
    // 15000 base + 1000 + 750 = 167.5% total — summed first, never multiplied one by one.
    expect(modifiers).toEqual({ critChanceBp: 0, critDamageBonusBp: 1_750, doubleAttackChanceBp: 400, armorPenetrationBp: 750, lifestealBp: 250 });
  });

  it('clamps the total at the safety caps and reports what it capped, without touching the items', () => {
    const items = [
      item({ stat: 'crit_chance_bp', valueBp: 3_000 }, { stat: 'lifesteal_bp', valueBp: 1_500 }),
      item({ stat: 'crit_chance_bp', valueBp: 3_000 }, { stat: 'lifesteal_bp', valueBp: 1_500 }),
      item({ stat: 'crit_damage_bonus_bp', valueBp: 9_000 }, { stat: 'armor_penetration_bp', valueBp: 100 }),
      item({ stat: 'crit_damage_bonus_bp', valueBp: 9_000 }, { stat: 'double_attack_chance_bp', valueBp: 3_600 }),
    ];
    const snapshot = JSON.stringify(items);
    const { modifiers, uncapped, capped } = aggregateCombatBonuses(items);
    expect(uncapped).toEqual({ critChanceBp: 6_000, critDamageBonusBp: 18_000, doubleAttackChanceBp: 3_600, armorPenetrationBp: 100, lifestealBp: 3_000 });
    expect(modifiers).toEqual({ critChanceBp: 5_000, critDamageBonusBp: 10_000, doubleAttackChanceBp: 3_500, armorPenetrationBp: 100, lifestealBp: 2_000 });
    expect(capped).toEqual(['critChanceBp', 'critDamageBonusBp', 'doubleAttackChanceBp', 'lifestealBp']);
    expect(JSON.stringify(items)).toBe(snapshot);
  });

  it('refuses a fractional or negative stored value instead of rounding it', () => {
    expect(() => aggregateCombatBonuses([item({ stat: 'crit_chance_bp', valueBp: 1.5 })])).toThrow(RangeError);
    expect(() => aggregateCombatBonuses([item({ stat: 'crit_chance_bp', valueBp: -1 })])).toThrow(RangeError);
  });

  it('CombatStats carries the aggregate of whatever is equipped', () => {
    const slot = (equipmentId: number, multiplierBp: number, combatBonuses: CombatBonus[]): CombatSlotItem => ({
      equipmentId,
      definitionKey: `def_${equipmentId}`,
      name: `Item ${equipmentId}`,
      definitionName: `Item ${equipmentId}`,
      affixKey: null,
      rarity: 'R',
      multiplierBp,
      combatBonuses,
      rolledProperties: {},
    });
    const buddy = { waifuId: 1, speciesSlug: 'mira', name: 'Mira', level: 35, baseSp: 100, currentSp: 200 };
    const stats = assembleCombatStats({
      buddy,
      loadoutId: 1,
      slots: {
        attack: slot(1, 8_000, [{ stat: 'crit_chance_bp', valueBp: 325 }]),
        defense: slot(2, 7_000, [{ stat: 'crit_chance_bp', valueBp: 200 }]),
        health: slot(3, 26_000, [
          { stat: 'crit_chance_bp', valueBp: 450 },
          { stat: 'lifesteal_bp', valueBp: 275 },
        ]),
      },
    });
    expect(stats.formulaVersion).toBe(EQUIPMENT_FORMULA_VERSION);
    expect(EQUIPMENT_FORMULA_VERSION).toBe(2);
    expect(stats.stats).toEqual({ attack: 160, defense: 140, maxHp: 520 });
    expect(stats.combatModifiers).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 975, lifestealBp: 275 });
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);

    // An incomplete loadout still reports what is equipped; an empty one reports zero.
    const partial = assembleCombatStats({ buddy, loadoutId: 1, slots: { attack: slot(1, 8_000, [{ stat: 'lifesteal_bp', valueBp: 150 }]), defense: null, health: null } });
    expect(partial.isComplete).toBe(false);
    expect(partial.combatModifiers.lifestealBp).toBe(150);
    expect(assembleCombatStats({ buddy: null, loadoutId: null, slots: { attack: null, defense: null, health: null } }).combatModifiers).toEqual(ZERO_COMBAT_MODIFIERS);
  });
});

describe('formatting', () => {
  it('formats basis points as a trimmed percentage', () => {
    expect(formatBonusPercent(425)).toBe('4.25%');
    expect(formatBonusPercent(650)).toBe('6.5%');
    expect(formatBonusPercent(600)).toBe('6%');
    expect(formatBonusPercent(1_200)).toBe('12%');
    expect(formatBonusPercent(50)).toBe('0.5%');
    expect(formatBonusPercent(5)).toBe('0.05%');
    expect(formatBonusPercent(16_750)).toBe('167.5%');
    expect(formatBonusPercent(0)).toBe('0%');
  });

  it('formats an item bonus without exposing its key', () => {
    expect(formatCombatBonus({ stat: 'crit_chance_bp', valueBp: 425 })).toBe('+4.25% Crit Chance');
    expect(formatCombatBonus({ stat: 'double_attack_chance_bp', valueBp: 425 })).toBe('+4.25% Double Attack');
    expect(formatCombatBonus({ stat: 'armor_penetration_bp', valueBp: 750 })).toBe('+7.5% Armor Pen');
    expect(formatCombatBonus({ stat: 'crit_damage_bonus_bp', valueBp: 1_000 })).toBe('+10% Crit Damage');
    expect(formatCombatBonus({ stat: 'lifesteal_bp', valueBp: 275 })).toBe('+2.75% Lifesteal');
  });

  it('loadout rows omit zeros and show Crit Damage as the total multiplier', () => {
    expect(combatModifierRows(ZERO_COMBAT_MODIFIERS)).toEqual([]);
    expect(combatModifierRows(null)).toEqual([]);
    expect(
      combatModifierRows({ critChanceBp: 975, critDamageBonusBp: 1_750, doubleAttackChanceBp: 400, armorPenetrationBp: 600, lifestealBp: 250 }),
    ).toEqual([
      { key: 'critChanceBp', label: 'Crit', value: '9.75%' },
      { key: 'critDamageBonusBp', label: 'Crit DMG', value: '167.5%' },
      { key: 'doubleAttackChanceBp', label: 'Double', value: '4%' },
      { key: 'armorPenetrationBp', label: 'Armor Pen', value: '6%' },
      { key: 'lifestealBp', label: 'Lifesteal', value: '2.5%' },
    ]);
    expect(combatModifierRows({ ...ZERO_COMBAT_MODIFIERS, lifestealBp: 275 })).toEqual([{ key: 'lifestealBp', label: 'Lifesteal', value: '2.75%' }]);
  });
});
