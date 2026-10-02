/**
 * A boss snapshots its validated reward table — and each Equipment entry's
 * eligible base definitions — at spawn, and pays only from that snapshot.
 * An admin edit after the announcement reaches the *next* boss: never the one
 * already spawned, its participations, or a payout retried after a crash.
 * Encounters spawned before snapshots existed pay from the live table.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  equipmentEvents,
  guildBossState,
  items,
  playerEquipment,
  playerInventory,
  playerWaifus,
  players,
  rewardTables,
  species,
} from '../../src/db/schema';
import { parseBossRewardSnapshot } from '../../src/modules/bosses/bossRewards';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  createRewardTableService,
  type RewardTableService,
} from '../../src/modules/rewardTables/rewardTableService';
import {
  databaseRewardTableSource,
  loadShippedRewardTables,
  seedRewardTables,
} from '../../src/modules/rewardTables/rewardTableStore';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { unlockEquipment } from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const TABLE = 'standard-scouting-v1';
const ADMIN = '222222222222222222';

let t: TestDb;
let app: App;
let tables: RewardTableService;
let guildDbId: number;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, {
    bossRng: seededRng(77),
    equipmentRng: seededRng(3),
    rewardTables: databaseRewardTableSource,
  });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  const shipped = loadShippedRewardTables(CONTENT_DIR);
  tables = createRewardTableService({ db: t.db, getContent: () => app.content, getShipped: () => shipped });
  const p = await provisionPlayer(app, 'g-boss-snap', 'u-boss-snap');
  guildDbId = p.guildDbId;
  playerId = p.playerId;
  // Gear drops only for players with the Equipment feature.
  await unlockEquipment(t.db, app.gear, playerId);
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(bossParticipations);
  await t.db.delete(bossEncounters);
  await t.db.delete(guildBossState);
  await t.db.delete(playerInventory);
  await t.db.delete(equipmentEvents);
  await t.db.delete(playerEquipment);
  await t.db.update(players).set({ buddyWaifuId: null });
  await t.db.delete(playerWaifus);
  await t.db.delete(rewardTables);
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  for (const key of ['combat_knife', 'semi_auto_sidearm', 'throbbing_mace']) {
    await app.gear.definitions.setEnabled(key, true);
  }
});

/** Replace the live boss table's groups (and table fields) through the admin service. */
async function setLiveTable(groups: unknown[], extra: Record<string, unknown> = {}) {
  const current = (await tables.get('boss', TABLE))!;
  return tables.update(
    'boss',
    TABLE,
    { table: { ...current.table, groups, ...extra }, expectedRevision: current.revision },
    ADMIN,
  );
}

const certainItem = (itemId: string, quantity = 1) => ({
  id: 'only',
  entries: [{ itemId, weight: 1, quantity }],
});
const certainGear = (selector: Record<string, unknown>) => ({
  id: 'gear',
  entries: [],
  equipment: [{ weight: 1, ...selector }],
});

async function spawn() {
  const { encounter } = await app.bosses.forceSpawn(guildDbId);
  const now = new Date();
  await app.bosses.beginScouting(encounter.id, 'c-snap', `m-${encounter.id}`, now);
  return encounter;
}

async function commitBuddy(encounterId: number) {
  const [sp] = await t.db.select({ id: species.id }).from(species).where(eq(species.enabled, true)).limit(1);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: sp!.id, level: 20, xp: 0, baseSp: 120 });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, playerId));
  await app.bosses.commit(encounterId, guildDbId, playerId, { discordUserId: 'u-boss-snap', trainerName: 'Snap' });
}

async function inventorySlugs(): Promise<Record<string, number>> {
  const rows = await t.db
    .select({ slug: items.slug, quantity: playerInventory.quantity })
    .from(playerInventory)
    .innerJoin(items, eq(items.id, playerInventory.itemId))
    .where(eq(playerInventory.playerId, playerId));
  return Object.fromEntries(rows.map((r) => [r.slug, r.quantity]));
}

const ownedGear = () => t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));

describe('the snapshot taken at spawn', () => {
  it('records the live table, its version and each Equipment entry’s eligible definitions', async () => {
    await setLiveTable([certainItem('silk_charm'), certainGear({ slot: 'attack', rarity: 'R' })], { version: 'v-snap' });
    const encounter = await spawn();
    const [row] = await t.db.select().from(bossEncounters).where(eq(bossEncounters.id, encounter.id));
    const snapshot = parseBossRewardSnapshot(row!.rewardSnapshot)!;
    expect(row!.rewardTableVersion).toBe('v-snap');
    expect(snapshot.table).toEqual(await databaseRewardTableSource.bossTable(t.db, TABLE));
    const pools = Object.values(snapshot.equipmentPools);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.length).toBeGreaterThan(0);
    expect(pools[0]!.every((c) => c.slot === 'attack' && c.rarity === 'R')).toBe(true);
  });

  it('does not spawn a boss whose table is disabled in the database', async () => {
    await setLiveTable((await tables.get('boss', TABLE))!.table.groups as unknown[], { enabled: false });
    await expect(app.bosses.forceSpawn(guildDbId)).rejects.toThrow(/No enabled bosses/);
  });

  it('does not spawn a boss whose Equipment entry can no longer pay anything', async () => {
    await setLiveTable([certainGear({ definitionKeys: ['combat_knife'] })]);
    // Valid when saved; the definition is disabled afterwards.
    await app.gear.definitions.setEnabled('combat_knife', false);
    await expect(app.bosses.forceSpawn(guildDbId)).rejects.toThrow(/No enabled bosses/);
  });
});

describe('payout reads only the snapshot', () => {
  it('ignores an item-table edit made after the announcement', async () => {
    await setLiveTable([certainItem('silk_charm', 2)], { buddyXp: 0 });
    const encounter = await spawn();
    await commitBuddy(encounter.id);
    await setLiveTable([certainItem('energy_drink', 5)]);
    await app.bosses.resolve(encounter.id);
    expect(await inventorySlugs()).toEqual({ silk_charm: 2 });
  });

  it('pays a whitelisted definition that was disabled after spawn', async () => {
    await setLiveTable([certainGear({ definitionKeys: ['combat_knife'] })]);
    const encounter = await spawn();
    await commitBuddy(encounter.id);
    await app.gear.definitions.setEnabled('combat_knife', false);
    const result = (await app.bosses.resolve(encounter.id))!;
    expect(result.participants[0]!.equipment?.map((e) => e.definitionKey)).toEqual(['combat_knife']);
    expect(await ownedGear()).toHaveLength(1);
  });

  it('keeps the spawn-time selector when the live Equipment entry is changed', async () => {
    await setLiveTable([certainGear({ slot: 'attack', rarity: 'R' })]);
    const encounter = await spawn();
    await commitBuddy(encounter.id);
    await setLiveTable([certainGear({ slot: 'defense' })]);
    const result = (await app.bosses.resolve(encounter.id))!;
    expect(result.participants[0]!.equipment?.[0]).toMatchObject({ slot: 'attack', rarity: 'R' });
  });

  it('replays the same instance when a payout is retried, even after the table changed', async () => {
    await setLiveTable([certainGear({ slot: 'attack', rarity: 'R' })]);
    const encounter = await spawn();
    await commitBuddy(encounter.id);
    const first = (await app.bosses.resolve(encounter.id))!.participants[0]!.equipment![0]!;

    // A crashed run leaves the claim stale and the participation unpaid; the
    // gear grant it made is found by its key.
    await setLiveTable([certainGear({ slot: 'defense' })]);
    await t.db
      .update(bossEncounters)
      .set({ status: 'resolving', resolvingAt: new Date(Date.now() - 60 * 60_000), resolvedAt: null })
      .where(eq(bossEncounters.id, encounter.id));
    await t.db
      .update(bossParticipations)
      .set({ rewardStatus: 'pending', resolvedAt: null })
      .where(eq(bossParticipations.encounterId, encounter.id));
    const retried = (await app.bosses.resolve(encounter.id))!.participants[0]!.equipment![0]!;

    expect(retried).toEqual(first);
    expect(await ownedGear()).toHaveLength(1);
  });

  it('future bosses use the edited table', async () => {
    await setLiveTable([certainItem('silk_charm')], { buddyXp: 0 });
    const first = await spawn();
    await setLiveTable([certainItem('energy_drink')]);
    await commitBuddy(first.id);
    await app.bosses.resolve(first.id);

    const second = await spawn();
    await commitBuddy(second.id);
    await app.bosses.resolve(second.id);
    expect(await inventorySlugs()).toEqual({ silk_charm: 1, energy_drink: 1 });
  });
});

describe('an encounter spawned before snapshots existed', () => {
  it('pays once from the live table', async () => {
    await setLiveTable([certainItem('silk_charm')], { buddyXp: 0 });
    const encounter = await spawn();
    await t.db.update(bossEncounters).set({ rewardSnapshot: null }).where(inArray(bossEncounters.id, [encounter.id]));
    await commitBuddy(encounter.id);
    await setLiveTable([certainItem('energy_drink', 4)]);
    await app.bosses.resolve(encounter.id);
    expect(await inventorySlugs()).toEqual({ energy_drink: 4 });
  });
});
