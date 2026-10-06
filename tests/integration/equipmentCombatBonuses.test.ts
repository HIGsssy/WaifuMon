/**
 * Equipment combat bonuses against a real database: what a grant stores, that
 * it is read back unchanged on every path (list, loadout, combat stats, grant
 * replay, Workshop replay), what fixed and pre-system gear carry, how
 * identical copies group — and Combat Trials on top: the modifier snapshot,
 * the seeded fight, and that a stored attempt reproduces from its seed.
 *
 * The Equipment RNG is scripted per test — `pick(...)` queues the exact
 * `intInclusive` answers the next roll gets, in draw order: multiplier step,
 * affix index, then the bonus draws (N's chance roll, each family index, each
 * magnitude step). Unscripted draws answer `min`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { combatTrialAttempts, equipmentEvents, playerCurrencies, playerEquipment, players, species as speciesTable } from '../../src/db/schema';
import { ZERO_COMBAT_MODIFIERS } from '../../src/modules/combat/combatMath';
import type { CombatEvent, CombatState } from '../../src/modules/combat/combatTypes';
import { CombatEnemyDefinitionSchema, createCombatEnemyCatalogue } from '../../src/modules/combat/enemyDefinitions';
import { CombatTrialDefinitionSchema, createCombatTrialCatalogue } from '../../src/modules/combat/trialDefinitions';
import {
  combatTrialSeed,
  createCombatTrialService,
  replayCombatTrialAttempt,
  runCombatTrialFight,
  type CombatTrialService,
} from '../../src/modules/combatTrials/combatTrialService';
import {
  EQUIPMENT_COMBAT_BONUS_FILE,
  EquipmentCombatBonusFileSchema,
  combatBonusCatalogueFromFile,
  type CombatBonus,
  type CombatBonusCatalogue,
} from '../../src/modules/equipment/combatBonuses';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  createEquipmentManagementService,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { createEquipmentRewardService, type EquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { createEquipmentWorkshopService, type EquipmentWorkshopService } from '../../src/modules/equipment/equipmentWorkshopService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { EquipmentAffixPoolEmptyError, EquipmentValidationError } from '../../src/shared/errors';
import { seededRng, type Rng } from '../../src/shared/random';
import {
  TEST_AFFIXES,
  buildEquipmentServices,
  expectPgError,
  fixedRange,
  grant,
  starterRoll,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

// ── a scripted RNG ────────────────────────────────────────────────────────

let script: number[] = [];
const pick = (...values: number[]) => {
  script = [...values];
};
const rng: Rng = {
  next: () => 0,
  intInclusive(min, max) {
    const v = script.length > 0 ? script.shift()! : min;
    if (v < min || v > max) throw new Error(`scripted pick ${v} outside [${min}, ${max}]`);
    return v;
  },
};

const SHIPPED: CombatBonusCatalogue = combatBonusCatalogueFromFile(
  EquipmentCombatBonusFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_COMBAT_BONUS_FILE), 'utf8'))),
);
/** What the Equipment service reads; a test may swap it to "reload" content. */
let bonusCatalogue: CombatBonusCatalogue | null = SHIPPED;

/** One definition per rarity under test. Single-value ranges: the multiplier draw is always step 0. */
const DEFS = {
  baton: { key: 'cb_stun_baton', name: 'Stun Baton', slot: 'attack', rarity: 'N', ...fixedRange(6_500) },
  knife: { key: 'cb_combat_knife', name: 'Combat Knife', slot: 'attack', rarity: 'R', ...fixedRange(8_000) },
  rail: { key: 'cb_railcarbine', name: 'Railcarbine', slot: 'attack', rarity: 'SR', ...fixedRange(11_500) },
  vest: { key: 'cb_vest', name: 'Vest', slot: 'defense', rarity: 'R', ...fixedRange(7_000) },
  tank: { key: 'cb_tank', name: 'Tank', slot: 'health', rarity: 'SR', ...fixedRange(26_000) },
  relic: { key: 'cb_relic', name: 'Relic', slot: 'attack', rarity: 'SSR', ...fixedRange(15_000) },
} as const;

// Draw answers. The attack pool is [crit chance, crit damage, double attack, armor pen, lifesteal].
const MULT = 0;
const AFFIX = 0;
const N_BONUS = 1; // succeeds the 65% roll
const N_NO_BONUS = 10_000; // fails it

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let mgmt: EquipmentManagementService;
let rewards: EquipmentRewardService;
let workshop: EquipmentWorkshopService;
let trials: CombatTrialService;
let speciesId: number;

const ENEMIES = [
  CombatEnemyDefinitionSchema.parse({ key: 'cb_dummy', name: 'Dummy', attack: 60, defense: 80, hp: 2_500, enabled: true }),
];
const TRIALS = [
  CombatTrialDefinitionSchema.parse({ key: 'cb_trial', name: 'Bonus Trial', description: 'A test.', enabled: true, enemyKey: 'cb_dummy', order: 1 }),
];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db, { affixes: TEST_AFFIXES, rng, combatBonuses: () => bonusCatalogue });
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  mgmt = createEquipmentManagementService({ equipment: svc.equipment, combatStats: combat, featureUnlocks: svc.featureUnlocks });
  rewards = createEquipmentRewardService({ equipment: svc.equipment, getAffixes: svc.getAffixes, featureUnlocks: svc.featureUnlocks, rng });
  workshop = createEquipmentWorkshopService({
    db: t.db,
    featureUnlocks: svc.featureUnlocks,
    equipment: svc.equipment,
    equipmentRewards: rewards,
    currency: app.currency,
    getAffixes: svc.getAffixes,
    getConfig: () => ({
      salvageYields: { N: 1, R: 4, SR: 12 },
      recipes: [{ key: 'advanced_rebuild', name: 'Advanced Rebuild', rarity: 'SR', componentCost: 40, waifubuxCost: 2_000, enabled: true }],
    }),
  });
  trials = createCombatTrialService({
    db: t.db,
    featureUnlocks: svc.featureUnlocks,
    combatStats: combat,
    currency: app.currency,
    inventory: app.inventory,
    getCatalogue: () => createCombatTrialCatalogue(TRIALS, createCombatEnemyCatalogue(ENEMIES)),
  });
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  for (const def of Object.values(DEFS)) await svc.definitions.create(def);
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

beforeEach(() => {
  script = [];
  bonusCatalogue = SHIPPED;
});

let seq = 0;
/** An unlocked player with a level-35 Buddy at Current SP 185. */
async function setup() {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-cb-${seq}`, `u-cb-${seq}`);
  const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 35, baseSp: 100, nickname: 'Nebula Nurse' });
  await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  await unlockEquipment(t.db, svc, playerId);
  return playerId;
}

const random = (playerId: number, def: { key: string }, over: { grantKey?: string } = {}) =>
  grant(t.db, svc, playerId, def.key, { roll: { kind: 'random' }, ...over });
const fixed = (playerId: number, def: { key: string; multiplierMinBp: number }, combatBonuses?: CombatBonus[]) =>
  grant(t.db, svc, playerId, def.key, {
    roll: { kind: 'fixed', rolledMultiplierBp: def.multiplierMinBp, affixKey: null, ...(combatBonuses ? { combatBonuses } : {}) },
  });
const rowOf = async (id: number) => (await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, id)))[0]!;
const bonusesOf = async (playerId: number, id: number) => (await svc.equipment.getOwned(playerId, id))!.combatBonuses;
const equip = (playerId: number, slot: 'attack' | 'defense' | 'health', equipmentId: number) =>
  svc.equipment.equip(playerId, { slot, equipmentId });

/* ───────────────────────── what a grant stores ───────────────────────── */

describe('random grants roll by rarity and store the result', () => {
  it('N with a failed bonus roll stores no bonus', async () => {
    const p = await setup();
    pick(MULT, AFFIX, N_NO_BONUS);
    const id = await random(p, DEFS.baton);
    expect((await rowOf(id)).combatBonuses).toEqual([]);
    expect(await bonusesOf(p, id)).toEqual([]);
  });

  it('N with a successful bonus roll stores exactly one, in basis points', async () => {
    const p = await setup();
    // family 0 = crit chance; N range 100–300 step 25 → step 5 = 225 (2.25%).
    pick(MULT, AFFIX, N_BONUS, 0, 5);
    const id = await random(p, DEFS.baton);
    expect((await rowOf(id)).combatBonuses).toEqual([{ stat: 'crit_chance_bp', valueBp: 225 }]);
    expect(await bonusesOf(p, id)).toEqual([{ stat: 'crit_chance_bp', valueBp: 225 }]);
  });

  it('R always stores exactly one — there is no chance roll to fail', async () => {
    const p = await setup();
    // No chance draw at R: family 0, then R range 250–500 step 25 → step 7 = 425 (4.25%).
    pick(MULT, AFFIX, 0, 7);
    const id = await random(p, DEFS.knife);
    expect(await bonusesOf(p, id)).toEqual([{ stat: 'crit_chance_bp', valueBp: 425 }]);
    expect(script).toEqual([]);
    for (let i = 0; i < 25; i += 1) {
      script = [];
      expect(await bonusesOf(p, await random(p, DEFS.knife))).toHaveLength(1);
    }
  });

  it('SR always stores exactly two, of distinct families', async () => {
    const p = await setup();
    // Families 0 (crit chance) and then index 1 of the remaining four (double attack);
    // SR crit 450–800 step 25 → step 8 = 650; SR double 300–600 step 25 → step 5 = 425.
    pick(MULT, AFFIX, 0, 1, 8, 5);
    const id = await random(p, DEFS.rail);
    const expected = [
      { stat: 'crit_chance_bp', valueBp: 650 },
      { stat: 'double_attack_chance_bp', valueBp: 425 },
    ];
    expect((await rowOf(id)).combatBonuses).toEqual(expected);
    expect(await bonusesOf(p, id)).toEqual(expected);
  });

  it('seeded SR rolls are always two distinct families within the SR ranges', async () => {
    const p = await setup();
    const seeded = buildEquipmentServices(t.db, { affixes: TEST_AFFIXES, rng: seededRng(11), combatBonuses: () => SHIPPED });
    for (let i = 0; i < 40; i += 1) {
      const id = await grant(t.db, seeded, p, DEFS.tank.key, { roll: { kind: 'random' } });
      const bonuses = await bonusesOf(p, id);
      expect(bonuses).toHaveLength(2);
      expect(bonuses[0]!.stat).not.toBe(bonuses[1]!.stat);
      for (const b of bonuses) {
        const range = SHIPPED.bonuses.find((f) => f.stat === b.stat)!.ranges.SR;
        expect(b.valueBp).toBeGreaterThanOrEqual(range.minBp);
        expect(b.valueBp).toBeLessThanOrEqual(range.maxBp);
        expect(SHIPPED.eligibility.health).toContain(b.stat);
      }
    }
  });

  it('records the rolled bonuses on the granted event', async () => {
    const p = await setup();
    pick(MULT, AFFIX, 4, 3); // lifesteal, R 150–300 step 25 → step 3 = 225
    const id = await random(p, DEFS.knife);
    const [event] = await t.db.select().from(equipmentEvents).where(eq(equipmentEvents.equipmentId, id));
    expect(event!.metadata).toMatchObject({ rollKind: 'random', combatBonuses: [{ stat: 'lifesteal_bp', valueBp: 225 }] });
  });

  it('a random copy of a starter definition follows the normal N rules', async () => {
    const p = await setup();
    // rusty_pipe is ranged (4000–6000): multiplier step 2, then the affix, the N roll, family, magnitude.
    pick(2, AFFIX, N_BONUS, 4, 0);
    const id = await random(p, { key: 'rusty_pipe' });
    expect(await bonusesOf(p, id)).toEqual([{ stat: 'lifesteal_bp', valueBp: 100 }]);
  });

  it('an SSR definition still cannot be rolled randomly at all', async () => {
    const p = await setup();
    await expect(random(p, DEFS.relic)).rejects.toBeInstanceOf(EquipmentAffixPoolEmptyError);
  });

  it('without a deployed catalogue random gear rolls no bonus', async () => {
    const p = await setup();
    bonusCatalogue = null;
    expect(await bonusesOf(p, await random(p, DEFS.rail))).toEqual([]);
  });

  it('refuses, rather than duplicating a stat, when a pool cannot supply distinct families', async () => {
    const p = await setup();
    bonusCatalogue = { ...SHIPPED, eligibility: { ...SHIPPED.eligibility, attack: ['crit_chance_bp'] } };
    await expect(random(p, DEFS.rail)).rejects.toBeInstanceOf(EquipmentValidationError);
    expect(await svc.equipment.listEquipment(p)).toMatchObject({ items: [] });
  });
});

describe('a grant key pins the bonuses', () => {
  it('a replayed grant returns the original bonuses and rolls nothing new', async () => {
    const p = await setup();
    pick(MULT, AFFIX, 0, 1, 8, 5);
    const first = await random(p, DEFS.rail, { grantKey: `cb-replay-${p}` });
    // The retry would roll armor pen + lifesteal at the range tops, if it rolled.
    pick(MULT, AFFIX, 3, 3, 10, 10);
    const again = await random(p, DEFS.rail, { grantKey: `cb-replay-${p}` });
    expect(again).toBe(first);
    expect(await bonusesOf(p, first)).toEqual([
      { stat: 'crit_chance_bp', valueBp: 650 },
      { stat: 'double_attack_chance_bp', valueBp: 425 },
    ]);
    expect((await svc.equipment.listEquipment(p)).items).toHaveLength(1);
  });

  it('the shared reward path replays definition, multiplier, affix and bonuses exactly', async () => {
    const p = await setup();
    const selector = { definitionKeys: [DEFS.rail.key] };
    // The definition pick (one candidate), then the roll: lifesteal, then crit chance of the rest.
    pick(0, MULT, AFFIX, 4, 0, 10, 0);
    const first = await t.db.transaction((tx) =>
      rewards.grantRandomEquipmentReward(tx, { playerId: p, selector, source: { type: 'dungeon', key: 'test' }, grantKey: `cb-reward-${p}` }),
    );
    expect(first.combatBonuses).toEqual([
      { stat: 'crit_chance_bp', valueBp: 450 },
      { stat: 'lifesteal_bp', valueBp: 500 },
    ]);
    pick(0, MULT, AFFIX, 1, 1, 3, 3);
    const again = await t.db.transaction((tx) =>
      rewards.grantRandomEquipmentReward(tx, { playerId: p, selector, source: { type: 'dungeon', key: 'test' }, grantKey: `cb-reward-${p}` }),
    );
    expect(again).toEqual({ ...first, alreadyGranted: true });
  });

  it('retuning the catalogue afterwards changes nothing already owned', async () => {
    const p = await setup();
    pick(MULT, AFFIX, 0, 7);
    const id = await random(p, DEFS.knife);
    bonusCatalogue = {
      ...SHIPPED,
      bonuses: SHIPPED.bonuses.map((b) => ({ ...b, ranges: { ...b.ranges, R: { minBp: 4_000, maxBp: 4_000 } } })),
    };
    expect(await bonusesOf(p, id)).toEqual([{ stat: 'crit_chance_bp', valueBp: 425 }]);
    await equip(p, 'attack', id);
    expect((await combat.calculateCombatStats(p)).combatModifiers.critChanceBp).toBe(425);
  });
});

describe('fixed grants dictate their bonuses', () => {
  it('a fixed grant without bonuses stores none — even with a catalogue and loaded dice', async () => {
    const p = await setup();
    pick(0, 0, 1, 1, 1, 1);
    const id = await fixed(p, DEFS.rail);
    expect((await rowOf(id)).combatBonuses).toEqual([]);
    expect(script).toHaveLength(6); // nothing was drawn
  });

  it('the onboarding starters stay bonus-free', async () => {
    const p = await setup();
    pick(0, 0, 1, 1, 1, 1);
    for (const key of ['rusty_pipe', 'scrap_plate', 'dented_lunchbox']) {
      const id = await grant(t.db, svc, p, key, { ...starterRoll(key), source: { type: 'onboarding' } });
      expect((await rowOf(id)).combatBonuses).toEqual([]);
    }
  });

  it('stores explicitly supplied bonuses exactly, in canonical order, whatever the ranges say', async () => {
    const p = await setup();
    const id = await fixed(p, DEFS.rail, [
      { stat: 'lifesteal_bp', valueBp: 1_234 },
      { stat: 'crit_chance_bp', valueBp: 5 },
    ]);
    expect((await rowOf(id)).combatBonuses).toEqual([
      { stat: 'crit_chance_bp', valueBp: 5 },
      { stat: 'lifesteal_bp', valueBp: 1_234 },
    ]);
  });

  it('a higher rarity with no random rules takes explicit bonuses through a fixed grant', async () => {
    const p = await setup();
    const id = await fixed(p, DEFS.relic, [
      { stat: 'crit_chance_bp', valueBp: 1_200 },
      { stat: 'crit_damage_bonus_bp', valueBp: 3_000 },
    ]);
    expect(await bonusesOf(p, id)).toEqual([
      { stat: 'crit_chance_bp', valueBp: 1_200 },
      { stat: 'crit_damage_bonus_bp', valueBp: 3_000 },
    ]);
  });

  it('a replayed fixed grant returns what it stored, not what it is now told', async () => {
    const p = await setup();
    const roll = (combatBonuses: CombatBonus[]) => ({ kind: 'fixed' as const, rolledMultiplierBp: 11_500, affixKey: null, combatBonuses });
    const first = await grant(t.db, svc, p, DEFS.rail.key, { roll: roll([{ stat: 'lifesteal_bp', valueBp: 300 }]), grantKey: `cb-fixed-${p}` });
    const again = await grant(t.db, svc, p, DEFS.rail.key, { roll: roll([{ stat: 'crit_chance_bp', valueBp: 800 }]), grantKey: `cb-fixed-${p}` });
    expect(again).toBe(first);
    expect(await bonusesOf(p, first)).toEqual([{ stat: 'lifesteal_bp', valueBp: 300 }]);
  });

  it.each([
    ['three bonuses', [{ stat: 'crit_chance_bp', valueBp: 1 }, { stat: 'lifesteal_bp', valueBp: 1 }, { stat: 'armor_penetration_bp', valueBp: 1 }]],
    ['a repeated family', [{ stat: 'crit_chance_bp', valueBp: 1 }, { stat: 'crit_chance_bp', valueBp: 2 }]],
    ['an unknown family', [{ stat: 'dodge_bp', valueBp: 100 }]],
    ['a fractional value', [{ stat: 'crit_chance_bp', valueBp: 4.25 }]],
    ['a value above the combat cap', [{ stat: 'lifesteal_bp', valueBp: 2_001 }]],
  ])('refuses %s and creates nothing', async (_label, combatBonuses) => {
    const p = await setup();
    await expect(fixed(p, DEFS.rail, combatBonuses as CombatBonus[])).rejects.toBeInstanceOf(EquipmentValidationError);
    expect((await svc.equipment.listEquipment(p)).items).toEqual([]);
  });

  it('the database refuses a third bonus and a non-array even if code let one through', async () => {
    const p = await setup();
    const id = await fixed(p, DEFS.rail);
    const three = JSON.stringify([1, 2, 3].map((n) => ({ stat: 'crit_chance_bp', valueBp: n })));
    await expectPgError(t.db.execute(sql`update player_equipment set combat_bonuses = ${three}::jsonb where id = ${id}`), '23514');
    await expectPgError(t.db.execute(sql`update player_equipment set combat_bonuses = '{}'::jsonb where id = ${id}`), '23514');
  });
});

/* ───────────────────────── gear that predates the system ───────────────────────── */

describe('equipment from before combat bonuses', () => {
  /** A row written the way the pre-0056 service wrote it: no `combat_bonuses` value at all. */
  async function legacyCopy(playerId: number, def: { key: string; slot: string; multiplierMinBp: number }): Promise<number> {
    const { rows } = await t.db.execute(sql`
      insert into player_equipment (player_id, definition_id, slot, rolled_multiplier_bp, affix_key, source_type)
      select ${playerId}, id, ${def.slot}, ${def.multiplierMinBp}, 'poor_planning', 'boss' from equipment_definitions where key = ${def.key}
      returning id`);
    return Number((rows[0] as { id: number | string }).id);
  }

  it('takes the column default: no bonuses, nothing invented', async () => {
    const p = await setup();
    const id = await legacyCopy(p, DEFS.rail);
    expect((await rowOf(id)).combatBonuses).toEqual([]);
    const owned = (await svc.equipment.getOwned(p, id))!;
    expect(owned).toMatchObject({ rolledMultiplierBp: 11_500, affixKey: 'poor_planning', combatBonuses: [] });
  });

  it('stays equipable, usable in combat and dismantlable, contributing zero modifiers', async () => {
    const p = await setup();
    const attack = await legacyCopy(p, DEFS.rail);
    const defense = await legacyCopy(p, DEFS.vest);
    const health = await legacyCopy(p, DEFS.tank);
    const spare = await legacyCopy(p, DEFS.knife);
    await equip(p, 'attack', attack);
    await equip(p, 'defense', defense);
    await equip(p, 'health', health);
    const stats = await combat.calculateCombatStats(p);
    expect(stats.isComplete).toBe(true);
    expect(stats.stats).toEqual({ attack: 213, defense: 130, maxHp: 481 });
    expect(stats.combatModifiers).toEqual(ZERO_COMBAT_MODIFIERS);

    const outcome = await trials.fight(p, 'cb_trial', `legacy-${p}`);
    expect(outcome.attempt.player.modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
    expect(outcome.attempt.events.some((e) => e.type === 'critical_hit' || e.type === 'lifesteal_heal' || e.type === 'bonus_attack_triggered')).toBe(false);

    const dismantled = await t.db.transaction((tx) =>
      svc.equipment.dismantle(tx, { playerId: p, equipmentIds: [spare], yieldOf: () => 4 }),
    );
    expect(dismantled.copies).toMatchObject([{ equipmentId: spare, combatBonuses: [], components: 4 }]);
  });

  it('a row holding a family this build does not know still loads, without it', async () => {
    const p = await setup();
    const id = await legacyCopy(p, DEFS.knife);
    const stored = JSON.stringify([{ stat: 'retired_family_bp', valueBp: 500 }, { stat: 'lifesteal_bp', valueBp: 200 }]);
    await t.db.execute(sql`update player_equipment set combat_bonuses = ${stored}::jsonb where id = ${id}`);
    expect(await bonusesOf(p, id)).toEqual([{ stat: 'lifesteal_bp', valueBp: 200 }]);
  });
});

/* ───────────────────────── reads ───────────────────────── */

describe('bonuses are per copy on every read', () => {
  it('copies that differ only in their bonuses are different loot in the Gear Bag', async () => {
    const p = await setup();
    const crit: CombatBonus[] = [{ stat: 'crit_chance_bp', valueBp: 425 }];
    const a = await fixed(p, DEFS.knife, crit);
    const b = await fixed(p, DEFS.knife, crit);
    const c = await fixed(p, DEFS.knife, [{ stat: 'crit_chance_bp', valueBp: 450 }]);
    const d = await fixed(p, DEFS.knife);
    const groups = await svc.equipment.listEquipmentGroups(p, { definitionKey: DEFS.knife.key });
    expect(groups.map((g) => ({ ids: g.instanceIds, bonuses: g.combatBonuses })).sort((x, y) => x.ids[0]! - y.ids[0]!)).toEqual([
      { ids: [a, b], bonuses: crit },
      { ids: [c], bonuses: [{ stat: 'crit_chance_bp', valueBp: 450 }] },
      { ids: [d], bonuses: [] },
    ]);
    // The item screen counts only truly identical copies.
    expect((await mgmt.item(p, a)).copies).toEqual([a, b]);
    expect((await mgmt.item(p, d)).copies).toEqual([d]);
  });

  it('the active loadout and the combat stats aggregate the three equipped copies', async () => {
    const p = await setup();
    const attack = await fixed(p, DEFS.rail, [{ stat: 'crit_chance_bp', valueBp: 325 }]);
    const defense = await fixed(p, DEFS.vest, [{ stat: 'crit_chance_bp', valueBp: 200 }]);
    const health = await fixed(p, DEFS.tank, [
      { stat: 'crit_chance_bp', valueBp: 450 },
      { stat: 'lifesteal_bp', valueBp: 275 },
    ]);
    // An unequipped copy contributes nothing.
    await fixed(p, DEFS.knife, [{ stat: 'armor_penetration_bp', valueBp: 800 }]);
    await equip(p, 'attack', attack);
    await equip(p, 'defense', defense);
    await equip(p, 'health', health);

    const stats = await combat.calculateCombatStats(p);
    expect(stats.combatModifiers).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 975, lifestealBp: 275 });
    expect(stats.loadout.slots.health!.combatBonuses).toEqual([
      { stat: 'crit_chance_bp', valueBp: 450 },
      { stat: 'lifesteal_bp', valueBp: 275 },
    ]);
    expect((await svc.equipment.getActiveLoadout(p)).slots.attack!.combatBonuses).toEqual([{ stat: 'crit_chance_bp', valueBp: 325 }]);

    // A what-if swap is aggregated the same way, and never written.
    const spare = await fixed(p, DEFS.rail, [{ stat: 'double_attack_chance_bp', valueBp: 600 }]);
    const preview = await combat.calculateCombatStats(p, { slotOverrides: { attack: spare } });
    expect(preview.combatModifiers).toEqual({ ...ZERO_COMBAT_MODIFIERS, critChanceBp: 650, doubleAttackChanceBp: 600, lifestealBp: 275 });
    expect((await combat.calculateCombatStats(p)).combatModifiers.critChanceBp).toBe(975);
  });

  it('totals are capped in the calculation and the stored rolls are left alone', async () => {
    const p = await setup();
    const big: CombatBonus[] = [{ stat: 'lifesteal_bp', valueBp: 1_500 }];
    const ids = [await fixed(p, DEFS.rail, big), await fixed(p, DEFS.vest, big), await fixed(p, DEFS.tank, big)];
    await equip(p, 'attack', ids[0]!);
    await equip(p, 'defense', ids[1]!);
    await equip(p, 'health', ids[2]!);
    expect((await combat.calculateCombatStats(p)).combatModifiers.lifestealBp).toBe(2_000);
    for (const id of ids) expect((await rowOf(id)).combatBonuses).toEqual(big);
  });
});

/* ───────────────────────── Workshop ───────────────────────── */

describe('Workshop fabrication uses the same roll', () => {
  async function rich() {
    const p = await setup();
    await t.db.update(playerCurrencies).set({ salvagedComponents: 500, waifubux: 50_000 }).where(eq(playerCurrencies.playerId, p));
    return p;
  }

  it('an SR fabrication carries two distinct bonuses, and a retry is the same item', async () => {
    const p = await rich();
    const requestKey = `cb-fab-${p}-00000001`;
    // Definition pick (the only SR attack definition here is among several): leave it to `min`,
    // then multiplier, affix, families 2 and 0-of-rest, magnitudes.
    const first = await workshop.fabricate(p, { recipeKey: 'advanced_rebuild', slot: 'health', requestKey });
    expect(first.replayed).toBe(false);
    expect(first.item.rarity).toBe('SR');
    expect(first.item.combatBonuses).toHaveLength(2);
    expect(first.item.combatBonuses[0]!.stat).not.toBe(first.item.combatBonuses[1]!.stat);
    expect((await rowOf(first.item.equipmentId)).combatBonuses).toEqual(first.item.combatBonuses);

    pick(0, 0, 0, 3, 2, 10, 10);
    const again = await workshop.fabricate(p, { recipeKey: 'advanced_rebuild', slot: 'health', requestKey });
    expect(again.replayed).toBe(true);
    expect(again.item).toEqual(first.item);
    expect((await svc.equipment.listEquipment(p)).items).toHaveLength(1);
  });

  it('dismantle lines show what is being scrapped', async () => {
    const p = await rich();
    const id = await fixed(p, DEFS.knife, [{ stat: 'armor_penetration_bp', valueBp: 750 }]);
    const preview = await workshop.previewDismantle(p, [id]);
    expect(preview.items).toMatchObject([{ equipmentId: id, combatBonuses: [{ stat: 'armor_penetration_bp', valueBp: 750 }] }]);
  });
});

/* ───────────────────────── Combat Trials ───────────────────────── */

describe('Combat Trials snapshot modifiers and fight on a stored seed', () => {
  /** Crit 9.75% · Crit DMG +17.5% · Double 6% · Armor Pen 8% · Lifesteal 2.75%. */
  async function geared() {
    const p = await setup();
    const attack = await fixed(p, DEFS.rail, [
      { stat: 'crit_chance_bp', valueBp: 325 },
      { stat: 'crit_damage_bonus_bp', valueBp: 1_750 },
    ]);
    const defense = await fixed(p, DEFS.vest, [
      { stat: 'crit_chance_bp', valueBp: 200 },
      { stat: 'armor_penetration_bp', valueBp: 800 },
    ]);
    const health = await fixed(p, DEFS.tank, [
      { stat: 'crit_chance_bp', valueBp: 450 },
      { stat: 'lifesteal_bp', valueBp: 275 },
    ]);
    await equip(p, 'attack', attack);
    await equip(p, 'defense', defense);
    await equip(p, 'health', health);
    return { p, attack, defense, health };
  }
  const EXPECTED = { critChanceBp: 975, critDamageBonusBp: 1_750, doubleAttackChanceBp: 0, armorPenetrationBp: 800, lifestealBp: 275 };
  const attemptRow = async (id: number) => (await t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.id, id)))[0]!;

  it('the detail view shows the live aggregated modifiers', async () => {
    const { p } = await geared();
    expect((await trials.detail(p, 'cb_trial')).stats.combatModifiers).toEqual(EXPECTED);
  });

  it('an attempt snapshots the aggregated modifiers into its initial state', async () => {
    const { p } = await geared();
    const { attempt } = await trials.fight(p, 'cb_trial', `snap-${p}`);
    expect(attempt.player.modifiers).toEqual(EXPECTED);
    expect(attempt.enemy.modifiers).toEqual(ZERO_COMBAT_MODIFIERS);
    const row = await attemptRow(attempt.id);
    expect((row.initialState as unknown as CombatState).player.modifiers).toEqual(EXPECTED);
    // Armor Pen reached the engine: DEF 80 → floor(80 × 0.92) = 73.
    const hit = attempt.events.find((e): e is Extract<CombatEvent, { type: 'damage' }> => e.type === 'damage' && e.actor === 'player')!;
    expect(hit).toMatchObject({ targetDefense: 80, effectiveDefense: 73, armorPenetrationBp: 800 });
  });

  it('the seed is derived from the request and stored', async () => {
    const { p } = await geared();
    const { attempt } = await trials.fight(p, 'cb_trial', `seed-${p}`);
    const row = await attemptRow(attempt.id);
    expect(row.combatSeed).toBe(combatTrialSeed(p, 'cb_trial', `seed-${p}`));
    expect(attempt.combatSeed).toBe(row.combatSeed);
    // Stable request data only: same inputs, same seed; any input changed, another.
    expect(combatTrialSeed(p, 'cb_trial', `seed-${p}`)).toBe(row.combatSeed);
    expect(combatTrialSeed(p, 'cb_trial', `seed-${p}x`)).not.toBe(row.combatSeed);
    expect(combatTrialSeed(p + 1, 'cb_trial', `seed-${p}`)).not.toBe(row.combatSeed);
    expect(combatTrialSeed(p, 'other_trial', `seed-${p}`)).not.toBe(row.combatSeed);
    expect(Number.isInteger(row.combatSeed)).toBe(true);
  });

  it('a stored attempt reproduces from its initial state and seed: variance, Crits, final HP, result', async () => {
    const { p } = await geared();
    const { attempt } = await trials.fight(p, 'cb_trial', `replay-${p}`);
    const row = await attemptRow(attempt.id);
    const replay = replayCombatTrialAttempt(row)!;
    expect(replay.events).toEqual(attempt.events);
    expect(replay.result).toBe(attempt.result);
    expect(replay.rounds).toBe(attempt.rounds);
    expect(replay.finalState.player.currentHp).toBe(attempt.player.remainingHp);
    expect(replay.finalState.enemy.currentHp).toBe(attempt.enemy.remainingHp);
    // The fight was not variance-free, so this is a real reproduction.
    const variances = new Set(attempt.events.flatMap((e) => (e.type === 'damage' ? [e.varianceBasisPoints] : [])));
    expect(variances.size).toBeGreaterThan(3);
    expect(runCombatTrialFight(row.initialState as unknown as CombatState, row.combatSeed! + 1).events).not.toEqual(attempt.events);
  });

  it('retrying a request never re-rolls: the same key is the same attempt', async () => {
    const { p } = await geared();
    const first = await trials.fight(p, 'cb_trial', `retry-${p}`);
    for (let i = 0; i < 5; i += 1) {
      const again = await trials.fight(p, 'cb_trial', `retry-${p}`);
      expect(again.replayed).toBe(true);
      expect(again.attempt).toEqual(first.attempt);
    }
    expect(await t.db.select().from(combatTrialAttempts).where(eq(combatTrialAttempts.playerId, p))).toHaveLength(1);
  });

  it('a request that failed before committing fights the identical fight when retried', async () => {
    // Two players in identical gear, Buddy and request data except the id feeding the seed
    // would differ — so prove it on one player by running the pure fight twice from the
    // state the service would build.
    const { p } = await geared();
    const { attempt } = await trials.fight(p, 'cb_trial', `again-${p}`);
    const row = await attemptRow(attempt.id);
    const seed = combatTrialSeed(p, 'cb_trial', `again-${p}`);
    const a = runCombatTrialFight(row.initialState as unknown as CombatState, seed);
    const b = runCombatTrialFight(row.initialState as unknown as CombatState, seed);
    expect(a).toEqual(b);
    expect(a.events).toEqual(attempt.events);
  });

  it('modifiers actually fire across attempts, from the seed alone', async () => {
    const { p } = await geared();
    let crits = 0;
    let heals = 0;
    for (let i = 0; i < 12; i += 1) {
      const { attempt } = await trials.fight(p, 'cb_trial', `fire-${p}-${i}`);
      crits += attempt.events.filter((e) => e.type === 'critical_hit' && e.actor === 'player').length;
      heals += attempt.events.filter((e) => e.type === 'lifesteal_heal' && e.actor === 'player').length;
      for (const e of attempt.events) {
        if (e.type === 'critical_hit') expect(e.critMultiplierBp).toBe(16_750);
        if (e.type === 'bonus_attack_triggered') throw new Error('no Double Attack chance in this loadout');
      }
    }
    expect(crits).toBeGreaterThan(0);
    expect(heals).toBeGreaterThan(0);
  });

  it('later gear changes do not rewrite a stored attempt', async () => {
    const { p, attack } = await geared();
    const { attempt } = await trials.fight(p, 'cb_trial', `frozen-${p}`);
    const before = await attemptRow(attempt.id);

    const plain = await fixed(p, DEFS.rail);
    await equip(p, 'attack', plain);
    await t.db.transaction((tx) => svc.equipment.dismantle(tx, { playerId: p, equipmentIds: [attack], yieldOf: () => 12 }));
    expect((await combat.calculateCombatStats(p)).combatModifiers).toEqual({ ...EXPECTED, critChanceBp: 650, critDamageBonusBp: 0 });

    const after = await attemptRow(attempt.id);
    expect(after).toEqual(before);
    expect((await trials.fight(p, 'cb_trial', `frozen-${p}`)).attempt.player.modifiers).toEqual(EXPECTED);
    // A new attempt fights with the new loadout.
    expect((await trials.fight(p, 'cb_trial', `frozen-${p}-next`)).attempt.player.modifiers.critChanceBp).toBe(650);
  });
});
