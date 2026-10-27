/**
 * Equipment 3.0, phase E3-A, against PostgreSQL:
 *
 *  - migration 0070: three stored bonuses accepted, four refused, existing
 *    rows untouched and the migration safe to apply over them;
 *  - rarity frozen once any copy (removed ones included) references a
 *    definition, through update and import alike;
 *  - primary and additional flat SP stored independently on a copy, kept
 *    through reads and grouping;
 *  - effective SP in the live calculation, previews, equip/unequip and Combat
 *    Trial snapshots — with natural SP and old gear unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  combatTrialAttempts,
  playerEquipment,
  playerWaifus,
  species as speciesTable,
} from '../../src/db/schema';
import { mapAppErrorToStatus } from '../../src/api/errors';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { deriveStat } from '../../src/modules/equipment/equipmentMath';
import { createCombatTrialService, type CombatTrialService } from '../../src/modules/combatTrials/combatTrialService';
import { createCombatEnemyCatalogue, CombatEnemyDefinitionSchema } from '../../src/modules/combat/enemyDefinitions';
import { createCombatTrialCatalogue, CombatTrialDefinitionSchema } from '../../src/modules/combat/trialDefinitions';
import { STARTER_ROLLS } from '../../src/modules/onboarding/vocabulary';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { EquipmentRarityLockedError, EquipmentValidationError } from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import {
  buildEquipmentServices,
  expectPgError,
  fixedRange,
  grant,
  starterRoll,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';
import type { CombatBonus } from '../../src/modules/equipment/combatBonuses';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let trials: CombatTrialService;
let speciesId: number;

/** An SSR definition per slot — authorable, never randomly rollable or rewardable. */
const RELIC = {
  attack: { key: 'e3_relic_blade', name: 'Relic Blade', slot: 'attack', rarity: 'SSR', ...fixedRange(10_000) },
  defense: { key: 'e3_relic_plate', name: 'Relic Plate', slot: 'defense', rarity: 'SSR', ...fixedRange(8_000) },
  health: { key: 'e3_relic_charm', name: 'Relic Charm', slot: 'health', rarity: 'SSR', ...fixedRange(30_000) },
} as const;

const CRIT: CombatBonus = { stat: 'crit_chance_bp', valueBp: 500 };
const LIFESTEAL: CombatBonus = { stat: 'lifesteal_bp', valueBp: 100 };
const flat = (valueBp: number): CombatBonus => ({ stat: 'flat_sp', valueBp });

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  const enemies = createCombatEnemyCatalogue([
    CombatEnemyDefinitionSchema.parse({ key: 'weakling', name: 'Weakling', attack: 1, defense: 0, hp: 10, enabled: true }),
  ]);
  const catalogue = createCombatTrialCatalogue(
    [CombatTrialDefinitionSchema.parse({ key: 't_win', name: 'Trial', description: 'A test.', enabled: true, enemyKey: 'weakling', order: 1 })],
    enemies,
  );
  trials = createCombatTrialService({
    db: t.db,
    featureUnlocks: svc.featureUnlocks,
    combatStats: combat,
    currency: app.currency,
    inventory: app.inventory,
    getCatalogue: () => catalogue,
  });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  for (const def of Object.values(RELIC)) await svc.definitions.create(def);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
/** A player with the Equipment unlock, a natural-250 SP Buddy (level 1, Base 250) and the three onboarding starters. */
async function setup() {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-e3-${seq}`, `u-e3-${seq}`);
  await unlockEquipment(t.db, svc, playerId);
  const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 250 });
  await app.collection.setBuddy(playerId, buddy.id);
  const starters = {
    attack: await grant(t.db, svc, playerId, 'rusty_pipe', starterRoll('rusty_pipe')),
    defense: await grant(t.db, svc, playerId, 'scrap_plate', starterRoll('scrap_plate')),
    health: await grant(t.db, svc, playerId, 'dented_lunchbox', starterRoll('dented_lunchbox')),
  };
  for (const slot of ['attack', 'defense', 'health'] as const) {
    await svc.equipment.equip(playerId, { slot, equipmentId: starters[slot] });
  }
  return { playerId, buddyId: buddy.id, starters };
}

function fixedRelic(slot: keyof typeof RELIC, over: { flatSp?: number; combatBonuses?: CombatBonus[] } = {}) {
  return {
    roll: {
      kind: 'fixed' as const,
      rolledMultiplierBp: RELIC[slot].multiplierMinBp,
      affixKey: null,
      ...over,
    },
  };
}

async function row(id: number) {
  const [r] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, id));
  return r!;
}

// ── migration 0070 ──────────────────────────────────────────────────────────

describe('migration 0070: up to three stored bonuses', () => {
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'drizzle', '0070_equipment_three_bonuses.sql'), 'utf8');
  const runMigration = async () => {
    for (const statement of MIGRATION.split('--> statement-breakpoint')) await t.pool.query(statement);
  };

  it('the live constraint admits three entries', async () => {
    const { rows } = await t.pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'player_equipment_combat_bonuses_check'`,
    );
    expect(rows[0].def).toMatch(/jsonb_array_length\(combat_bonuses\) <= 3/);
  });

  it('accepts three distinct bonuses and refuses four at the database', async () => {
    const { playerId } = await setup();
    const id = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { combatBonuses: [CRIT, LIFESTEAL, flat(11)] }));
    expect((await row(id)).combatBonuses).toEqual([CRIT, LIFESTEAL, flat(11)]);
    await expectPgError(
      t.db
        .update(playerEquipment)
        .set({ combatBonuses: [CRIT, LIFESTEAL, flat(11), { stat: 'double_attack_chance_bp', valueBp: 100 }] })
        .where(eq(playerEquipment.id, id)),
      '23514',
    );
  });

  it('applies over existing zero/one/two-bonus rows without touching them, and re-runs as a no-op', async () => {
    const { playerId } = await setup();
    const ids = [
      await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack')),
      await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { combatBonuses: [CRIT] })),
      await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { combatBonuses: [CRIT, LIFESTEAL] })),
    ];
    const before = await Promise.all(ids.map(row));
    // Back to the 0056 form, as a server that has not yet run 0070 holds it…
    // (NOT VALID only because an earlier test in this file stored a
    // three-bonus copy, which no pre-0070 server could hold; the migration
    // below re-adds the constraint validated against every row.)
    await t.pool.query('alter table player_equipment drop constraint player_equipment_combat_bonuses_check');
    await t.pool.query(
      `alter table player_equipment add constraint player_equipment_combat_bonuses_check
         check (jsonb_typeof(combat_bonuses) = 'array' and jsonb_array_length(combat_bonuses) <= 2) not valid`,
    );
    // …then the migration, twice.
    await runMigration();
    await runMigration();
    const after = await Promise.all(ids.map(row));
    expect(after).toEqual(before);
    const { rows } = await t.pool.query(
      `select count(*)::int as n, bool_and(convalidated) as validated, max(pg_get_constraintdef(oid)) as def
         from pg_constraint where conname = 'player_equipment_combat_bonuses_check'`,
    );
    expect(rows[0]).toMatchObject({ n: 1, validated: true });
    expect(rows[0].def).toMatch(/<= 3/);
    const { rows: violating } = await t.pool.query(
      `select count(*)::int as n from player_equipment where jsonb_array_length(combat_bonuses) > 3`,
    );
    expect(violating[0].n).toBe(0);
  });
});

// ── rarity lock ─────────────────────────────────────────────────────────────

describe('rarity is frozen once any copy references the definition', () => {
  let n = 0;
  const fresh = async (rarity = 'N') => {
    n += 1;
    const input = { key: `e3_lock_${n}`, name: `Lock ${n}`, slot: 'attack', rarity, ...fixedRange(5_000) };
    await svc.definitions.create(input);
    return input;
  };

  it('an unreferenced definition may still change rarity (and anything else)', async () => {
    const def = await fresh();
    const updated = await svc.definitions.update(def.key, { ...def, rarity: 'LR', name: 'Renamed' });
    expect(updated).toMatchObject({ rarity: 'LR', name: 'Renamed' });
  });

  it('a referenced definition refuses a rarity change with EQUIPMENT_RARITY_LOCKED (409) and is left unchanged', async () => {
    const def = await fresh();
    const { playerId } = await setup();
    await grant(t.db, svc, playerId, def.key);
    const err = await svc.definitions.update(def.key, { ...def, rarity: 'SR' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EquipmentRarityLockedError);
    expect(mapAppErrorToStatus(err as EquipmentRarityLockedError)).toBe(409);
    expect((await svc.definitions.getByKey(def.key))!.rarity).toBe('N');
  });

  it('a removed copy still counts as a reference', async () => {
    const def = await fresh();
    const { playerId } = await setup();
    const id = await grant(t.db, svc, playerId, def.key);
    await t.db.update(playerEquipment).set({ removedAt: new Date(), removedReason: 'test' }).where(eq(playerEquipment.id, id));
    await expect(svc.definitions.update(def.key, { ...def, rarity: 'R' })).rejects.toBeInstanceOf(EquipmentRarityLockedError);
  });

  it('other fields stay editable on a referenced definition', async () => {
    const def = await fresh();
    const { playerId } = await setup();
    const id = await grant(t.db, svc, playerId, def.key);
    const updated = await svc.definitions.update(def.key, {
      ...def,
      name: 'Retuned',
      description: 'New words.',
      multiplierMinBp: 4_000,
      multiplierMaxBp: 6_000,
      multiplierStepBp: 500,
    });
    expect(updated).toMatchObject({ name: 'Retuned', rarity: 'N', multiplierMinBp: 4_000 });
    // The owned copy keeps its roll: nothing is rerolled by an edit.
    expect((await row(id)).rolledMultiplierBp).toBe(5_000);
  });

  it('an import that changes a referenced rarity is refused as a whole', async () => {
    const def = await fresh();
    const { playerId } = await setup();
    await grant(t.db, svc, playerId, def.key);
    const pkg = { format: 'waifumon-equipment', version: 2, definitions: [{ ...def, rarity: 'UR' }] };
    const plan = await svc.promotion.previewImport(pkg);
    expect(plan.ok).toBe(false);
    expect(plan.issues).toEqual([
      expect.objectContaining({ path: 'definitions[0].rarity', message: expect.stringContaining('its rarity cannot change from N to UR') }),
    ]);
    await expect(svc.promotion.applyImport(pkg)).rejects.toThrow(/rarity cannot change/);
    expect((await svc.definitions.getByKey(def.key))!.rarity).toBe('N');
  });

  it('the reset seed refuses it too', async () => {
    const def = await fresh();
    const { playerId } = await setup();
    await grant(t.db, svc, playerId, def.key);
    const parsed = (await svc.definitions.getByKey(def.key))!;
    await expect(
      seedEquipmentDefinitions(t.db, {
        mode: 'reset',
        catalogue: [{ ...def, rarity: 'SSR', description: '', secondaryEffects: [], tags: [], regionId: null, artworkPath: null, enabled: parsed.enabled, shopRegions: [], buyPrice: null, priceCurrency: 'waifubux' } as never],
      }),
    ).rejects.toBeInstanceOf(EquipmentRarityLockedError);
  });
});

// ── stored flat SP ──────────────────────────────────────────────────────────

describe('flat SP on an owned copy', () => {
  it('stores primary and additional flat SP independently and reads both back', async () => {
    const { playerId } = await setup();
    const id = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 20, combatBonuses: [CRIT, flat(11)] }));
    const stored = await row(id);
    expect(stored.rolledProperties).toEqual({ flatSp: 20 });
    expect(stored.combatBonuses).toEqual([CRIT, flat(11)]);
    const view = await svc.equipment.getOwned(playerId, id);
    expect(view).toMatchObject({ rolledProperties: { flatSp: 20 }, combatBonuses: [CRIT, flat(11)] });
  });

  it('a copy without flat SP stores {} exactly as every pre-3.0 copy does', async () => {
    const { playerId, starters } = await setup();
    expect((await row(starters.attack)).rolledProperties).toEqual({});
    const id = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 0 }));
    expect((await row(id)).rolledProperties).toEqual({});
  });

  it('refuses a copy whose flat SP would exceed the per-copy ceiling — nothing is stored', async () => {
    const { playerId } = await setup();
    const before = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
    await expect(
      grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 150, combatBonuses: [flat(60)] })),
    ).rejects.toBeInstanceOf(EquipmentValidationError);
    await expect(grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: -1 }))).rejects.toBeInstanceOf(
      EquipmentValidationError,
    );
    expect(await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toHaveLength(before.length);
  });

  it('groups copies by their flat SP; identical copies (and old {} copies) still group together', async () => {
    const { playerId } = await setup();
    const a = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 20 }));
    const b = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 20 }));
    const c = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 30 }));
    const d = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack'));
    const e = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack'));
    const groups = await svc.equipment.listEquipmentGroups(playerId, { definitionKey: RELIC.attack.key });
    const byIds = groups.map((g) => [g.instanceIds, g.rolledProperties]);
    expect(byIds).toEqual(
      expect.arrayContaining([
        [[a, b], { flatSp: 20 }],
        [[c], { flatSp: 30 }],
        [[d, e], {}],
      ]),
    );
    expect(groups).toHaveLength(3);
  });
});

// ── effective SP in the live calculation ────────────────────────────────────

describe('effective SP in combat stats', () => {
  it('natural 250 + primary 20 + additional 11 → every stat derived from 281; natural SP untouched', async () => {
    const { playerId, buddyId } = await setup();
    const blade = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 20, combatBonuses: [CRIT, flat(11)] }));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: blade });
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.formulaVersion).toBe(3);
    expect(stats.buddy!.currentSp).toBe(250);
    expect(stats.sp).toEqual({ natural: 250, primaryFlat: 20, additionalFlat: 11, equipmentBonus: 31, effective: 281, capped: false });
    expect(stats.stats).toEqual({
      attack: deriveStat(281, 10_000),
      defense: deriveStat(281, STARTER_ROLLS.defense.rolledMultiplierBp),
      maxHp: deriveStat(281, STARTER_ROLLS.health.rolledMultiplierBp),
    });
    expect(stats.combatModifiers.critChanceBp).toBe(500);
    // The progression value is never written.
    const [waifu] = await t.db.select().from(playerWaifus).where(eq(playerWaifus.id, buddyId));
    expect(waifu!.baseSp).toBe(250);
  });

  it('old gear without flat SP gives exactly the pre-3.0 numbers', async () => {
    const { playerId } = await setup();
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.sp).toMatchObject({ natural: 250, equipmentBonus: 0, effective: 250 });
    expect(stats.stats).toEqual({
      attack: deriveStat(250, STARTER_ROLLS.attack.rolledMultiplierBp),
      defense: deriveStat(250, STARTER_ROLLS.defense.rolledMultiplierBp),
      maxHp: deriveStat(250, STARTER_ROLLS.health.rolledMultiplierBp),
    });
  });

  it('stacks across slots, and equip/unequip move every stat', async () => {
    const { playerId, starters } = await setup();
    const blade = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 20 }));
    const plate = await grant(t.db, svc, playerId, RELIC.defense.key, fixedRelic('defense', { combatBonuses: [flat(30)] }));
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: blade });
    await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: plate });
    let stats = await combat.calculateCombatStats(playerId);
    expect(stats.sp).toMatchObject({ primaryFlat: 20, additionalFlat: 30, equipmentBonus: 50, effective: 300 });
    expect(stats.stats.maxHp).toBe(deriveStat(300, STARTER_ROLLS.health.rolledMultiplierBp));

    await svc.equipment.unequip(playerId, { slot: 'defense' });
    stats = await combat.calculateCombatStats(playerId);
    expect(stats.sp).toMatchObject({ equipmentBonus: 20, effective: 270 });
    expect(stats.stats).toEqual({ attack: deriveStat(270, 10_000), defense: null, maxHp: deriveStat(270, STARTER_ROLLS.health.rolledMultiplierBp) });

    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: starters.attack });
    await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: starters.defense });
    stats = await combat.calculateCombatStats(playerId);
    expect(stats.sp).toMatchObject({ equipmentBonus: 0, effective: 250 });
  });

  it('the slot preview reports the change to all three stats', async () => {
    const { playerId } = await setup();
    const blade = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack', { flatSp: 30 }));
    const preview = await combat.previewSlot(playerId, 'attack', [blade]);
    const candidate = preview.candidates[0]!;
    const before = preview.stats.stats;
    const after = {
      attack: deriveStat(280, 10_000),
      defense: deriveStat(280, STARTER_ROLLS.defense.rolledMultiplierBp),
      maxHp: deriveStat(280, STARTER_ROLLS.health.rolledMultiplierBp),
    };
    expect(candidate).toMatchObject({ available: true, value: after.attack, delta: after.attack - before.attack! });
    expect(candidate.stats).toEqual(after);
    expect(candidate.deltas).toEqual({
      attack: after.attack - before.attack!,
      defense: after.defense - before.defense!,
      maxHp: after.maxHp - before.maxHp!,
    });
    expect(candidate.deltas!.defense).toBeGreaterThan(0);
    // A preview never writes: the live calculation is unchanged.
    expect((await combat.calculateCombatStats(playerId)).sp).toMatchObject({ equipmentBonus: 0 });
  });

  it('a preview of gear without flat SP leaves the other stats at a zero delta', async () => {
    const { playerId } = await setup();
    const blade = await grant(t.db, svc, playerId, RELIC.attack.key, fixedRelic('attack'));
    const candidate = (await combat.previewSlot(playerId, 'attack', [blade])).candidates[0]!;
    expect(candidate.deltas).toMatchObject({ defense: 0, maxHp: 0 });
  });
});

describe('Combat Trial snapshots', () => {
  it('fight with stats derived from effective SP, frozen on the attempt', async () => {
    const { playerId } = await setup();
    const charm = await grant(t.db, svc, playerId, RELIC.health.key, fixedRelic('health', { flatSp: 40 }));
    await svc.equipment.equip(playerId, { slot: 'health', equipmentId: charm });
    const outcome = await trials.fight(playerId, 't_win', 'e3-trial-1');
    expect(outcome.attempt.result).toBe('player_victory');
    const [attempt] = await t.db
      .select()
      .from(combatTrialAttempts)
      .where(and(eq(combatTrialAttempts.playerId, playerId), eq(combatTrialAttempts.requestKey, 'e3-trial-1')));
    expect(attempt).toMatchObject({
      playerAttack: deriveStat(290, STARTER_ROLLS.attack.rolledMultiplierBp),
      playerDefense: deriveStat(290, STARTER_ROLLS.defense.rolledMultiplierBp),
      playerMaxHp: deriveStat(290, 30_000),
    });
    // Unequipping afterwards changes nothing already fought.
    await svc.equipment.unequip(playerId, { slot: 'health' });
    const [again] = await t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.id, attempt!.id));
    expect(again!.playerMaxHp).toBe(deriveStat(290, 30_000));
  });
});
