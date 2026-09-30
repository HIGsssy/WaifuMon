/**
 * The combat-stat service against a real Buddy: Current SP from the copy's
 * Base SP and level, the active loadout, preview overrides that never write,
 * and the null-not-zero rule for anything unavailable.
 *
 * Uses the full `bootstrapApp` so the Buddy is resolved by the production
 * collection service, self-heal included.
 */
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentEvents,
  playerEquipment,
  playerLoadoutSlots,
  playerLoadouts,
  playerWaifus,
  species as speciesTable,
} from '../../src/db/schema';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import {
  EquipmentNotOwnedError,
  EquipmentSlotMismatchError,
  WaifuNotOwnedError,
} from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import {
  buildEquipmentServices,
  defineGear,
  grant,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

let t: TestDb;
let app: App;
let svc: EquipmentServices;
let combat: CombatStatsService;
let speciesId: number;
let speciesName: string;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  svc = buildEquipmentServices(t.db);
  combat = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
  });
  await defineGear(svc, 'attack', 'attack2', 'defense', 'health');
  const [row] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  speciesId = row!.id;
  speciesName = row!.name;
});

afterAll(async () => {
  await t?.cleanup();
});

let seq = 0;
async function setup() {
  seq += 1;
  const { playerId } = await provisionPlayer(app, `g-cs-${seq}`, `u-cs-${seq}`);
  await unlockEquipment(t.db, svc, playerId);
  // Base 100 at level 1 → Current SP 100. Base 150 at level 21 → 150 × 60/40 = 225.
  const weak = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 1, baseSp: 100 });
  const strong = await insertOwnedWaifu(t.db, { playerId, speciesId, level: 21, baseSp: 150, nickname: 'Champ' });
  const ring = await grant(t.db, svc, playerId, 'training_ring'); // ×0.50
  const coil = await grant(t.db, svc, playerId, 'plasma_coil_ring'); // ×0.86
  const belt = await grant(t.db, svc, playerId, 'padded_belt'); // ×0.40
  const harness = await grant(t.db, svc, playerId, 'basic_harness'); // ×2.00
  return { playerId, weak, strong, ring, coil, belt, harness };
}

async function equipAll(playerId: number, ids: { attack: number; defense: number; health: number }) {
  await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ids.attack });
  await svc.equipment.equip(playerId, { slot: 'defense', equipmentId: ids.defense });
  await svc.equipment.equip(playerId, { slot: 'health', equipmentId: ids.health });
}

async function writeCounts(playerId: number) {
  const [slots] = await t.db.select({ n: count() }).from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId));
  const [events] = await t.db.select({ n: count() }).from(equipmentEvents).where(eq(equipmentEvents.playerId, playerId));
  const [loadouts] = await t.db.select({ n: count() }).from(playerLoadouts).where(eq(playerLoadouts.playerId, playerId));
  const [instances] = await t.db.select({ n: count() }).from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
  const rows = await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId));
  return { slots: slots!.n, events: events!.n, loadouts: loadouts!.n, instances: instances!.n, rows };
}

describe('calculateCombatStats', () => {
  it('reports no_buddy with every stat null when there is no Buddy', async () => {
    const { playerId, ring, belt, harness } = await setup();
    await equipAll(playerId, { attack: ring, defense: belt, health: harness });
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.buddy).toBeNull();
    expect(stats.stats).toEqual({ attack: null, defense: null, maxHp: null });
    expect(stats).toMatchObject({ isComplete: false, unavailableReason: 'no_buddy', missingSlots: [] });
  });

  it('leaves unequipped stats null — no fallback multipliers', async () => {
    const { playerId, weak, ring } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    let stats = await combat.calculateCombatStats(playerId);
    expect(stats.buddy).toMatchObject({ waifuId: weak.id, baseSp: 100, level: 1, currentSp: 100, name: speciesName });
    expect(stats.stats).toEqual({ attack: null, defense: null, maxHp: null });
    expect(stats.loadout.loadoutId).toBeNull();
    expect(stats).toMatchObject({ isComplete: false, unavailableReason: 'incomplete_loadout' });

    await svc.equipment.equip(playerId, { slot: 'attack', equipmentId: ring });
    stats = await combat.calculateCombatStats(playerId);
    expect(stats.stats).toEqual({ attack: 50, defense: null, maxHp: null });
    expect(stats.missingSlots).toEqual(['defense', 'health']);
  });

  it('derives every stat from Current SP for a complete loadout', async () => {
    const { playerId, weak, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.stats).toEqual({ attack: 86, defense: 40, maxHp: 200 });
    expect(stats).toMatchObject({ isComplete: true, unavailableReason: null, appliedEffects: [] });
    expect(stats.loadout.slots.attack).toMatchObject({ equipmentId: coil, definitionKey: 'plasma_coil_ring', multiplierBp: 8_600 });
  });

  it('recalculates when the Buddy changes — no gear moves', async () => {
    const { playerId, weak, strong, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    await app.collection.setBuddy(playerId, strong.id);
    const stats = await combat.calculateCombatStats(playerId);
    // Current SP 225: 225 × 0.86 = 193.5 → 194 (half up); × 0.40 = 90; × 2.00 = 450.
    expect(stats.buddy).toMatchObject({ waifuId: strong.id, currentSp: 225, baseSp: 150, level: 21, name: 'Champ' });
    expect(stats.stats).toEqual({ attack: 194, defense: 90, maxHp: 450 });
  });

  it('can calculate for a named copy instead of the Buddy', async () => {
    const { playerId, weak, strong, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    const preview = await combat.calculateCombatStats(playerId, { buddyWaifuId: strong.id });
    expect(preview.stats.attack).toBe(194);

    const other = await setup();
    await expect(combat.calculateCombatStats(playerId, { buddyWaifuId: other.weak.id })).rejects.toBeInstanceOf(WaifuNotOwnedError);
    await t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, strong.id));
    await expect(combat.calculateCombatStats(playerId, { buddyWaifuId: strong.id })).rejects.toBeInstanceOf(WaifuNotOwnedError);
  });

  it.each([Number.NaN, 0, -1, 1.5])('refuses the malformed copy id %s as not owned', async (buddyWaifuId) => {
    const { playerId } = await setup();
    await expect(combat.calculateCombatStats(playerId, { buddyWaifuId })).rejects.toBeInstanceOf(WaifuNotOwnedError);
  });

  it('treats a released Buddy as no Buddy', async () => {
    const { playerId, weak, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    await t.db.update(playerWaifus).set({ releasedAt: new Date() }).where(eq(playerWaifus.id, weak.id));
    const stats = await combat.calculateCombatStats(playerId);
    expect(stats.unavailableReason).toBe('no_buddy');
    expect(stats.stats.attack).toBeNull();
  });

  it('keeps counting gear whose definition was disabled', async () => {
    const { playerId, weak, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    await svc.definitions.setEnabled('plasma_coil_ring', false);
    try {
      expect((await combat.calculateCombatStats(playerId)).stats.attack).toBe(86);
    } finally {
      await svc.definitions.setEnabled('plasma_coil_ring', true);
    }
  });
});

describe('slot overrides (preview)', () => {
  it('previews a swap, and an empty slot, without writing anything', async () => {
    const { playerId, weak, ring, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    await equipAll(playerId, { attack: ring, defense: belt, health: harness });
    const before = await writeCounts(playerId);

    const swapped = await combat.calculateCombatStats(playerId, { slotOverrides: { attack: coil } });
    expect(swapped.stats).toEqual({ attack: 86, defense: 40, maxHp: 200 });
    const emptied = await combat.calculateCombatStats(playerId, { slotOverrides: { health: null } });
    expect(emptied.stats).toEqual({ attack: 50, defense: 40, maxHp: null });
    expect(emptied.missingSlots).toEqual(['health']);

    expect(await writeCounts(playerId)).toEqual(before);
    expect((await combat.calculateCombatStats(playerId)).stats.attack).toBe(50);
  });

  it('previews for a player with no loadout at all, still without creating one', async () => {
    const { playerId, weak, coil } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    const stats = await combat.calculateCombatStats(playerId, { slotOverrides: { attack: coil } });
    expect(stats.stats.attack).toBe(86);
    expect(stats.loadout.loadoutId).toBeNull();
    expect((await writeCounts(playerId)).loadouts).toBe(0);
  });

  it('validates overrides exactly as equip does', async () => {
    const { playerId, weak, belt } = await setup();
    await app.collection.setBuddy(playerId, weak.id);
    const other = await setup();
    await expect(combat.calculateCombatStats(playerId, { slotOverrides: { attack: other.ring } })).rejects.toBeInstanceOf(
      EquipmentNotOwnedError,
    );
    await expect(combat.calculateCombatStats(playerId, { slotOverrides: { attack: belt } })).rejects.toBeInstanceOf(
      EquipmentSlotMismatchError,
    );
    await t.db.transaction((tx) =>
      svc.equipment.adminRemove(tx, { playerId, equipmentId: belt, reason: 'test', actorDiscordId: 'admin' }),
    );
    await expect(combat.calculateCombatStats(playerId, { slotOverrides: { defense: belt } })).rejects.toBeInstanceOf(
      EquipmentNotOwnedError,
    );
  });
});

describe('snapshotCombatStats', () => {
  it('matches the live calculation and is JSON-safe for storage', async () => {
    const { playerId, strong, coil, belt, harness } = await setup();
    await app.collection.setBuddy(playerId, strong.id);
    await equipAll(playerId, { attack: coil, defense: belt, health: harness });
    const snapshot = await t.db.transaction((tx) => combat.snapshotCombatStats(tx, playerId));
    expect(snapshot).toEqual(await combat.calculateCombatStats(playerId));
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
