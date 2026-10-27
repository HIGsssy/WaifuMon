/**
 * Equipment 3.0, phase E3-B, against PostgreSQL: database-authoritative roll
 * rules and managed affix libraries.
 *
 * The file runs top to bottom against one fresh database, so it can prove the
 * un-bootstrapped state first (grants fail closed) and then the lifecycle:
 * bootstrap once → never overwritten → draft → validate → publish → rollback,
 * libraries alongside, and live grants that read exactly one published
 * revision and roll N/R/SR exactly as the shipped catalogue did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentAdminEvents,
  equipmentAffixLibraryRevisions,
  equipmentEvents,
  equipmentRollConfigRevisions,
  playerEquipment,
} from '../../src/db/schema';
import { buildAffixCatalogue, EquipmentAffixFileSchema } from '../../src/modules/equipment/affixCatalogue';
import {
  combatBonusCatalogueFromFile,
  EquipmentCombatBonusFileSchema,
  type EquipmentCombatBonusFile,
} from '../../src/modules/equipment/combatBonuses';
import { createEquipmentAffixLibraryService, type EquipmentAffixLibraryService } from '../../src/modules/equipment/equipmentAffixLibraryService';
import { readUnknownAffixKeys } from '../../src/modules/equipment/equipmentQueries';
import { rollEquipmentInstance } from '../../src/modules/equipment/equipmentRoll';
import {
  bootstrapEquipmentRollRules,
  createEquipmentRollRulesService,
  loadShippedCombatBonusFile,
  type EquipmentRollRulesService,
} from '../../src/modules/equipment/equipmentRollRulesService';
import { createEquipmentService, type EquipmentService } from '../../src/modules/equipment/equipmentService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createFeatureUnlockService } from '../../src/modules/features/featureUnlockService';
import { mapAppErrorToStatus } from '../../src/api/errors';
import type { ManagedRarityRule, RollRules } from '../../src/modules/equipment/rollRules';
import {
  EquipmentConfigConflictError,
  EquipmentConfigInvalidError,
  EquipmentConfigStaleError,
  EquipmentRulesUnavailableError,
} from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR } from '../helpers/fixtures';
import { createPlayer, fixedRange } from '../helpers/equipmentFixtures';

const SHIPPED_FILE: EquipmentCombatBonusFile = EquipmentCombatBonusFileSchema.parse(
  JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'combatBonuses.json'), 'utf8')),
);
const AFFIXES = buildAffixCatalogue(
  EquipmentAffixFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'equipment', 'affixes.json'), 'utf8'))).affixes,
);
const ALL = ['attack', 'defense', 'health'] as const;
const ACTOR = 'admin-1';

let t: TestDb;
let rules: EquipmentRollRulesService;
let libraries: EquipmentAffixLibraryService;
let equipment: EquipmentService;
let playerId: number;

/** Illustrative SSR rule — test data, not balance. */
const ssr = (over: Partial<ManagedRarityRule> = {}): ManagedRarityRule => ({
  bonusCountWeightsBp: [0, 5_000, 5_000, 0],
  families: [
    { stat: 'crit_chance_bp', enabled: true, slots: [...ALL], minValue: 500, maxValue: 1_000, step: 25 },
    { stat: 'lifesteal_bp', enabled: true, slots: [...ALL], minValue: 100, maxValue: 200, step: 25 },
  ],
  primarySp: null,
  affixes: { mode: 'none' },
  ...over,
});

async function draftWith(mutate: (r: RollRules) => void) {
  const draft = await rules.draft();
  const next = structuredClone(draft.rules);
  mutate(next);
  return rules.saveDraft(next, { expectedDraftRevision: draft.draftRevision, actor: ACTOR });
}

async function events(kind: 'roll_rules' | 'affix_library', key?: string) {
  const rows = await t.db.select().from(equipmentAdminEvents).orderBy(asc(equipmentAdminEvents.id));
  return rows.filter((r) => r.subjectKind === kind && (key === undefined || r.subjectKey === key));
}

async function ownedRows() {
  return t.db.select().from(playerEquipment).orderBy(asc(playerEquipment.id));
}

beforeAll(async () => {
  t = await createTestDb();
  rules = createEquipmentRollRulesService({ db: t.db });
  libraries = createEquipmentAffixLibraryService({ db: t.db, getLegacyAffixes: () => AFFIXES });
  const featureUnlocks = createFeatureUnlockService(t.db);
  equipment = createEquipmentService({ db: t.db, featureUnlocks, getAffixes: () => AFFIXES, rollRules: rules });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  playerId = await createPlayer(t.db);
});

afterAll(async () => {
  await t?.cleanup();
});

// ── before bootstrap ────────────────────────────────────────────────────────

describe('before the rules are bootstrapped', () => {
  it('random grants fail closed; fixed grants (onboarding, restores) are unaffected', async () => {
    await expect(t.db.transaction((tx) => rules.forGrant(tx))).rejects.toBeInstanceOf(EquipmentRulesUnavailableError);
    await expect(
      t.db.transaction((tx) =>
        equipment.grantEquipment(tx, { playerId, definitionKey: 'rusty_pipe', source: { type: 'admin' }, roll: { kind: 'random' } }),
      ),
    ).rejects.toBeInstanceOf(EquipmentRulesUnavailableError);
    expect(mapAppErrorToStatus(new EquipmentRulesUnavailableError())).toBe(503);
    const fixed = await t.db.transaction((tx) =>
      equipment.grantEquipment(tx, {
        playerId,
        definitionKey: 'rusty_pipe',
        source: { type: 'admin' },
        roll: { kind: 'fixed', rolledMultiplierBp: 4_500, affixKey: null },
      }),
    );
    expect(fixed.instances).toHaveLength(1);
  });
});

// ── bootstrap and ownership ─────────────────────────────────────────────────

describe('bootstrap', () => {
  it('the first start creates revision 1 from the shipped file, with draft = published and an audit row', async () => {
    const before = await ownedRows();
    const result = await bootstrapEquipmentRollRules(t.db, loadShippedCombatBonusFile(CONTENT_DIR));
    expect(result).toEqual({ status: 'bootstrapped', publishedRevision: 1, drift: false });
    const published = await rules.published();
    expect(published).toMatchObject({ revision: 1, source: 'bootstrap', publishedBy: 'system:bootstrap' });
    expect(published.rules.legacy).toEqual(SHIPPED_FILE);
    expect(published.rules.rarities).toEqual({});
    expect(await rules.draft()).toMatchObject({ draftRevision: 1, publishedRevision: 1, dirty: false });
    expect((await events('roll_rules')).map((e) => e.action)).toEqual(['bootstrapped']);
    expect(await ownedRows()).toEqual(before);
  });

  it('a restart or content reload never overwrites, and an unchanged file reports no drift', async () => {
    await draftWith((r) => {
      r.rarities.SSR = ssr();
    });
    const draft = await rules.draft();
    for (let i = 0; i < 2; i += 1) {
      expect(await bootstrapEquipmentRollRules(t.db, SHIPPED_FILE)).toEqual({ status: 'existing', publishedRevision: 1, drift: false });
    }
    expect(await rules.draft()).toEqual(draft);
    expect((await rules.published()).revision).toBe(1);
  });

  it('a changed shipped file is drift: reported once per distinct content, never applied', async () => {
    const changed = structuredClone(SHIPPED_FILE);
    changed.rarityRules.N.bonusChanceBp = 9_999;
    for (let i = 0; i < 3; i += 1) {
      expect(await bootstrapEquipmentRollRules(t.db, changed)).toMatchObject({ status: 'existing', drift: true });
    }
    expect((await rules.published()).rules.legacy).toEqual(SHIPPED_FILE);
    expect((await events('roll_rules')).filter((e) => e.action === 'drift_detected')).toHaveLength(1);
    // A missing shipped file never removes the database's rules either.
    expect(await bootstrapEquipmentRollRules(t.db, null)).toMatchObject({ status: 'existing', publishedRevision: 1 });
  });

  it('published revisions are immutable at the database', async () => {
    await expect(t.db.execute(sql`update equipment_roll_config_revisions set source = 'editor'`)).rejects.toThrow(/immutable/);
    await expect(t.db.execute(sql`delete from equipment_roll_config_revisions`)).rejects.toThrow(/immutable/);
  });
});

// ── live grants ─────────────────────────────────────────────────────────────

describe('live grants read one published revision and roll N/R/SR exactly as before', () => {
  const shippedCatalogue = combatBonusCatalogueFromFile(SHIPPED_FILE);

  it('every shipped definition, seeded, matches the shipped catalogue roll for roll', async () => {
    const definitions = loadEquipmentSeedCatalogue(CONTENT_DIR);
    for (const [i, definition] of definitions.entries()) {
      for (const seed of [1, 77, 4_242]) {
        const rollSeed = (i + 1) * 100_000 + seed;
        const expected = rollEquipmentInstance(definition, { rng: seededRng(rollSeed), affixes: AFFIXES, combatBonuses: shippedCatalogue });
        const granted = await t.db.transaction((tx) =>
          equipment.grantEquipment(tx, {
            playerId,
            definitionKey: definition.key,
            source: { type: 'dungeon', key: 'golden' },
            grantKey: `golden:${definition.key}:${seed}`,
            rollSeed,
          }),
        );
        const copy = granted.instances[0]!;
        expect({ rolledMultiplierBp: copy.rolledMultiplierBp, affixKey: copy.affixKey, combatBonuses: copy.combatBonuses }).toEqual(expected);
        expect(copy.rolledProperties).toEqual({});
      }
    }
  });

  it('records the revision it read; draft changes never reach a grant', async () => {
    expect((await rules.draft()).dirty).toBe(true);
    const grant = await t.db.transaction((tx) =>
      equipment.grantEquipment(tx, { playerId, definitionKey: 'combat_knife', source: { type: 'admin' } }),
    );
    const [event] = await t.db.select().from(equipmentEvents).where(eq(equipmentEvents.equipmentId, grant.instances[0]!.id));
    expect(event!.metadata).toMatchObject({ rollKind: 'random', rollRulesRevision: 1 });
    const forGrant = await t.db.transaction((tx) => rules.forGrant(tx));
    expect(forGrant.revision).toBe(1);
    expect(forGrant.rules.rarities).toEqual({});
    expect(forGrant.combatBonuses).toEqual(shippedCatalogue);
  });
});

// ── draft, validate, preview, publish ───────────────────────────────────────

describe('draft lifecycle', () => {
  it('refuses a stale draft write and changes nothing', async () => {
    const draft = await rules.draft();
    const err = await rules
      .saveDraft(draft.rules, { expectedDraftRevision: draft.draftRevision - 1, actor: ACTOR })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentConfigStaleError);
    expect(mapAppErrorToStatus(err as EquipmentConfigStaleError)).toBe(409);
    expect(await rules.draft()).toEqual(draft);
  });

  it('refuses N/R/SR changes and malformed documents at save; nothing is written', async () => {
    const draft = await rules.draft();
    const legacy = structuredClone(draft.rules);
    legacy.legacy.rarityRules.SR.bonusChanceBp = 5_000;
    await expect(rules.saveDraft(legacy, { expectedDraftRevision: draft.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigInvalidError,
    );
    await expect(
      rules.saveDraft({ ...draft.rules, rarities: { N: ssr() } }, { expectedDraftRevision: draft.draftRevision, actor: ACTOR }),
    ).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    expect(await rules.draft()).toEqual(draft);
  });

  it('saves an unpublishable draft, but validation and publish refuse it', async () => {
    await draftWith((r) => {
      r.rarities.SSR = ssr({ bonusCountWeightsBp: [0, 0, 0, 9_000] });
      r.rarities.UR = ssr({ bonusCountWeightsBp: [0, 0, 0, 10_000] });
    });
    const validation = await rules.validate();
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['rarities.SSR.bonusCountWeightsBp', 'rarities.UR.families']),
    );
    const draft = await rules.draft();
    await expect(rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigInvalidError,
    );
    expect((await rules.published()).revision).toBe(1);
  });

  it('previews the field changes, then publishes atomically as an immutable new revision', async () => {
    await draftWith((r) => {
      r.rarities = { SSR: ssr() };
    });
    const preview = await rules.preview();
    expect(preview.validation.ok).toBe(true);
    expect(preview.changes.map((c) => [c.path, c.kind])).toEqual([['rarities.SSR', 'added']]);
    const draft = await rules.draft();
    const published = await rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    expect(published).toMatchObject({ revision: 2, source: 'editor', publishedBy: ACTOR });
    expect(published.rules.rarities.SSR).toEqual(ssr());
    expect(published.rules.legacy).toEqual(SHIPPED_FILE);
    expect(await rules.draft()).toMatchObject({ dirty: false, publishedRevision: 2 });
    expect((await t.db.transaction((tx) => rules.forGrant(tx))).revision).toBe(2);
    const last = (await events('roll_rules')).at(-1)!;
    expect(last).toMatchObject({ action: 'published', actor: ACTOR, details: { revision: 2, previousRevision: 1, changes: ['rarities.SSR'] } });
  });

  it('refuses to publish an unchanged draft, and a publish naming a superseded draft revision', async () => {
    const draft = await rules.draft();
    await expect(rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigConflictError,
    );
    // Author A validates revision n; author B saves n+1; A's publish of n is stale.
    const seen = (await rules.draft()).draftRevision;
    await draftWith((r) => {
      r.flatSpLimits.perItemMax = 150;
    });
    await expect(rules.publish({ expectedDraftRevision: seen, actor: 'author-a' })).rejects.toBeInstanceOf(EquipmentConfigStaleError);
    expect((await rules.published()).revision).toBe(2);
  });

  it('a publish waits for a grant holding the revision, and the grant keeps the revision it read', async () => {
    const draft = await rules.draft();
    let publish: Promise<unknown> | null = null;
    let settled = false;
    const seenInside = await t.db.transaction(async (tx) => {
      const read = await rules.forGrant(tx);
      publish = rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      // Still the same revision, read again inside the same grant.
      expect((await rules.forGrant(tx)).revision).toBe(read.revision);
      return read.revision;
    });
    expect(seenInside).toBe(2);
    await publish;
    expect((await rules.published()).revision).toBe(3);
    expect((await t.db.transaction((tx) => rules.forGrant(tx))).rules.flatSpLimits.perItemMax).toBe(150);
  });

  it('lists the revision history and rolls back to an earlier revision as a new one', async () => {
    const draft = await rules.draft();
    const rolled = await rules.rollback(1, { expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    expect(rolled).toMatchObject({ revision: 4, source: 'rollback' });
    const [first] = await t.db.select().from(equipmentRollConfigRevisions).where(eq(equipmentRollConfigRevisions.number, 1));
    expect(rolled.rules).toEqual(first!.body);
    expect(await rules.draft()).toMatchObject({ dirty: false, publishedRevision: 4 });
    expect((await rules.draft()).rules.rarities).toEqual({});
    const history = await rules.revisions();
    expect(history.map((h) => [h.revision, h.source, h.rolledBackFrom, h.current])).toEqual([
      [4, 'rollback', 1, true],
      [3, 'editor', null, false],
      [2, 'editor', null, false],
      [1, 'bootstrap', null, false],
    ]);
    expect((await events('roll_rules')).at(-1)).toMatchObject({ action: 'rolled_back', details: { revision: 4, restoredRevision: 1, previousRevision: 3 } });
    await expect(rules.rollback(4, { expectedDraftRevision: (await rules.draft()).draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigConflictError,
    );
  });

  it('exports published and draft distinctly; an import lands in the draft only and is validated', async () => {
    const published = await rules.export('published', new Date('2026-10-27T00:00:00Z'));
    expect(published).toMatchObject({ kind: 'published', revision: 4 });
    const file = structuredClone(published);
    file.config.rarities.LR = ssr();
    const before = await rules.published();
    const draft = await rules.draft();
    const imported = await rules.importDraft(file, { expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    expect(imported).toMatchObject({ dirty: true, handEdited: true });
    expect(imported.rules.rarities.LR).toEqual(ssr());
    expect(await rules.published()).toEqual(before);
    expect((await rules.export('draft')).kind).toBe('draft');
    // An invalid file changes nothing.
    const invalid = structuredClone(file);
    invalid.config.legacy.rarityRules.R.bonusCount = 2;
    const current = await rules.draft();
    await expect(rules.importDraft(invalid, { expectedDraftRevision: current.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigInvalidError,
    );
    await expect(rules.importDraft({ format: 'nope' }, { expectedDraftRevision: current.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigInvalidError,
    );
    expect(await rules.draft()).toEqual(current);
    expect((await events('roll_rules')).some((e) => e.action === 'draft_imported')).toBe(true);
  });
});

// ── affix libraries ─────────────────────────────────────────────────────────

describe('managed affix libraries', () => {
  const entry = (key: string, suffix: string, slots: readonly string[] = ALL, enabled = true) => ({ key, suffix, slots: [...slots], enabled });

  it('creates an empty library; refuses a reserved or duplicate key', async () => {
    const lib = await libraries.create({ key: 'high_rarity', name: 'High rarity' }, { actor: ACTOR });
    expect(lib).toMatchObject({ key: 'high_rarity', draftRevision: 1, publishedRevision: null, dirty: true, draftEntries: [], assignedTo: [] });
    await expect(libraries.create({ key: 'legacy_ssr', name: 'x' }, { actor: ACTOR })).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    await expect(libraries.create({ key: 'high_rarity', name: 'again' }, { actor: ACTOR })).rejects.toBeInstanceOf(EquipmentConfigConflictError);
    expect((await events('affix_library', 'high_rarity')).map((e) => e.action)).toEqual(['created']);
  });

  it('adds slot-specific entries, refusing collisions with the shipped catalogue', async () => {
    let lib = await libraries.upsertEntry('high_rarity', entry('unbroken_oath', 'of the Unbroken Oath', ['attack']), {
      expectedDraftRevision: 1,
      actor: ACTOR,
    });
    lib = await libraries.saveDraft(
      'high_rarity',
      [...lib.draftEntries, entry('quiet_dawn', 'of the Quiet Dawn', ['defense', 'health'])],
      { expectedDraftRevision: lib.draftRevision, actor: ACTOR },
    );
    expect(lib.draftEntries.map((e) => e.key)).toEqual(['unbroken_oath', 'quiet_dawn']);
    const [shipped] = AFFIXES.all();
    await expect(
      libraries.upsertEntry('high_rarity', entry(shipped!.key, 'of a Brand New Name'), { expectedDraftRevision: lib.draftRevision, actor: ACTOR }),
    ).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    await expect(
      libraries.upsertEntry('high_rarity', entry('fresh_key', shipped!.suffix), { expectedDraftRevision: lib.draftRevision, actor: ACTOR }),
    ).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    await expect(
      libraries.saveDraft('high_rarity', lib.draftEntries, { expectedDraftRevision: lib.draftRevision - 1, actor: ACTOR }),
    ).rejects.toBeInstanceOf(EquipmentConfigStaleError);
  });

  it('publishes as an immutable revision; a rarity may then use it', async () => {
    const lib = await libraries.publish('high_rarity', { expectedDraftRevision: (await libraries.get('high_rarity')).draftRevision, actor: ACTOR });
    expect(lib).toMatchObject({ publishedRevision: 1, dirty: false, publishedEntryCount: 2 });
    await expect(t.db.execute(sql`delete from equipment_affix_library_revisions`)).rejects.toThrow(/immutable/);
    await expect(libraries.publish('high_rarity', { expectedDraftRevision: lib.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigConflictError,
    );
  });

  it('one library shared by two rarities, a dedicated one for a third, and an affixless rarity', async () => {
    await libraries.create({ key: 'legendary', name: 'Legendary' }, { actor: ACTOR });
    await libraries.saveDraft('legendary', [entry('final_word', 'of the Final Word')], { expectedDraftRevision: 1, actor: ACTOR });
    await libraries.publish('legendary', { expectedDraftRevision: 2, actor: ACTOR });
    const draft = await draftWith((r) => {
      r.rarities = {
        SSR: ssr({ affixes: { mode: 'library', library: 'high_rarity' } }),
        UR: ssr({ affixes: { mode: 'library', library: 'high_rarity' } }),
        LR: ssr({ affixes: { mode: 'library', library: 'legendary' } }),
      };
    });
    await rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    expect((await libraries.get('high_rarity')).assignedTo).toEqual(['SSR', 'UR']);
    expect((await libraries.get('legendary')).assignedTo).toEqual(['LR']);
    expect(await libraries.resolveAssignment('UR')).toMatchObject({ mode: 'library', library: 'high_rarity', libraryRevision: 1 });
    expect(await libraries.resolveAssignment('N')).toEqual({ mode: 'legacy', rarity: 'N' });
    expect(await libraries.resolveAssignment('EX')).toEqual({ mode: 'unconfigured' });

    const affixless = await draftWith((r) => {
      r.rarities.UR = ssr();
    });
    await rules.publish({ expectedDraftRevision: affixless.draftRevision, actor: ACTOR });
    expect(await libraries.resolveAssignment('UR')).toEqual({ mode: 'none' });
  });

  it('refuses assigning a missing, unpublished or incomplete library', async () => {
    await libraries.create({ key: 'unpublished', name: 'Unpublished' }, { actor: ACTOR });
    for (const library of ['nope', 'unpublished']) {
      const draft = await draftWith((r) => {
        r.rarities.UR = ssr({ affixes: { mode: 'library', library } });
      });
      await expect(rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
        EquipmentConfigInvalidError,
      );
    }
  });

  it('a library in use cannot be published into a state that leaves a slot without an enabled affix', async () => {
    const lib = await libraries.get('legendary');
    const saved = await libraries.saveDraft('legendary', [entry('final_word', 'of the Final Word', ALL, false)], {
      expectedDraftRevision: lib.draftRevision,
      actor: ACTOR,
    });
    expect((await libraries.validate('legendary')).errors[0]!.message).toMatch(/draw LR affixes from this library/);
    await expect(libraries.publish('legendary', { expectedDraftRevision: saved.draftRevision, actor: ACTOR })).rejects.toBeInstanceOf(
      EquipmentConfigInvalidError,
    );
    expect((await libraries.get('legendary')).publishedEntries[0]!.enabled).toBe(true);
  });

  it('editing or disabling an affix never renames a copy that snapshotted it; legacy copies are unchanged', async () => {
    // A copy as E3-C will grant it from a managed library: key + suffix snapshot.
    await t.db.execute(sql`insert into equipment_definitions (key, name, slot, rarity, multiplier_min_bp, multiplier_max_bp, multiplier_step_bp)
      values ('e3b_relic', 'Relic', 'attack', 'SSR', ${fixedRange(10_000).multiplierMinBp}, 10000, 100)`);
    const granted = await t.db.transaction((tx) =>
      equipment.grantEquipment(tx, {
        playerId,
        definitionKey: 'e3b_relic',
        source: { type: 'admin' },
        roll: { kind: 'fixed', rolledMultiplierBp: 10_000, affixKey: null },
      }),
    );
    const id = granted.instances[0]!.id;
    await t.db
      .update(playerEquipment)
      .set({ affixKey: 'unbroken_oath', rolledProperties: { affixSuffix: 'of the Unbroken Oath', affixLibrary: 'high_rarity' } })
      .where(eq(playerEquipment.id, id));
    expect((await equipment.getOwned(playerId, id))!.displayName).toBe('Relic of the Unbroken Oath');

    const lib = await libraries.get('high_rarity');
    const renamed = await libraries.saveDraft(
      'high_rarity',
      [entry('unbroken_oath', 'of the Broken Promise', ['attack'], false), entry('quiet_dawn', 'of the Quiet Dawn', ALL)],
      { expectedDraftRevision: lib.draftRevision, actor: ACTOR },
    );
    await libraries.publish('high_rarity', { expectedDraftRevision: renamed.draftRevision, actor: ACTOR });
    expect((await equipment.getOwned(playerId, id))!.displayName).toBe('Relic of the Unbroken Oath');
    // The startup unknown-affix check does not flag a snapshotted copy.
    expect((await readUnknownAffixKeys(t.db, AFFIXES)).map((u) => u.affixKey)).not.toContain('unbroken_oath');
    // Legacy copies still resolve through the shipped catalogue.
    const legacyCopy = (await ownedRows()).find((r) => r.affixKey && r.rolledProperties && !('affixSuffix' in r.rolledProperties))!;
    expect((await equipment.getOwned(playerId, legacyCopy.id))!.displayName).toContain(AFFIXES.get(legacyCopy.affixKey!)!.suffix);
  });

  it('keeps per-library history and rolls back to an earlier revision', async () => {
    const lib = await libraries.get('high_rarity');
    expect((await libraries.revisions('high_rarity')).map((r) => [r.revision, r.source, r.current])).toEqual([
      [2, 'editor', true],
      [1, 'editor', false],
    ]);
    const rolled = await libraries.rollback('high_rarity', 1, { expectedDraftRevision: lib.draftRevision, actor: ACTOR });
    expect(rolled).toMatchObject({ publishedRevision: 3, dirty: false });
    expect(rolled.publishedEntries.map((e) => [e.key, e.suffix])).toEqual([
      ['unbroken_oath', 'of the Unbroken Oath'],
      ['quiet_dawn', 'of the Quiet Dawn'],
    ]);
    const [rev3] = await t.db.select().from(equipmentAffixLibraryRevisions).where(eq(equipmentAffixLibraryRevisions.number, 3));
    expect(rev3).toMatchObject({ source: 'rollback' });
    expect((await events('affix_library', 'high_rarity')).map((e) => e.action)).toEqual(
      expect.arrayContaining(['created', 'draft_saved', 'published', 'rolled_back']),
    );
  });

  it('exports and imports by stable key; imports land in the draft and need explicit publication', async () => {
    const file = await libraries.export('legendary', 'published');
    expect(file).toMatchObject({ kind: 'published', library: { key: 'legendary' }, affixes: [{ key: 'final_word' }] });
    // Into a new library, under a new key: created with the entries as its draft.
    const copy = {
      ...structuredClone(file),
      library: { ...file.library, key: 'legendary_copy' },
      affixes: [entry('final_echo', 'of the Final Echo')],
    };
    const created = await libraries.importDraft(copy, { actor: ACTOR });
    expect(created).toMatchObject({ key: 'legendary_copy', publishedRevision: null, dirty: true, draftEntries: [{ key: 'final_echo' }] });
    // Into an existing library: the current draft revision is required.
    await expect(libraries.importDraft(file, { actor: ACTOR })).rejects.toBeInstanceOf(EquipmentConfigConflictError);
    // A refused file creates nothing.
    const bad = { ...structuredClone(file), library: { ...file.library, key: 'never_created' }, affixes: [entry('final_word', 'of Clash')] };
    await expect(libraries.importDraft(bad, { actor: ACTOR })).rejects.toBeInstanceOf(EquipmentConfigInvalidError);
    await expect(libraries.get('never_created')).rejects.toThrow(/not found/);
  });

  it('lists managed libraries beside the read-only shipped ones', async () => {
    const list = await libraries.list();
    expect(list.managed.map((l) => l.key)).toEqual(['high_rarity', 'legendary', 'legendary_copy', 'unpublished']);
    expect(list.legacy.map((l) => [l.key, l.readOnly, l.entries.length])).toEqual([
      ['legacy_n', true, AFFIXES.all().filter((a) => a.pool.endsWith('.N')).length],
      ['legacy_r', true, AFFIXES.all().filter((a) => a.pool.endsWith('.R')).length],
      ['legacy_sr', true, AFFIXES.all().filter((a) => a.pool.endsWith('.SR')).length],
    ]);
  });
});

describe('nothing here rewrites owned equipment', () => {
  it('every publish and rollback above left player_equipment rows untouched', async () => {
    const before = await ownedRows();
    const draft = await draftWith((r) => {
      // The refused assignment from an earlier test is still in the draft.
      r.rarities.UR = ssr();
      r.flatSpLimits.perLoadoutMax = 350;
    });
    await rules.publish({ expectedDraftRevision: draft.draftRevision, actor: ACTOR });
    const now = await rules.draft();
    await rules.rollback(1, { expectedDraftRevision: now.draftRevision, actor: ACTOR });
    expect(await ownedRows()).toEqual(before);
  });
});
