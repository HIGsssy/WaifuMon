/**
 * The managed equipment roll-rule document (Equipment 3.0, E3-B), pure:
 * bootstrap from the shipped catalogue, the legacy adapter, every validation
 * rule a publishable configuration must satisfy, diffing, hashing and the
 * export/import envelope. No SSR/UR/LR balance values ship: the configurations
 * below are test fixtures only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  combatBonusCatalogueFromFile,
  EquipmentCombatBonusFileSchema,
  maxCombatBonusValueBp,
} from '../../src/modules/equipment/combatBonuses';
import {
  assignedLibraries,
  bootstrapRollRules,
  buildRollRulesExport,
  canonicalJson,
  contentHash,
  diffRollRules,
  legacyCombatBonusCatalogue,
  readRollRulesExport,
  validateRollRules,
  type AffixLibraryFacts,
  type ManagedRarityRule,
  type RollRules,
} from '../../src/modules/equipment/rollRules';
import { CONTENT_DIR } from '../helpers/fixtures';

const SHIPPED = EquipmentCombatBonusFileSchema.parse(
  JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'combatBonuses.json'), 'utf8')),
);
const ALL_SLOTS = ['attack', 'defense', 'health'] as const;

/** A valid illustrative SSR rule — test data, not balance. */
function ssr(over: Partial<ManagedRarityRule> = {}): ManagedRarityRule {
  return {
    bonusCountWeightsBp: [0, 4_000, 5_000, 1_000],
    families: [
      { stat: 'crit_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 500, maxValue: 1_000, step: 25 },
      { stat: 'lifesteal_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 100, maxValue: 200, step: 25 },
      { stat: 'flat_sp', enabled: true, slots: [...ALL_SLOTS], minValue: 10, maxValue: 20, step: 1 },
    ],
    primarySp: { chanceBp: 5_000, min: 10, max: 100, step: 5 },
    affixes: { mode: 'none' },
    ...over,
  };
}

function rules(rarities: RollRules['rarities'] = {}, over: Partial<RollRules> = {}): RollRules {
  return { ...bootstrapRollRules(SHIPPED), rarities, ...over };
}

const errorsOf = (raw: unknown, ctx = {}) => validateRollRules(raw, ctx).errors;
const LIB = (published: boolean, slots: readonly string[]): AffixLibraryFacts => ({
  published,
  slotsCovered: new Set(slots) as AffixLibraryFacts['slotsCovered'],
});

describe('bootstrap and the legacy adapter', () => {
  it('copies the shipped catalogue verbatim, with no high-rarity rules and the approved SP rails', () => {
    const body = bootstrapRollRules(SHIPPED);
    expect(body).toEqual({
      format: 'waifumon-equipment-roll-config',
      version: 2,
      legacy: SHIPPED,
      rarities: {},
      flatSpLimits: { perItemMax: 200, perLoadoutMax: 400 },
    });
    expect(body.legacy).not.toBe(SHIPPED);
    expect(validateRollRules(body, { publishedLegacy: SHIPPED })).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it('keeps N 65% × 1, R 100% × 1, SR 100% × 2 and every range and eligibility exactly', () => {
    const catalogue = legacyCombatBonusCatalogue(bootstrapRollRules(SHIPPED));
    expect(catalogue).toEqual(combatBonusCatalogueFromFile(SHIPPED));
    expect(catalogue.rarityRules).toEqual({
      N: { bonusChanceBp: 6_500, bonusCount: 1 },
      R: { bonusChanceBp: 10_000, bonusCount: 1 },
      SR: { bonusChanceBp: 10_000, bonusCount: 2 },
    });
  });

  it('hashes independently of key order', () => {
    const body = bootstrapRollRules(SHIPPED);
    const reordered = JSON.parse(JSON.stringify({ flatSpLimits: body.flatSpLimits, rarities: {}, legacy: body.legacy, version: 2, format: body.format }));
    expect(contentHash(reordered)).toBe(contentHash(body));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('N/R/SR are frozen', () => {
  it('refuses any change to the legacy block', () => {
    const changed = structuredClone(rules());
    changed.legacy.rarityRules.N.bonusChanceBp = 7_000;
    expect(errorsOf(changed, { publishedLegacy: SHIPPED })).toEqual([
      expect.objectContaining({ path: 'legacy', message: expect.stringContaining('frozen') }),
    ]);
  });

  it.each(['N', 'R', 'SR', 'EX', 'mythic'])('refuses a managed rule for %s', (rarity) => {
    expect(errorsOf({ ...rules(), rarities: { [rarity]: ssr() } }).length).toBeGreaterThan(0);
  });

  it('a legacy block that breaks its own schema (e.g. three bonuses for SR) is refused', () => {
    const broken = structuredClone(rules());
    broken.legacy.rarityRules.SR.bonusCount = 3;
    expect(errorsOf(broken).some((e) => e.path.startsWith('legacy.rarityRules.SR'))).toBe(true);
  });
});

describe('high-rarity rules', () => {
  it('accepts a complete SSR/UR/LR configuration', () => {
    const result = validateRollRules(rules({ SSR: ssr(), UR: ssr(), LR: ssr({ bonusCountWeightsBp: [0, 0, 0, 10_000] }) }), {
      publishedLegacy: SHIPPED,
      libraries: new Map(),
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['weights below 100%', [0, 4_000, 5_000, 999], 'must total exactly 10000'],
    ['weights above 100%', [1, 4_000, 5_000, 1_000], 'must total exactly 10000'],
  ])('refuses %s', (_label, weights, message) => {
    expect(errorsOf(rules({ SSR: ssr({ bonusCountWeightsBp: weights }) }))).toEqual([
      expect.objectContaining({ path: 'rarities.SSR.bonusCountWeightsBp', message: expect.stringContaining(message) }),
    ]);
  });

  it.each([
    ['a negative weight', [-1, 4_001, 5_000, 1_000]],
    ['a fractional weight', [0.5, 3_999.5, 5_000, 1_000]],
    ['a count above three', [0, 2_500, 2_500, 2_500, 2_500]],
    ['too few counts', [5_000, 5_000]],
  ])('refuses %s', (_label, weights) => {
    expect(errorsOf(rules({ SSR: ssr({ bonusCountWeightsBp: weights }) })).length).toBeGreaterThan(0);
  });

  it('refuses a count no slot can fill with distinct families', () => {
    const thin = ssr({
      bonusCountWeightsBp: [0, 0, 0, 10_000],
      families: [
        { stat: 'crit_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 500, maxValue: 1_000, step: 25 },
        { stat: 'lifesteal_bp', enabled: true, slots: ['attack'], minValue: 100, maxValue: 200, step: 25 },
        { stat: 'armor_penetration_bp', enabled: false, slots: [...ALL_SLOTS], minValue: 100, maxValue: 200, step: 25 },
      ],
      primarySp: null,
    });
    const errors = errorsOf(rules({ SSR: thin }));
    expect(errors.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/attack gear can roll up to 3 bonus\(es\) but only 2 distinct enabled families are eligible/),
        expect.stringMatching(/defense gear can roll up to 3 bonus\(es\) but only 1 distinct enabled family is eligible/),
      ]),
    );
  });

  it('a zero-weight high count does not need families', () => {
    const lean = ssr({ bonusCountWeightsBp: [5_000, 5_000, 0, 0], families: [ssr().families[0]!], primarySp: null });
    expect(errorsOf(rules({ SSR: lean }))).toEqual([]);
  });

  it('refuses duplicate families, bad ranges and values over the combat caps', () => {
    const bad = ssr({
      families: [
        { stat: 'crit_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 500, maxValue: 1_000, step: 25 },
        { stat: 'crit_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 500, maxValue: 1_000, step: 25 },
        { stat: 'lifesteal_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 300, maxValue: 200, step: 25 },
        { stat: 'double_attack_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 100, maxValue: 200, step: 30 },
        {
          stat: 'armor_penetration_bp',
          enabled: true,
          slots: [...ALL_SLOTS],
          minValue: 100,
          maxValue: maxCombatBonusValueBp('armor_penetration_bp') + 100,
          step: 100,
        },
      ],
    });
    const paths = errorsOf(rules({ SSR: bad })).map((e) => `${e.path} ${e.message}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/families\[1\]\.stat duplicate family/),
        expect.stringMatching(/families\[2\]\.maxValue must be at least minValue/),
        expect.stringMatching(/families\[3\]\.step must divide the range evenly/),
        expect.stringMatching(/families\[4\]\.maxValue must be at most .* the combat cap/),
      ]),
    );
  });

  it('refuses an unknown family, slot or unit-less shape', () => {
    expect(errorsOf(rules({ SSR: ssr({ families: [{ stat: 'dodge_bp' } as never] }) })).length).toBeGreaterThan(0);
    expect(errorsOf(rules({ SSR: ssr({ families: [{ ...ssr().families[0]!, slots: ['relic' as never] }] }) })).length).toBeGreaterThan(0);
  });
});

describe('flat SP ceilings', () => {
  it('refuses limits above the code rails, or per-copy above per-loadout', () => {
    expect(errorsOf(rules({}, { flatSpLimits: { perItemMax: 201, perLoadoutMax: 400 } })).length).toBeGreaterThan(0);
    expect(errorsOf(rules({}, { flatSpLimits: { perItemMax: 200, perLoadoutMax: 401 } })).length).toBeGreaterThan(0);
    expect(errorsOf(rules({}, { flatSpLimits: { perItemMax: 150, perLoadoutMax: 100 } }))).toEqual([
      expect.objectContaining({ path: 'flatSpLimits.perItemMax' }),
    ]);
  });

  it('refuses a flat_sp family above the per-copy cap', () => {
    const over = ssr({ families: [...ssr().families.slice(0, 2), { ...ssr().families[2]!, maxValue: 250 }], primarySp: null });
    expect(errorsOf(rules({ SSR: over }))).toEqual([
      expect.objectContaining({ path: 'rarities.SSR.families[2].maxValue', message: expect.stringContaining('per-copy flat SP cap') }),
    ]);
  });

  it('refuses primary SP that, with the largest flat_sp bonus, could pass the per-copy cap', () => {
    const over = ssr({ primarySp: { chanceBp: 10_000, min: 100, max: 190, step: 5 } });
    expect(errorsOf(rules({ SSR: over }))).toEqual([
      expect.objectContaining({ path: 'rarities.SSR.primarySp.max', message: expect.stringContaining('can reach 210') }),
    ]);
    // Within a lowered configured cap too.
    expect(
      errorsOf(rules({ SSR: ssr() }, { flatSpLimits: { perItemMax: 100, perLoadoutMax: 300 } })).map((e) => e.path),
    ).toContain('rarities.SSR.primarySp.max');
  });

  it('refuses a malformed primary SP rule', () => {
    expect(errorsOf(rules({ SSR: ssr({ primarySp: { chanceBp: 10_001, min: 1, max: 1, step: 1 } }) })).length).toBeGreaterThan(0);
    expect(errorsOf(rules({ SSR: ssr({ primarySp: { chanceBp: 5_000, min: 10, max: 15, step: 4 } }) }))).toEqual([
      expect.objectContaining({ path: 'rarities.SSR.primarySp.step' }),
    ]);
  });

  it('warns — never refuses — when a full loadout would reach a cap', () => {
    const heavy = ssr({
      families: [
        { stat: 'crit_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 1_500, maxValue: 2_000, step: 100 },
        { stat: 'lifesteal_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 100, maxValue: 200, step: 25 },
        { stat: 'double_attack_chance_bp', enabled: true, slots: [...ALL_SLOTS], minValue: 100, maxValue: 200, step: 25 },
      ],
      primarySp: { chanceBp: 10_000, min: 100, max: 150, step: 10 },
    });
    const result = validateRollRules(rules({ SSR: heavy }));
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('crit_chance_bp'),
        expect.stringContaining('three max-SP copies (450) would reach the loadout cap of 400'),
      ]),
    );
  });
});

describe('affix library assignments', () => {
  const ctx = (libraries: Record<string, AffixLibraryFacts>) => ({ publishedLegacy: SHIPPED, libraries: new Map(Object.entries(libraries)) });

  it('allows an affixless rarity, a shared library and a dedicated one', () => {
    const config = rules({
      SSR: ssr({ affixes: { mode: 'library', library: 'high_rarity' } }),
      UR: ssr({ affixes: { mode: 'library', library: 'high_rarity' } }),
      LR: ssr({ affixes: { mode: 'library', library: 'legendary' } }),
    });
    expect(validateRollRules(config, ctx({ high_rarity: LIB(true, ALL_SLOTS), legendary: LIB(true, ALL_SLOTS) })).errors).toEqual([]);
    expect(assignedLibraries(config)).toEqual(new Map([['high_rarity', ['SSR', 'UR']], ['legendary', ['LR']]]));
    expect(validateRollRules(rules({ SSR: ssr() }), ctx({})).errors).toEqual([]);
  });

  it.each([
    ['a missing library', {}, 'is not a managed affix library'],
    ['an unpublished library', { high_rarity: LIB(false, []) }, 'has no published revision'],
    ['a library without health affixes', { high_rarity: LIB(true, ['attack', 'defense']) }, 'has no enabled affix for health gear'],
  ])('refuses %s', (_label, libraries, message) => {
    const config = rules({ SSR: ssr({ affixes: { mode: 'library', library: 'high_rarity' } }) });
    expect(validateRollRules(config, ctx(libraries)).errors).toEqual([
      expect.objectContaining({ path: 'rarities.SSR.affixes.library', message: expect.stringContaining(message) }),
    ]);
  });

  it('refuses a filesystem path or any non-key as a library reference', () => {
    for (const library of ['../affixes.json', '/etc/passwd', 'C:\\x', 'High Rarity']) {
      expect(errorsOf(rules({ SSR: ssr({ affixes: { mode: 'library', library } }) })).length).toBeGreaterThan(0);
    }
  });
});

describe('diff', () => {
  it('lists field-level changes between two configurations', () => {
    const before = rules({ SSR: ssr() });
    const after = rules({ SSR: ssr({ bonusCountWeightsBp: [0, 5_000, 5_000, 0] }), LR: ssr() }, { flatSpLimits: { perItemMax: 150, perLoadoutMax: 400 } });
    expect(diffRollRules(before, after).map((c) => [c.path, c.kind])).toEqual([
      ['flatSpLimits', 'changed'],
      ['rarities.SSR.bonusCountWeightsBp', 'changed'],
      ['rarities.LR', 'added'],
    ]);
    expect(diffRollRules(before, before)).toEqual([]);
  });
});

describe('export / import envelope', () => {
  it('round-trips, says what it is, and detects hand edits', () => {
    const config = rules({ SSR: ssr() });
    const file = buildRollRulesExport(config, { kind: 'draft', revision: 4, exportedAt: '2026-10-27T00:00:00.000Z' });
    expect(file).toMatchObject({ format: 'waifumon-equipment-roll-config-export', version: 1, kind: 'draft', revision: 4, contentHash: contentHash(config) });
    const read = readRollRulesExport(JSON.parse(JSON.stringify(file)));
    expect(read).toEqual({ config, issues: [], handEdited: false });
    const edited = JSON.parse(JSON.stringify(file));
    edited.config.flatSpLimits.perItemMax = 100;
    expect(readRollRulesExport(edited).handEdited).toBe(true);
  });

  it('refuses a file that is not an export, including unknown envelope fields', () => {
    expect(readRollRulesExport({ format: 'waifumon-equipment', version: 2 }).issues.length).toBeGreaterThan(0);
    const file = buildRollRulesExport(rules(), { kind: 'published', revision: 1, exportedAt: 'x' });
    expect(readRollRulesExport({ ...file, path: '/srv/content/equipment/combatBonuses.json' }).issues.length).toBeGreaterThan(0);
  });
});
