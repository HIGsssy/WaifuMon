/**
 * The shipped base Attack/Defense catalogue against a real database: the
 * insert-missing seed adds it without touching edited rows, random grants of
 * every rarity roll inside the authored range and from the definition's own
 * `slot.rarity` affix pool, and the Equipment screens render the longest
 * generated names intact.
 *
 * Uses the shipped affix catalogue and the service's real RNG — every
 * assertion here holds for any roll.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { equipmentDefinitions, players, species as speciesTable } from '../../src/db/schema';
import {
  buildEquipmentHome,
  buildGearBag,
  buildItemDetail,
  buildSlotScreen,
} from '../../src/discord/equipmentPresenter';
import { affixPoolOf, buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import { createCombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  createEquipmentManagementService,
  type EquipmentManagementService,
} from '../../src/modules/equipment/equipmentManagementService';
import { isMultiplierInRange } from '../../src/modules/equipment/equipmentRoll';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { buildEquipmentServices, grant, unlockEquipment, type EquipmentServices } from '../helpers/equipmentFixtures';

const shipped = loadEquipmentSeedCatalogue(CONTENT_DIR);
const STARTERS = ['rusty_pipe', 'scrap_plate', 'dented_lunchbox'];

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let mgmt: EquipmentManagementService;
let speciesId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  const affixes = buildAffixCatalogue(app.content.equipmentAffixes ?? []);
  svc = buildEquipmentServices(t.db, { affixes });
  const combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  mgmt = createEquipmentManagementService({ equipment: svc.equipment, combatStats: combat, featureUnlocks: svc.featureUnlocks });
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
async function setupUnlocked(): Promise<number> {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-base-${seq}`, `u-base-${seq}`);
  const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 100 });
  await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
  await unlockEquipment(t.db, svc, playerId);
  return playerId;
}

async function definitionRow(key: string) {
  const [row] = await t.db.select().from(equipmentDefinitions).where(eq(equipmentDefinitions.key, key));
  return row;
}

// Runs first: the seed is what every later test grants from.
describe('startup insert-missing seed', () => {
  it('adds the new definitions to a database that already has the starters, and keeps an edited one', async () => {
    // A live server from before this catalogue: only the starters, one of them admin-edited.
    const starters = shipped.filter((d) => STARTERS.includes(d.key));
    await seedEquipmentDefinitions(t.db, { catalogue: starters });
    const pipe = shipped.find((d) => d.key === 'rusty_pipe')!;
    await svc.definitions.update('rusty_pipe', { ...pipe, name: 'Admin Pipe', multiplierMaxBp: 7_000 });

    const first = await seedEquipmentDefinitions(t.db, { catalogue: shipped });
    expect(first.created).toHaveLength(18);
    expect(first.created).not.toEqual(expect.arrayContaining(STARTERS));
    expect(first.skipped).toEqual(STARTERS);
    expect(await definitionRow('rusty_pipe')).toMatchObject({ name: 'Admin Pipe', multiplierMaxBp: 7_000 });

    // A new definition edited after seeding survives the next restart too.
    const cloak = shipped.find((d) => d.key === 'phase_cloak')!;
    await svc.definitions.update('phase_cloak', { ...cloak, description: 'Edited by an admin.', multiplierMaxBp: 10_500 });
    const second = await seedEquipmentDefinitions(t.db, { catalogue: shipped });
    expect(second).toEqual({ created: [], updated: [], skipped: shipped.map((d) => d.key) });
    expect(await definitionRow('phase_cloak')).toMatchObject({ description: 'Edited by an admin.', multiplierMaxBp: 10_500 });
    expect(await definitionRow('railcarbine')).toMatchObject({ rarity: 'SR', multiplierMinBp: 9_500, multiplierMaxBp: 12_000 });

    // Restore the shipped values for the grant tests below.
    await svc.definitions.update('rusty_pipe', pipe);
    await svc.definitions.update('phase_cloak', cloak);
  });
});

describe('random grants', () => {
  it.each([
    ['starter_pistol', 'attack.N'],
    ['combat_knife', 'attack.R'],
    ['railcarbine', 'attack.SR'],
    ['riot_shield_cracked', 'defense.N'],
    ['tower_shield', 'defense.R'],
    ['phase_cloak', 'defense.SR'],
  ])('%s rolls inside its authored range, affixed from %s', async (key, pool) => {
    const playerId = await setupUnlocked();
    const def = shipped.find((d) => d.key === key)!;
    expect(affixPoolOf(def)).toBe(pool);
    const instances = [];
    for (let i = 0; i < 3; i++) {
      const result = await t.db.transaction((tx) =>
        svc.equipment.grantEquipment(tx, { playerId, definitionKey: key, quantity: 5, source: { type: 'admin', key: 'test' } }),
      );
      instances.push(...result.instances);
    }
    expect(instances).toHaveLength(15);
    for (const instance of instances) {
      expect(isMultiplierInRange(def, instance.rolledMultiplierBp), String(instance.rolledMultiplierBp)).toBe(true);
      expect(instance.affixKey).not.toBeNull();
      expect(svc.getAffixes().get(instance.affixKey!)?.pool).toBe(pool);
    }
  });
});

describe('Equipment screens', () => {
  /** Every component label in a payload, for the Discord length limits. */
  function labels(payload: { components?: readonly unknown[] | undefined }): string[] {
    const json = JSON.stringify((payload.components ?? []).map((c) => (c as { toJSON(): unknown }).toJSON()));
    return [...json.matchAll(/"label":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
  }
  const embedText = (payload: { embeds?: readonly unknown[] | undefined }) =>
    JSON.stringify((payload.embeds ?? []).map((e) => (e as { toJSON(): unknown }).toJSON()));

  /** The longest suffix in a definition's pool — the worst case for its name. */
  function longestAffix(key: string): string {
    const def = shipped.find((d) => d.key === key)!;
    const pool = (app.content.equipmentAffixes ?? []).filter((a) => a.pool === affixPoolOf(def) && a.enabled);
    return pool.reduce((a, b) => (b.suffix.length > a.suffix.length ? b : a)).key;
  }

  it('render the longest generated names whole, within component limits', async () => {
    const playerId = await setupUnlocked();
    const long = ['throwing_knives', 'suction_cup_morningstar', 'ballistic_vest_expired', 'railcarbine', 'phase_cloak'];
    const ids: Record<string, number> = {};
    for (const key of long) {
      const def = shipped.find((d) => d.key === key)!;
      ids[key] = await grant(t.db, svc, playerId, key, {
        roll: { kind: 'fixed', rolledMultiplierBp: def.multiplierMaxBp, affixKey: longestAffix(key) },
      });
    }
    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ids.throwing_knives! });
    await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: ids.ballistic_vest_expired! });

    const names = await Promise.all(long.map(async (key) => (await svc.equipment.getOwned(playerId, ids[key]!))!.displayName));
    expect(names[0]).toMatch(/^Throwing Knives \(Set of 3\) of /);

    const home = buildEquipmentHome((await mgmt.home(playerId)).stats);
    expect(embedText(home)).toContain(JSON.stringify(names[0]).slice(1, -1));
    expect(embedText(home)).toContain(JSON.stringify(names[2]).slice(1, -1));

    const bag = buildGearBag(await mgmt.bag(playerId, 'all', 0));
    for (const name of names) expect(embedText(bag)).toContain(JSON.stringify(name).slice(1, -1));
    const bagLabels = labels(bag);
    for (const name of names) expect(bagLabels.some((l) => l.startsWith(name)), name).toBe(true);

    const slot = buildSlotScreen(await mgmt.slot(playerId, 'attack', 0));
    for (const payload of [home, bag, slot]) {
      for (const label of labels(payload)) expect(label.length, label).toBeLessThanOrEqual(100);
    }

    for (const key of long) {
      const detail = buildItemDetail(await mgmt.item(playerId, ids[key]!), { kind: 'home' });
      const title = (detail.embeds![0] as { toJSON(): { title?: string } }).toJSON().title!;
      expect(title.length).toBeLessThanOrEqual(256);
      expect(title).toContain(names[long.indexOf(key)]);
      for (const label of labels(detail)) expect(label.length, label).toBeLessThanOrEqual(80);
    }
  });
});
