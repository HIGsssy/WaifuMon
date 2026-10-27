/**
 * Equipment 3.0, phase E3-C, against PostgreSQL: the SSR/UR/LR roll engine on
 * real published rules and libraries, the per-definition roll policy
 * (migration 0072), and revision-safe delayed grants.
 *
 * Every rarity rule here is **test-only data** — nothing is balance, and no
 * production definition or affix is created. The file runs top to bottom
 * against one fresh database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapAppErrorToStatus } from '../../src/api/errors';
import { equipmentDefinitions, equipmentEvents, playerEquipment } from '../../src/db/schema';
import { buildAffixCatalogue, EquipmentAffixFileSchema } from '../../src/modules/equipment/affixCatalogue';
import type { ManagedAffixEntry } from '../../src/modules/equipment/affixLibraries';
import { createEquipmentAffixLibraryService, type EquipmentAffixLibraryService } from '../../src/modules/equipment/equipmentAffixLibraryService';
import { createEquipmentDefinitionService } from '../../src/modules/equipment/equipmentDefinitionService';
import { createEquipmentPromotionService, EquipmentImportRejectedError } from '../../src/modules/equipment/equipmentImportService';
import { createEquipmentRewardService, type EquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { rollEquipmentInstance, type EquipmentRoll } from '../../src/modules/equipment/equipmentRoll';
import {
  bootstrapEquipmentRollRules,
  createEquipmentRollRulesService,
  loadShippedCombatBonusFile,
  type EquipmentRollRulesService,
} from '../../src/modules/equipment/equipmentRollRulesService';
import { createEquipmentService, type EquipmentService } from '../../src/modules/equipment/equipmentService';
import type { ResolvedAffixLibrary } from '../../src/modules/equipment/highRarityRoll';
import type { EquipmentRollPin, ManagedFamilyRule, ManagedRarityRule, RollRules } from '../../src/modules/equipment/rollRules';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createFeatureUnlockService } from '../../src/modules/features/featureUnlockService';
import {
  EquipmentConfigInvalidError,
  EquipmentRarityLockedError,
  EquipmentRollPinMissingError,
  EquipmentRollUnavailableError,
  EquipmentValidationError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { createPlayer, expectPgError } from '../helpers/equipmentFixtures';
import { CONTENT_DIR } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const AFFIXES = buildAffixCatalogue(
  EquipmentAffixFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'affixes.json'), 'utf8'))).affixes,
);
const ALL = ['attack', 'defense', 'health'] as const;
const ACTOR = 'test-admin';

let t: TestDb;
let rules: EquipmentRollRulesService;
let libraries: EquipmentAffixLibraryService;
let equipment: EquipmentService;
let rewards: EquipmentRewardService;
const definitions = () => createEquipmentDefinitionService(t.db);
let playerId: number;

/** Fresh services over the same database — what a restarted process builds (empty caches). */
function build() {
  const featureUnlocks = createFeatureUnlockService(t.db);
  const r = createEquipmentRollRulesService({ db: t.db });
  const e = createEquipmentService({ db: t.db, featureUnlocks, getAffixes: () => AFFIXES, rollRules: r });
  const w = createEquipmentRewardService({ equipment: e, getAffixes: () => AFFIXES, featureUnlocks, rollRules: r });
  return { rules: r, equipment: e, rewards: w };
}

// ── TEST-ONLY configuration ─────────────────────────────────────────────────

const family = (stat: ManagedFamilyRule['stat'], minValue: number, maxValue: number, step: number): ManagedFamilyRule => ({
  stat,
  enabled: true,
  slots: [...ALL],
  minValue,
  maxValue,
  step,
});
const TEST_SSR: ManagedRarityRule = {
  bonusCountWeightsBp: [0, 4_000, 5_000, 1_000],
  families: [family('crit_chance_bp', 500, 700, 50), family('lifesteal_bp', 100, 200, 50), family('armor_penetration_bp', 300, 500, 100), family('flat_sp', 5, 15, 5)],
  primarySp: { chanceBp: 5_000, min: 10, max: 30, step: 10 },
  affixes: { mode: 'none' },
};
const TEST_UR: ManagedRarityRule = {
  bonusCountWeightsBp: [0, 2_000, 4_000, 4_000],
  families: [family('crit_chance_bp', 800, 1_000, 50), family('lifesteal_bp', 250, 350, 50), family('armor_penetration_bp', 600, 800, 100), family('flat_sp', 20, 30, 5)],
  primarySp: { chanceBp: 10_000, min: 40, max: 60, step: 10 },
  affixes: { mode: 'library', library: 'test_shared_affixes' },
};
const TEST_LR: ManagedRarityRule = {
  bonusCountWeightsBp: [0, 0, 2_000, 8_000],
  families: [family('crit_chance_bp', 1_100, 1_300, 50), family('lifesteal_bp', 400, 500, 50), family('armor_penetration_bp', 900, 1_100, 100), family('flat_sp', 35, 45, 5)],
  primarySp: { chanceBp: 10_000, min: 70, max: 90, step: 10 },
  affixes: { mode: 'library', library: 'test_lr_affixes' },
};
const entry = (key: string, suffix: string, slots: ManagedAffixEntry['slots'] = [...ALL]): ManagedAffixEntry => ({ key, suffix, slots, enabled: true });

const gear = (key: string, rarity: string, over: Record<string, unknown> = {}) => ({
  key,
  name: key.replace(/_/g, ' '),
  slot: 'attack',
  rarity,
  multiplierMinBp: 11_000,
  multiplierMaxBp: 13_000,
  multiplierStepBp: 500,
  ...over,
});

async function publishRules(mutate: (r: RollRules) => void) {
  const draft = await rules.draft();
  const next = structuredClone(draft.rules);
  mutate(next);
  const saved = await rules.saveDraft(next, { expectedDraftRevision: draft.draftRevision, actor: ACTOR });
  return rules.publish({ expectedDraftRevision: saved.draftRevision, actor: ACTOR });
}

async function publishLibrary(key: string, entries: ManagedAffixEntry[]) {
  const existing = await libraries.get(key).catch(() => null);
  const lib = existing ?? (await libraries.create({ key, name: key }, { actor: ACTOR }));
  const saved = await libraries.saveDraft(key, entries, { expectedDraftRevision: lib.draftRevision, actor: ACTOR });
  return libraries.publish(key, { expectedDraftRevision: saved.draftRevision, actor: ACTOR });
}

async function resolvedLibrary(key: string): Promise<ResolvedAffixLibrary> {
  const lib = await libraries.get(key);
  return { key, revision: lib.publishedRevision!, entries: lib.publishedEntries };
}

async function defRow(key: string) {
  const [row] = await t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
  return row!;
}

const props = (r: Pick<EquipmentRoll, 'rolledMultiplierBp' | 'affixKey'> & { combatBonuses?: unknown }) => ({
  rolledMultiplierBp: r.rolledMultiplierBp,
  affixKey: r.affixKey,
  combatBonuses: r.combatBonuses,
});

/** What the pure engine rolls for `key` under exactly this configuration. */
async function pureRoll(key: string, seed: number, ruleSet: RollRules, library: ResolvedAffixLibrary | null) {
  return rollEquipmentInstance(await defRow(key), { rng: seededRng(seed), affixes: AFFIXES, highRarity: { rules: ruleSet, affixLibrary: library } });
}

const grantRandom = (key: string, extra: Record<string, unknown> = {}) =>
  t.db.transaction((tx) => equipment.grantEquipment(tx, { playerId, definitionKey: key, source: { type: 'admin' }, ...extra }));

const rowById = async (id: number) => (await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, id)))[0]!;
const eventFor = async (id: number) => (await t.db.select().from(equipmentEvents).where(eq(equipmentEvents.equipmentId, id)))[0]!;
const countRows = async () => (await t.db.select({ n: sql<number>`count(*)::int` }).from(playerEquipment))[0]!.n;

beforeAll(async () => {
  t = await createTestDb();
  ({ rules, equipment, rewards } = build());
  libraries = createEquipmentAffixLibraryService({ db: t.db, getLegacyAffixes: () => AFFIXES });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await bootstrapEquipmentRollRules(t.db, loadShippedCombatBonusFile(CONTENT_DIR));
  playerId = await createPlayer(t.db);
});

afterAll(async () => {
  await t?.cleanup();
});

// ── migration 0072 ──────────────────────────────────────────────────────────

describe('migration 0072: per-definition roll policy', () => {
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'drizzle', '0072_equipment_definition_roll_policy.sql'), 'utf8');
  const runMigration = async () => {
    for (const statement of MIGRATION.split('--> statement-breakpoint')) await t.pool.query(statement);
  };

  it('every existing definition reads ineligible / no maximum — today\'s behaviour', async () => {
    const rows = await t.db.select().from(equipmentDefinitions);
    expect(rows.length).toBe(30);
    expect(rows.every((r) => r.primarySpEligible === false && r.maxAdditionalBonuses === null)).toBe(true);
  });

  it('the database pins N/R/SR to the defaults and bounds the maximum to 0–3', async () => {
    await expectPgError(
      t.db.update(equipmentDefinitions).set({ primarySpEligible: true }).where(eq(equipmentDefinitions.key, 'rusty_pipe')),
      '23514',
    );
    await expectPgError(
      t.db.update(equipmentDefinitions).set({ maxAdditionalBonuses: 1 }).where(eq(equipmentDefinitions.key, 'rusty_pipe')),
      '23514',
    );
    await t.db.insert(equipmentDefinitions).values({ ...gear('t_mig_ssr', 'SSR'), primarySpEligible: true, maxAdditionalBonuses: 3, enabled: false });
    await expectPgError(
      t.db.update(equipmentDefinitions).set({ maxAdditionalBonuses: 4 }).where(eq(equipmentDefinitions.key, 't_mig_ssr')),
      '23514',
    );
    await t.db.delete(equipmentDefinitions).where(eq(equipmentDefinitions.key, 't_mig_ssr'));
  });

  it('re-runs as a no-op over existing rows', async () => {
    const before = await t.db.select().from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.id));
    await runMigration();
    await runMigration();
    expect(await t.db.select().from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.id))).toEqual(before);
    const { rows } = await t.pool.query(
      `select count(*)::int as n from pg_constraint where conname in
         ('equipment_definitions_max_additional_bonuses_check', 'equipment_definitions_roll_policy_rarity_check')`,
    );
    expect(rows[0].n).toBe(2);
  });
});

// ── definitions ─────────────────────────────────────────────────────────────

describe('definition authoring', () => {
  it('a manual SSR definition stores its roll policy; N/R/SR may not carry one', async () => {
    const row = await definitions().create(gear('t_manual_ssr', 'SSR', { primarySpEligible: true, maxAdditionalBonuses: 2, enabled: false }));
    expect(row).toMatchObject({ primarySpEligible: true, maxAdditionalBonuses: 2 });
    await expect(definitions().create(gear('t_bad_n', 'N', { multiplierMinBp: 4_000, multiplierMaxBp: 4_000, primarySpEligible: true }))).rejects.toBeInstanceOf(EquipmentValidationError);
    await expect(definitions().create(gear('t_bad_sr', 'SR', { multiplierMinBp: 4_000, multiplierMaxBp: 4_000, maxAdditionalBonuses: 1 }))).rejects.toBeInstanceOf(EquipmentValidationError);
  });

  it('package v3 round-trips the policy; v2 still imports and may not name it', async () => {
    const promotion = createEquipmentPromotionService({ db: t.db });
    const exported = await promotion.exportPackage({ keys: ['t_manual_ssr'] });
    expect(exported.version).toBe(3);
    expect(exported.definitions[0]).toMatchObject({ primarySpEligible: true, maxAdditionalBonuses: 2 });

    const v3 = { ...exported, definitions: [{ ...exported.definitions[0]!, key: 't_imported_ur', rarity: 'UR' }] };
    const applied = await promotion.applyImport(JSON.parse(JSON.stringify(v3)));
    expect(applied.plan.counts.create).toBe(1);
    expect(await defRow('t_imported_ur')).toMatchObject({ rarity: 'UR', primarySpEligible: true, maxAdditionalBonuses: 2 });

    const v2 = { format: 'waifumon-equipment', version: 2, definitions: [gear('t_v2_ssr', 'SSR', { enabled: false })] };
    await promotion.applyImport(v2);
    expect(await defRow('t_v2_ssr')).toMatchObject({ primarySpEligible: false, maxAdditionalBonuses: null });
    await expect(
      promotion.previewImport({ ...v2, definitions: [gear('t_v2_bad', 'SSR', { maxAdditionalBonuses: 1 })] }),
    ).rejects.toThrow(/require a version 3 package/);
  });
});

// ── high-rarity rolls on published rules ────────────────────────────────────

describe('SSR, UR and LR random grants', () => {
  let sharedRevision: number;

  beforeAll(async () => {
    await publishLibrary('test_shared_affixes', [entry('t_oath', 'of the Test Oath'), entry('t_edge', 'of the Test Edge', ['attack'])]);
    await publishLibrary('test_lr_affixes', [entry('t_crown', 'of the Test Crown')]);
    await publishRules((r) => {
      r.rarities = { SSR: TEST_SSR, UR: TEST_UR, LR: TEST_LR };
    });
    sharedRevision = (await libraries.get('test_shared_affixes')).publishedRevision!;
    for (const [key, rarity] of [['t_ssr', 'SSR'], ['t_ur', 'UR'], ['t_lr', 'LR']] as const) {
      await definitions().create(gear(key, rarity, { primarySpEligible: true }));
    }
  });

  it.each([
    ['t_ssr', null],
    ['t_ur', 'test_shared_affixes'],
    ['t_lr', 'test_lr_affixes'],
  ] as const)('%s rolls exactly what the engine rolls under the published revision, and stores it', async (key, library) => {
    const published = await rules.published();
    const lib = library ? await resolvedLibrary(library) : null;
    for (const seed of [1, 42, 9_001]) {
      const expected = await pureRoll(key, seed, published.rules, lib);
      const result = await grantRandom(key, { rollSeed: seed });
      const stored = await rowById(result.newInstanceIds[0]!);
      expect(props(stored)).toEqual(props(expected));
      expect(stored.rolledProperties).toEqual({
        ...(expected.flatSp ? { flatSp: expected.flatSp } : {}),
        ...(expected.affixSnapshot ? { affixSuffix: expected.affixSnapshot.suffix, affixLibrary: library } : {}),
      });
      expect(result.instances[0]!.combatBonuses).toEqual(expected.combatBonuses);
      const event = await eventFor(stored.id);
      expect(event.metadata).toMatchObject({
        rollRulesRevision: published.revision,
        rollRulesPinned: false,
        affixLibrary: lib ? { key: library, revision: lib.revision } : null,
      });
    }
  });

  it('UR and LR always carry primary SP here (100%); stored SP feeds the effective-SP math', async () => {
    const result = await grantRandom('t_lr', { rollSeed: 5 });
    const stored = await rowById(result.newInstanceIds[0]!);
    expect((stored.rolledProperties as { flatSp: number }).flatSp).toBeGreaterThanOrEqual(70);
    expect(result.instances[0]!.displayName).toBe('t lr of the Test Crown');
  });

  it('a grant-key replay returns the stored copy and writes nothing', async () => {
    const first = await grantRandom('t_ur', { rollSeed: 7, grantKey: 'e3c:replay' });
    const n = await countRows();
    const replay = await grantRandom('t_ur', { rollSeed: 8, grantKey: 'e3c:replay' });
    expect(replay.alreadyGranted).toBe(true);
    expect(replay.instances).toEqual(first.instances);
    expect(await countRows()).toBe(n);
  });

  it('the copy keeps its snapshotted name after its library entry is renamed and republished', async () => {
    const result = await grantRandom('t_lr', { rollSeed: 11 });
    await publishLibrary('test_lr_affixes', [entry('t_crown', 'of the Renamed Crown')]);
    const [copy] = (await equipment.listEquipment(playerId, { search: 'Test Crown', limit: 100 })).items.filter((i) => i.id === result.newInstanceIds[0]);
    expect(copy?.displayName).toBe('t lr of the Test Crown');
    // Search reads the snapshot, not the library's current text.
    expect((await equipment.listEquipment(playerId, { search: 'Renamed Crown' })).items).toEqual([]);
  });

  it('copies differing only in their snapshot never group together', async () => {
    const groups = await equipment.listEquipmentGroups(playerId, { definitionKey: 't_lr' });
    const suffixes = new Set(groups.map((g) => (g.rolledProperties as { affixSuffix?: string }).affixSuffix));
    expect(suffixes.has('of the Test Crown')).toBe(true);
    for (const g of groups) expect(g.displayName.endsWith((g.rolledProperties as { affixSuffix: string }).affixSuffix)).toBe(true);
  });

  it('a rarity the published rules do not configure is refused before anything is written', async () => {
    await publishRules((r) => {
      delete r.rarities.UR;
    });
    const n = await countRows();
    const err = await grantRandom('t_ur', { rollSeed: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentRollUnavailableError);
    expect(mapAppErrorToStatus(err as EquipmentRollUnavailableError)).toBe(409);
    expect(await countRows()).toBe(n);
    await publishRules((r) => {
      r.rarities.UR = TEST_UR;
    });
    expect(sharedRevision).toBeGreaterThan(0);
  });

  it('a maximum that leaves no rollable count is refused when enabled — at create, enable and import', async () => {
    await expect(definitions().create(gear('t_lr_capped', 'LR', { maxAdditionalBonuses: 1 }))).rejects.toBeInstanceOf(EquipmentValidationError);
    await definitions().create(gear('t_lr_capped', 'LR', { maxAdditionalBonuses: 1, enabled: false }));
    await expect(definitions().setEnabled('t_lr_capped', true)).rejects.toThrow(/could never roll/);
    const promotion = createEquipmentPromotionService({ db: t.db });
    const pkg = { format: 'waifumon-equipment', version: 3, definitions: [gear('t_lr_capped_2', 'LR', { maxAdditionalBonuses: 1 })] };
    await expect(promotion.applyImport(pkg)).rejects.toBeInstanceOf(EquipmentImportRejectedError);
    // A capped definition that the rule *can* serve is fine.
    await definitions().create(gear('t_lr_capped_ok', 'LR', { maxAdditionalBonuses: 2, primarySpEligible: false }));
    const result = await grantRandom('t_lr_capped_ok', { rollSeed: 3 });
    expect(result.instances[0]!.combatBonuses).toHaveLength(2);
    expect((await rowById(result.newInstanceIds[0]!)).rolledProperties).not.toHaveProperty('flatSp');
  });

  it('publishing rules that would strand an enabled definition is refused', async () => {
    const draft = await rules.draft();
    const next = structuredClone(draft.rules);
    next.rarities.LR = { ...TEST_LR, bonusCountWeightsBp: [0, 0, 0, 10_000] };
    const saved = await rules.saveDraft(next, { expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    await expect(rules.publish({ expectedDraftRevision: saved.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    const back = await rules.draft();
    await rules.saveDraft((await rules.published()).rules, { expectedDraftRevision: back.draftRevision, actor: ACTOR });
  });

  it('roll policy edits change future grants only; rarity stays locked once owned', async () => {
    const [owned] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.definitionId, (await defRow('t_ssr')).id)).limit(1);
    const current = await defRow('t_ssr');
    const input = { ...gear('t_ssr', 'SSR'), name: current.name, primarySpEligible: false, maxAdditionalBonuses: 1 };
    await definitions().update('t_ssr', input);
    expect(await rowById(owned!.id)).toEqual(owned);
    await expect(definitions().update('t_ssr', { ...input, rarity: 'UR' })).rejects.toBeInstanceOf(EquipmentRarityLockedError);
    const after = await grantRandom('t_ssr', { rollSeed: 1 });
    expect(after.instances[0]!.combatBonuses).toHaveLength(1);
  });

  it('published flat SP limits are what the live clamp reads', async () => {
    expect(await rules.flatSpLimits(t.db)).toEqual({ perItemMax: 200, perLoadoutMax: 400 });
    await publishRules((r) => {
      r.flatSpLimits = { perItemMax: 200, perLoadoutMax: 350 };
    });
    expect(await rules.flatSpLimits(t.db)).toEqual({ perItemMax: 200, perLoadoutMax: 350 });
  });

  it('existing reward selectors still never reach an enabled SSR/UR/LR definition', async () => {
    const eligible = await t.db.transaction((tx) => rewards.eligibleDefinitions(tx, {}));
    expect(eligible.length).toBeGreaterThan(0);
    expect(new Set(eligible.map((d) => d.rarity))).toEqual(new Set(['N', 'R', 'SR']));
    for (const slot of ALL) {
      const bySlot = await t.db.transaction((tx) => rewards.eligibleDefinitions(tx, { slot }));
      expect(bySlot.every((d) => ['N', 'R', 'SR'].includes(d.rarity))).toBe(true);
    }
  });
});

// ── revision-safe delayed grants ────────────────────────────────────────────

describe('a reward pinned under revision A and paid after B publishes', () => {
  let pin: EquipmentRollPin;
  let rulesA: RollRules;
  let libraryA: ResolvedAffixLibrary;

  beforeAll(async () => {
    pin = (await t.db.transaction((tx) => rewards.pinRollConfiguration!(tx)))!;
    rulesA = (await rules.published()).rules;
    libraryA = await resolvedLibrary('test_shared_affixes');
    expect(pin).toEqual({
      rulesRevision: (await rules.published()).revision,
      affixLibraryRevisions: { test_lr_affixes: expect.any(Number), test_shared_affixes: libraryA.revision },
    });
    // Revision B: new UR ranges and weights, and a changed shared library.
    await publishLibrary('test_shared_affixes', [entry('t_oath', 'of the Changed Oath'), entry('t_new', 'of Something New')]);
    await publishRules((r) => {
      r.rarities.UR = {
        ...TEST_UR,
        bonusCountWeightsBp: [0, 10_000, 0, 0],
        families: TEST_UR.families.map((f) => ({ ...f, minValue: f.maxValue })),
        primarySp: { chanceBp: 10_000, min: 60, max: 60, step: 10 },
      };
    });
  });

  it('rolls exactly as revision A and library revision A would, whatever B says', async () => {
    const seed = 2_024;
    const expectedA = await pureRoll('t_ur', seed, rulesA, libraryA);
    const expectedB = await pureRoll('t_ur', seed, (await rules.published()).rules, await resolvedLibrary('test_shared_affixes'));
    expect(props(expectedA)).not.toEqual(props(expectedB));

    const pinned = await t.db.transaction((tx) =>
      rewards.grantChosenEquipmentReward(tx, { playerId, definitionKey: 't_ur', rollSeed: seed, rollPin: pin, promised: true, source: { type: 'dungeon', key: 'e3c' }, grantKey: 'e3c:pinned' }),
    );
    expect(props(pinned)).toEqual(props(expectedA));
    const stored = await rowById(pinned.equipmentId);
    expect((stored.rolledProperties as { affixSuffix?: string }).affixSuffix).toBe(expectedA.affixSnapshot?.suffix);
    expect((await eventFor(stored.id)).metadata).toMatchObject({
      rollRulesRevision: pin.rulesRevision,
      rollRulesPinned: true,
      affixLibrary: { key: 'test_shared_affixes', revision: libraryA.revision },
    });

    const live = await t.db.transaction((tx) =>
      rewards.grantChosenEquipmentReward(tx, { playerId, definitionKey: 't_ur', rollSeed: seed, promised: true, source: { type: 'dungeon', key: 'e3c' } }),
    );
    expect(props(live)).toEqual(props(expectedB));
  });

  it('a duplicate claim and a claim after a restart return the one copy; a fresh process re-rolls identically', async () => {
    const n = await countRows();
    const restarted = build();
    const again = await t.db.transaction((tx) =>
      restarted.rewards.grantChosenEquipmentReward(tx, { playerId, definitionKey: 't_ur', rollSeed: 2_024, rollPin: pin, promised: true, source: { type: 'dungeon', key: 'e3c' }, grantKey: 'e3c:pinned' }),
    );
    expect(again.alreadyGranted).toBe(true);
    expect(await countRows()).toBe(n);
    // A rolled-back first attempt, retried after a restart: same seed + pin → same copy.
    const retried = await t.db.transaction((tx) =>
      restarted.equipment.grantEquipment(tx, { playerId, definitionKey: 't_ur', rollSeed: 2_024, rollPin: pin, source: { type: 'dungeon' }, grantKey: 'e3c:pinned:retry' }),
    );
    expect(props(retried.instances[0]!)).toEqual(props(again));
  });

  it('two concurrent payouts of one reward create one copy', async () => {
    const pay = () =>
      t.db.transaction((tx) =>
        equipment.grantEquipment(tx, { playerId, definitionKey: 't_ur', rollSeed: 3, rollPin: pin, source: { type: 'dungeon' }, grantKey: 'e3c:race' }),
      );
    const [a, b] = await Promise.all([pay(), pay()]);
    expect(a.instances[0]!.id).toBe(b.instances[0]!.id);
    expect(await t.db.select().from(playerEquipment).where(eq(playerEquipment.grantKey, 'e3c:race:0'))).toHaveLength(1);
  });

  it('a pinned revision that is missing fails closed and writes nothing — never the latest instead', async () => {
    const n = await countRows();
    const missingRules = { ...pin, rulesRevision: 9_999 };
    const err = await t.db
      .transaction((tx) => equipment.grantEquipment(tx, { playerId, definitionKey: 't_ur', rollSeed: 1, rollPin: missingRules, source: { type: 'dungeon' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentRollPinMissingError);
    expect(mapAppErrorToStatus(err as EquipmentRollPinMissingError)).toBe(503);
    const missingLibrary = { ...pin, affixLibraryRevisions: { ...pin.affixLibraryRevisions, test_shared_affixes: 9_999 } };
    await expect(
      t.db.transaction((tx) => equipment.grantEquipment(tx, { playerId, definitionKey: 't_ur', rollSeed: 1, rollPin: missingLibrary, source: { type: 'dungeon' } })),
    ).rejects.toBeInstanceOf(EquipmentRollPinMissingError);
    const unpinnedLibrary = { ...pin, affixLibraryRevisions: {} };
    await expect(
      t.db.transaction((tx) => equipment.grantEquipment(tx, { playerId, definitionKey: 't_ur', rollSeed: 1, rollPin: unpinnedLibrary, source: { type: 'dungeon' } })),
    ).rejects.toBeInstanceOf(EquipmentRollPinMissingError);
    expect(await countRows()).toBe(n);
  });

  it('N/R/SR roll identically pinned or not, under any revision', async () => {
    for (const key of ['rusty_pipe', 'combat_knife', 'railcarbine']) {
      for (const seed of [1, 99]) {
        const pinned = await grantRandom(key, { rollSeed: seed, rollPin: pin });
        const live = await grantRandom(key, { rollSeed: seed });
        expect(props(pinned.instances[0]!)).toEqual(props(live.instances[0]!));
        expect((await rowById(pinned.newInstanceIds[0]!)).rolledProperties).toEqual({});
      }
    }
  });

  it('a payout with no pin (every pre-E3-C snapshot) reads the live published revision', async () => {
    const result = await grantRandom('combat_knife', { rollSeed: 4 });
    const event = await eventFor(result.newInstanceIds[0]!);
    expect(event.metadata).toMatchObject({ rollRulesRevision: (await rules.published()).revision, rollRulesPinned: false });
  });

  it('fixed grants never read rules or pins', async () => {
    const result = await t.db.transaction((tx) =>
      equipment.grantEquipment(tx, {
        playerId,
        definitionKey: 't_ur',
        source: { type: 'admin' },
        roll: { kind: 'fixed', rolledMultiplierBp: 12_000, affixKey: null, flatSp: 20, combatBonuses: [{ stat: 'flat_sp', valueBp: 11 }] },
        rollPin: { rulesRevision: 9_999, affixLibraryRevisions: {} },
      }),
    );
    const stored = await rowById(result.newInstanceIds[0]!);
    expect(stored).toMatchObject({ rolledMultiplierBp: 12_000, rolledProperties: { flatSp: 20 }, combatBonuses: [{ stat: 'flat_sp', valueBp: 11 }] });
    const events = await t.db.select().from(equipmentEvents).where(and(eq(equipmentEvents.equipmentId, stored.id)));
    expect(events[0]!.metadata).toMatchObject({ rollKind: 'fixed', rollRulesRevision: null });
  });
});
