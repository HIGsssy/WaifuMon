/**
 * Equipment 3.0, phase E3-C: the SSR/UR/LR distribution roll, pure.
 *
 * Every rule below is **test-only data** built for the engine — none of it is
 * balance, and none of it ships. The legacy N/R/SR roll is covered by the
 * 6,000-roll golden gate (`equipmentRollGolden.test.ts`); this file also
 * proves that handing the high-rarity context to an N/R/SR roll changes
 * nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAffixCatalogue, EquipmentAffixFileSchema } from '../../src/modules/equipment/affixCatalogue';
import type { ManagedAffixEntry } from '../../src/modules/equipment/affixLibraries';
import { EquipmentCombatBonusFileSchema, type CombatBonus } from '../../src/modules/equipment/combatBonuses';
import { flatSpOf, itemFlatSpOf, loadoutFlatSpCeiling } from '../../src/modules/equipment/equipmentMath';
import { equipmentDisplayName, rollEquipmentInstance, rolledPropertiesOf } from '../../src/modules/equipment/equipmentRoll';
import {
  analyseHighRarityRoll,
  bonusCountOutcomes,
  definitionRollPolicyIssues,
  planHighRarityRoll,
  type HighRarityDefinition,
  type HighRarityRollContext,
  type ResolvedAffixLibrary,
} from '../../src/modules/equipment/highRarityRoll';
import {
  bootstrapRollRules,
  legacyCombatBonusCatalogue,
  readEquipmentRollPin,
  type ManagedFamilyRule,
  type ManagedRarityRule,
  type RollRules,
} from '../../src/modules/equipment/rollRules';
import { EquipmentAffixPoolEmptyError, EquipmentRollUnavailableError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';
import { CONTENT_DIR } from '../helpers/fixtures';

const SHIPPED = EquipmentCombatBonusFileSchema.parse(
  JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'combatBonuses.json'), 'utf8')),
);
const LEGACY_AFFIXES = buildAffixCatalogue(
  EquipmentAffixFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'affixes.json'), 'utf8'))).affixes,
);
const ALL = ['attack', 'defense', 'health'] as const;

// ── test-only configuration builders ────────────────────────────────────────

const family = (stat: ManagedFamilyRule['stat'], minValue: number, maxValue: number, step: number, over: Partial<ManagedFamilyRule> = {}): ManagedFamilyRule => ({
  stat,
  enabled: true,
  slots: [...ALL],
  minValue,
  maxValue,
  step,
  ...over,
});

/** TEST-ONLY rarity rule. Distinct ranges per rarity so magnitudes prove which rarity they came from. */
const TEST_RULES: Record<'SSR' | 'UR' | 'LR', ManagedRarityRule> = {
  SSR: {
    bonusCountWeightsBp: [0, 4_000, 5_000, 1_000],
    families: [
      family('crit_chance_bp', 500, 700, 50),
      family('crit_damage_bonus_bp', 1_000, 1_400, 100),
      family('lifesteal_bp', 100, 200, 50),
      family('flat_sp', 5, 15, 5),
    ],
    primarySp: { chanceBp: 5_000, min: 10, max: 30, step: 10 },
    affixes: { mode: 'none' },
  },
  UR: {
    bonusCountWeightsBp: [0, 2_000, 4_000, 4_000],
    families: [
      family('crit_chance_bp', 800, 1_000, 50),
      family('crit_damage_bonus_bp', 1_500, 1_900, 100),
      family('lifesteal_bp', 250, 350, 50),
      family('flat_sp', 20, 30, 5),
    ],
    primarySp: { chanceBp: 7_500, min: 40, max: 60, step: 10 },
    affixes: { mode: 'library', library: 'test_shared' },
  },
  LR: {
    bonusCountWeightsBp: [0, 0, 2_000, 8_000],
    families: [
      family('crit_chance_bp', 1_100, 1_300, 50),
      family('crit_damage_bonus_bp', 2_000, 2_400, 100),
      family('lifesteal_bp', 400, 500, 50),
      family('flat_sp', 35, 45, 5),
    ],
    primarySp: { chanceBp: 10_000, min: 70, max: 90, step: 10 },
    affixes: { mode: 'library', library: 'test_lr_only' },
  },
};

function rulesWith(rarities: Partial<Record<'SSR' | 'UR' | 'LR', ManagedRarityRule>> = TEST_RULES): RollRules {
  return { ...bootstrapRollRules(SHIPPED), rarities: structuredClone(rarities) };
}

const entry = (key: string, suffix: string, slots: ManagedAffixEntry['slots'] = [...ALL], enabled = true): ManagedAffixEntry => ({ key, suffix, slots, enabled });
const SHARED: ResolvedAffixLibrary = {
  key: 'test_shared',
  revision: 3,
  entries: [entry('t_oath', 'of the Test Oath'), entry('t_blade', 'of Test Blades', ['attack']), entry('t_retired', 'of Retirement', [...ALL], false)],
};
const LR_ONLY: ResolvedAffixLibrary = { key: 'test_lr_only', revision: 1, entries: [entry('t_crown', 'of the Test Crown')] };

const ctx = (rules: RollRules, affixLibrary: ResolvedAffixLibrary | null = null): HighRarityRollContext => ({ rules, affixLibrary });

const def = (rarity: string, over: Partial<HighRarityDefinition> = {}): HighRarityDefinition => ({
  key: `test_${rarity.toLowerCase()}`,
  slot: 'attack',
  rarity,
  multiplierMinBp: 11_000,
  multiplierMaxBp: 13_000,
  multiplierStepBp: 500,
  primarySpEligible: true,
  maxAdditionalBonuses: null,
  ...over,
});

/** An RNG that records every call: `[method, min, max, result]`. */
function recording(seed: number): Rng & { calls: [string, number, number, number][] } {
  const inner = seededRng(seed);
  const rng = {
    calls: [] as [string, number, number, number][],
    next: () => {
      const v = inner.next();
      rng.calls.push(['next', 0, 0, v]);
      return v;
    },
    intInclusive: (a: number, b: number) => {
      const v = inner.intInclusive(a, b);
      rng.calls.push(['int', a, b, v]);
      return v;
    },
  };
  return rng;
}

const roll = (d: HighRarityDefinition, c: HighRarityRollContext, rng: Rng) =>
  rollEquipmentInstance(d, { rng, affixes: LEGACY_AFFIXES, combatBonuses: legacyCombatBonusCatalogue(c.rules), highRarity: c });

const SAMPLES = 4_000;

// ── tests ───────────────────────────────────────────────────────────────────

describe('SSR, UR and LR roll from their own published rule', () => {
  const contexts = { SSR: ctx(rulesWith()), UR: ctx(rulesWith(), SHARED), LR: ctx(rulesWith(), LR_ONLY) };

  it.each(['SSR', 'UR', 'LR'] as const)('%s: every magnitude lies in that rarity\'s own range and step', (rarity) => {
    const rule = TEST_RULES[rarity];
    for (let seed = 1; seed <= 300; seed += 1) {
      const r = roll(def(rarity), contexts[rarity], seededRng(seed));
      expect([11_000, 11_500, 12_000, 12_500, 13_000]).toContain(r.rolledMultiplierBp);
      for (const bonus of r.combatBonuses) {
        const f = rule.families.find((x) => x.stat === bonus.stat)!;
        expect(bonus.valueBp).toBeGreaterThanOrEqual(f.minValue);
        expect(bonus.valueBp).toBeLessThanOrEqual(f.maxValue);
        expect((bonus.valueBp - f.minValue) % f.step).toBe(0);
      }
      if (r.flatSp) {
        expect(r.flatSp).toBeGreaterThanOrEqual(rule.primarySp!.min);
        expect(r.flatSp).toBeLessThanOrEqual(rule.primarySp!.max);
        expect((r.flatSp - rule.primarySp!.min) % rule.primarySp!.step).toBe(0);
      }
    }
  });

  it('the same seed and configuration always roll the same copy', () => {
    for (const rarity of ['SSR', 'UR', 'LR'] as const) {
      const a = roll(def(rarity), contexts[rarity], seededRng(77));
      const b = roll(def(rarity), contexts[rarity], seededRng(77));
      expect(a).toEqual(b);
    }
  });

  it('never stores a family twice, at any count, over many seeds', () => {
    for (let seed = 1; seed <= SAMPLES; seed += 1) {
      const r = roll(def('LR'), contexts.LR, seededRng(seed));
      expect(new Set(r.combatBonuses.map((b) => b.stat)).size).toBe(r.combatBonuses.length);
      expect(r.combatBonuses.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('bonus-count distribution', () => {
  it.each([0, 1, 2, 3])('a rule that only allows %i bonus(es) rolls exactly that many, with no count draw', (count) => {
    const weights = [0, 0, 0, 0];
    weights[count] = 10_000;
    const rules = rulesWith({ SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: weights, primarySp: null } });
    for (let seed = 1; seed <= 50; seed += 1) {
      const rng = recording(seed);
      const r = roll(def('SSR'), ctx(rules), rng);
      expect(r.combatBonuses).toHaveLength(count);
      // multiplier + `count` selections + `count` magnitudes; nothing for the count itself
      expect(rng.calls).toHaveLength(1 + 2 * count);
      expect(rng.calls.some(([, a, b]) => a === 1 && b === 10_000)).toBe(false);
    }
  });

  it('matches its weights within statistical tolerance', () => {
    const c = ctx(rulesWith());
    const seen = [0, 0, 0, 0];
    for (let seed = 1; seed <= SAMPLES * 2; seed += 1) seen[roll(def('SSR', { primarySpEligible: false }), c, seededRng(seed)).combatBonuses.length]! += 1;
    const n = SAMPLES * 2;
    expect(seen[0]).toBe(0);
    expect(seen[1]! / n).toBeCloseTo(0.4, 1);
    expect(seen[2]! / n).toBeCloseTo(0.5, 1);
    expect(seen[3]! / n).toBeCloseTo(0.1, 1);
  });

  it('a definition maximum excludes higher counts and renormalises the rest — never clamps', () => {
    // SSR {0:0, 1:4000, 2:5000, 3:1000}, max 2 → {1: 4/9, 2: 5/9}
    expect(bonusCountOutcomes([0, 4_000, 5_000, 1_000], 2)).toEqual([
      { count: 1, weightBp: 4_000 },
      { count: 2, weightBp: 5_000 },
    ]);
    const c = ctx(rulesWith());
    const capped = def('SSR', { maxAdditionalBonuses: 2, primarySpEligible: false });
    const analysis = analyseHighRarityRoll(capped, c);
    expect(analysis.ok && analysis.analysis.counts.map((o) => o.probability)).toEqual([4 / 9, 5 / 9]);

    const seen = [0, 0, 0, 0];
    for (let seed = 1; seed <= SAMPLES * 2; seed += 1) seen[roll(capped, c, seededRng(seed)).combatBonuses.length]! += 1;
    expect(seen[3]).toBe(0);
    // Clamping would give P(2) = 0.6; renormalising gives 0.556.
    expect(seen[2]! / (SAMPLES * 2)).toBeCloseTo(5 / 9, 1);
    expect(Math.abs(seen[2]! / (SAMPLES * 2) - 5 / 9)).toBeLessThan(0.025);
  });

  it('a maximum of 0 rolls no bonuses and draws nothing for them', () => {
    const rules = rulesWith({ SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: [2_000, 8_000, 0, 0], primarySp: null } });
    const rng = recording(5);
    const r = roll(def('SSR', { maxAdditionalBonuses: 0 }), ctx(rules), rng);
    expect(r.combatBonuses).toEqual([]);
    expect(rng.calls).toHaveLength(1);
  });

  it('a maximum that leaves no positive weight is refused before any draw', () => {
    // A rarity that only gives two or three bonuses cannot roll gear capped at one.
    const rules = rulesWith({ LR: TEST_RULES.LR });
    const capped = def('LR', { maxAdditionalBonuses: 1 });
    const rng = recording(1);
    expect(() => roll(capped, ctx(rules, LR_ONLY), rng)).toThrow(EquipmentRollUnavailableError);
    expect(rng.calls).toHaveLength(0);
    expect(definitionRollPolicyIssues(capped, rules)).toHaveLength(1);
    // A valid lower count makes it rollable again.
    const withOne = rulesWith({ LR: { ...TEST_RULES.LR, bonusCountWeightsBp: [0, 1_000, 2_000, 7_000] } });
    expect(definitionRollPolicyIssues(capped, withOne)).toEqual([]);
    expect(roll(capped, ctx(withOne, LR_ONLY), seededRng(1)).combatBonuses).toHaveLength(1);
  });
});

describe('affixes', () => {
  it('affixless rolls carry no affix and draw nothing for one', () => {
    const rules = rulesWith({ SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: [10_000, 0, 0, 0], primarySp: null } });
    const rng = recording(9);
    const r = roll(def('SSR'), ctx(rules), rng);
    expect(r.affixKey).toBeNull();
    expect(r.affixSnapshot).toBeUndefined();
    expect(rng.calls).toHaveLength(1);
    expect(rolledPropertiesOf(r)).toEqual({});
  });

  it('a shared library serves several rarities; only enabled, slot-eligible entries are drawn', () => {
    const rules = rulesWith({ SSR: { ...TEST_RULES.SSR, affixes: { mode: 'library', library: 'test_shared' } }, UR: TEST_RULES.UR });
    const seen = { attack: new Set<string>(), defense: new Set<string>() };
    for (let seed = 1; seed <= 400; seed += 1) {
      for (const rarity of ['SSR', 'UR'] as const) {
        seen.attack.add(roll(def(rarity, { slot: 'attack' }), ctx(rules, SHARED), seededRng(seed)).affixKey!);
        seen.defense.add(roll(def(rarity, { slot: 'defense' }), ctx(rules, SHARED), seededRng(seed)).affixKey!);
      }
    }
    expect(seen.attack).toEqual(new Set(['t_oath', 't_blade']));
    expect(seen.defense).toEqual(new Set(['t_oath']));
  });

  it('a dedicated library is used for its rarity, and its suffix is snapshotted for display', () => {
    const r = roll(def('LR'), ctx(rulesWith(), LR_ONLY), seededRng(3));
    expect(r.affixKey).toBe('t_crown');
    expect(r.affixSnapshot).toEqual({ library: 'test_lr_only', libraryRevision: 1, suffix: 'of the Test Crown' });
    const props = rolledPropertiesOf(r);
    expect(props).toMatchObject({ affixSuffix: 'of the Test Crown', affixLibrary: 'test_lr_only' });
    // The legacy catalogue does not know the key; the snapshot renders it.
    expect(equipmentDisplayName('Relic', r.affixKey, LEGACY_AFFIXES, props)).toBe('Relic of the Test Crown');
  });

  it.each([
    ['no library given', null],
    ['another library given', SHARED],
    ['a library with nothing for the slot', { key: 'test_lr_only', revision: 2, entries: [entry('t_crown', 'of the Test Crown', ['defense'])] }],
  ] as const)('fails closed before any draw with %s', (_label, library) => {
    const rng = recording(1);
    expect(() => roll(def('LR'), ctx(rulesWith(), library as ResolvedAffixLibrary | null), rng)).toThrow(EquipmentRollUnavailableError);
    expect(rng.calls).toHaveLength(0);
  });
});

describe('primary flat SP', () => {
  const only = (sp: ManagedRarityRule['primarySp']) =>
    rulesWith({ SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: [10_000, 0, 0, 0], primarySp: sp } });

  it('0% never rolls it and draws nothing', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = recording(seed);
      const r = roll(def('SSR'), ctx(only({ chanceBp: 0, min: 10, max: 30, step: 10 })), rng);
      expect(r.flatSp).toBeUndefined();
      expect(rng.calls).toHaveLength(1);
    }
  });

  it('100% always rolls it in range, with no gate draw', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rng = recording(seed);
      const r = roll(def('SSR'), ctx(only({ chanceBp: 10_000, min: 10, max: 30, step: 10 })), rng);
      expect([10, 20, 30]).toContain(r.flatSp);
      expect(rng.calls.map(([, a, b]) => [a, b])).toEqual([[0, 4], [0, 2]]);
      expect(rolledPropertiesOf(r)).toEqual({ flatSp: r.flatSp });
    }
  });

  it('an intermediate chance rolls it at that rate', () => {
    const c = ctx(only({ chanceBp: 2_500, min: 10, max: 30, step: 10 }));
    let hits = 0;
    for (let seed = 1; seed <= SAMPLES * 2; seed += 1) if (roll(def('SSR'), c, seededRng(seed)).flatSp) hits += 1;
    expect(hits / (SAMPLES * 2)).toBeCloseTo(0.25, 1);
    expect(Math.abs(hits / (SAMPLES * 2) - 0.25)).toBeLessThan(0.02);
  });

  it('a definition that is not eligible draws nothing for it', () => {
    // LR's chance is 100%: the eligible twin draws exactly one more (the value, no gate).
    const ineligible = recording(4);
    const eligible = recording(4);
    const r = roll(def('LR', { primarySpEligible: false }), ctx(rulesWith(), LR_ONLY), ineligible);
    roll(def('LR', { primarySpEligible: true }), ctx(rulesWith(), LR_ONLY), eligible);
    expect(r.flatSp).toBeUndefined();
    expect(ineligible.calls).toEqual(eligible.calls.slice(0, -1));
    expect(eligible.calls.at(-1)!.slice(1, 3)).toEqual([0, 2]);
  });

  it('is drawn last: toggling it never moves the multiplier, affix or bonuses', () => {
    const c = ctx(rulesWith(), SHARED);
    for (let seed = 1; seed <= 300; seed += 1) {
      const without = roll(def('UR', { primarySpEligible: false }), c, seededRng(seed));
      const withSp = roll(def('UR', { primarySpEligible: true }), c, seededRng(seed));
      expect({ ...withSp, flatSp: undefined }).toEqual({ ...without, flatSp: undefined });
    }
  });
});

describe('flat SP: primary and additional', () => {
  it('additional flat_sp is selected from the pool, uses a bonus slot and its own range', () => {
    const rules = rulesWith({
      SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: [0, 10_000, 0, 0], families: [family('flat_sp', 11, 11, 1)], primarySp: null },
    });
    const r = roll(def('SSR'), ctx(rules), seededRng(1));
    expect(r.combatBonuses).toEqual([{ stat: 'flat_sp', valueBp: 11 }]);
    expect(r.flatSp).toBeUndefined();
  });

  it('primary +20 and additional +11 on one copy contribute +31 SP', () => {
    const rules = rulesWith({
      SSR: {
        ...TEST_RULES.SSR,
        bonusCountWeightsBp: [0, 10_000, 0, 0],
        families: [family('flat_sp', 11, 11, 1)],
        primarySp: { chanceBp: 10_000, min: 20, max: 20, step: 1 },
      },
    });
    const r = roll(def('SSR'), ctx(rules), seededRng(2));
    expect(r.flatSp).toBe(20);
    expect(r.combatBonuses).toEqual([{ stat: 'flat_sp', valueBp: 11 }]);
    expect(itemFlatSpOf({ rolledProperties: rolledPropertiesOf(r), combatBonuses: r.combatBonuses }).contribution).toBe(31);
  });

  it('a configuration that could put a copy over the per-copy ceiling is refused', () => {
    const rules = rulesWith({
      SSR: {
        ...TEST_RULES.SSR,
        families: [...TEST_RULES.SSR.families.slice(0, 3), family('flat_sp', 50, 150, 50)],
        primarySp: { chanceBp: 10_000, min: 100, max: 100, step: 1 },
      },
    });
    const rng = recording(1);
    expect(() => roll(def('SSR'), ctx(rules), rng)).toThrow(EquipmentRollUnavailableError);
    expect(rng.calls).toHaveLength(0);
  });

  it('the loadout ceiling clamps the sum and can be lowered, never raised, by published limits', () => {
    const copy = (primary: number, extra: number) => ({
      rolledProperties: { flatSp: primary },
      combatBonuses: [{ stat: 'flat_sp', valueBp: extra }] as CombatBonus[],
    });
    const items = [copy(150, 50), copy(150, 50), copy(100, 0)];
    expect(flatSpOf(items).equipmentBonus).toBe(400);
    expect(flatSpOf(items, { perLoadoutMax: 300 })).toMatchObject({ equipmentBonus: 300, capped: true });
    expect(loadoutFlatSpCeiling({ perLoadoutMax: 9_999 })).toBe(400);
    expect(loadoutFlatSpCeiling(null)).toBe(400);
  });
});

describe('the RNG contract', () => {
  it('draws multiplier → affix → count → families → magnitudes → primary SP, with exactly these bounds', () => {
    const rng = recording(12345);
    const r = roll(def('UR'), ctx(rulesWith(), SHARED), rng);
    const bounds = rng.calls.map(([, a, b]) => [a, b]);
    const n = r.combatBonuses.length;
    expect(bounds[0]).toEqual([0, 4]); // multiplier: (13000 − 11000) / 500
    expect(bounds[1]).toEqual([0, 1]); // two enabled attack entries in the shared library
    expect(bounds[2]).toEqual([1, 10_000]); // UR count weights 2000 + 4000 + 4000
    const selections = bounds.slice(3, 3 + n);
    expect(selections).toEqual(Array.from({ length: n }, (_, i) => [0, 3 - i]));
    expect(bounds.slice(3 + n, 3 + 2 * n).every(([a]) => a === 0)).toBe(true);
    const tail = bounds.slice(3 + 2 * n);
    expect(tail[0]).toEqual([1, 10_000]); // primary SP gate at 75%
    expect(tail.length === 1 ? r.flatSp : tail[1]).toEqual(tail.length === 1 ? undefined : [0, 2]);
    expect(rng.calls.every(([m]) => m === 'int')).toBe(true);
  });
});

describe('fail closed', () => {
  it('a rarity with no published rule cannot roll, and draws nothing', () => {
    const rng = recording(1);
    expect(() => roll(def('UR'), ctx(rulesWith({ SSR: TEST_RULES.SSR })), rng)).toThrow(/configure no UR rolls/);
    expect(rng.calls).toHaveLength(0);
  });

  it('a revision that no longer validates is refused rather than rolled from', () => {
    const broken = rulesWith({ SSR: { ...TEST_RULES.SSR, bonusCountWeightsBp: [0, 4_000, 5_000, 500] } });
    const rng = recording(1);
    const planned = planHighRarityRoll(def('SSR'), ctx(broken));
    expect(planned.ok).toBe(false);
    expect(() => roll(def('SSR'), ctx(broken), rng)).toThrow(/must total exactly 10000/);
    expect(rng.calls).toHaveLength(0);
  });

  it('without the published context SSR/UR/LR still throw the unsupported-pool error before drawing', () => {
    const rng = recording(1);
    expect(() => rollEquipmentInstance(def('SSR'), { rng, affixes: LEGACY_AFFIXES })).toThrow(EquipmentAffixPoolEmptyError);
    expect(rng.calls).toHaveLength(0);
  });
});

describe('N/R/SR are untouched by the high-rarity context', () => {
  it('the same seed rolls the identical copy with identical draws, with or without it', () => {
    const c = ctx(rulesWith(), SHARED);
    const catalogue = legacyCombatBonusCatalogue(c.rules);
    for (const rarity of ['N', 'R', 'SR']) {
      for (const slot of ALL) {
        const d = { key: `legacy_${rarity}`, slot, rarity, multiplierMinBp: 4_000, multiplierMaxBp: 6_000, multiplierStepBp: 500 };
        for (let seed = 1; seed <= 100; seed += 1) {
          const a = recording(seed);
          const b = recording(seed);
          const plain = rollEquipmentInstance(d, { rng: a, affixes: LEGACY_AFFIXES, combatBonuses: catalogue });
          const withCtx = rollEquipmentInstance(d, { rng: b, affixes: LEGACY_AFFIXES, combatBonuses: catalogue, highRarity: c });
          expect(withCtx).toEqual(plain);
          expect(b.calls).toEqual(a.calls);
          expect(rolledPropertiesOf(plain)).toEqual({});
        }
      }
    }
  });
});

describe('reward pins', () => {
  it('reads a stored pin, treats absence as unpinned and anything malformed as invalid', () => {
    expect(readEquipmentRollPin(undefined)).toBeNull();
    expect(readEquipmentRollPin(null)).toBeNull();
    expect(readEquipmentRollPin({ rulesRevision: 4, affixLibraryRevisions: { test_shared: 2 } })).toEqual({
      rulesRevision: 4,
      affixLibraryRevisions: { test_shared: 2 },
    });
    expect(readEquipmentRollPin({ rulesRevision: 0, affixLibraryRevisions: {} })).toBe('invalid');
    expect(readEquipmentRollPin({ rulesRevision: 2 })).toBe('invalid');
    expect(readEquipmentRollPin('2')).toBe('invalid');
  });
});
