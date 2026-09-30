/**
 * Equipment under real concurrency: parallel transactions against one
 * Postgres, no mocks. Each case races the same operation (or two conflicting
 * ones) and asserts there is exactly one authoritative outcome — one row, no
 * lost or duplicated grants, no slot pointing at removed gear — and that every
 * caller got a clear answer rather than an unhandled error.
 */
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  equipmentEvents,
  playerEquipment,
  playerFeatureUnlocks,
  playerLoadoutSlots,
  playerLoadouts,
} from '../../src/db/schema';
import { EquipmentNotOwnedError } from '../../src/shared/errors';
import { createTestDb, type TestDb } from '../helpers/testDb';
import {
  buildEquipmentServices,
  createPlayer,
  defineGear,
  grant,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

const PARALLEL = 8;

let t: TestDb;
let svc: EquipmentServices;

beforeAll(async () => {
  t = await createTestDb();
  svc = buildEquipmentServices(t.db);
  await defineGear(svc, 'attack', 'defense');
});

afterAll(async () => {
  await t?.cleanup();
});

const times = <T>(n: number, fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

describe('concurrent equips into one slot', () => {
  it('leave exactly one row, one loadout, and one event per change', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    const rings: number[] = [];
    for (let i = 0; i < PARALLEL; i++) rings.push(await grant(t.db, svc, player, 'training_ring'));

    // No loadout exists yet, so this also races the loadout's creation.
    const results = await Promise.all(
      rings.map((equipmentId) => svc.equipment.equip(player, { slot: 'attack', equipmentId })),
    );
    expect(results.every((r) => r.changed)).toBe(true);

    const slots = await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, player));
    expect(slots).toHaveLength(1);
    expect(rings).toContain(slots[0]!.equipmentId);

    const [loadouts] = await t.db.select({ n: count() }).from(playerLoadouts).where(eq(playerLoadouts.playerId, player));
    expect(loadouts!.n).toBe(1);

    const events = await t.db
      .select()
      .from(equipmentEvents)
      .where(and(eq(equipmentEvents.playerId, player), eq(equipmentEvents.kind, 'equipped')));
    expect(events).toHaveLength(PARALLEL);
    // Serialised: every change but the first saw the previous one, so the
    // "previous" pointers form a single chain ending at the final item.
    expect(events.filter((e) => e.previousEquipmentId === null)).toHaveLength(1);
    const final = results.map((r) => r.loadout.slots.attack!.id);
    expect(final).toContain(slots[0]!.equipmentId);
  });
});

describe('equip racing admin removal', () => {
  it.each([
    ['with no loadout yet', false],
    ['with an existing loadout', true],
  ])('never leaves a slot pointing at removed gear (%s)', async (_label, preexisting) => {
    for (let round = 0; round < 10; round++) {
      const player = await createPlayer(t.db);
      await unlockEquipment(t.db, svc, player);
      if (preexisting) {
        const other = await grant(t.db, svc, player, 'training_ring');
        await svc.equipment.equip(player, { slot: 'attack', equipmentId: other });
      }
      const ring = await grant(t.db, svc, player, 'training_ring');

      const [equip, remove] = await Promise.allSettled([
        svc.equipment.equip(player, { slot: 'attack', equipmentId: ring }),
        t.db.transaction((tx) =>
          svc.equipment.adminRemove(tx, { playerId: player, equipmentId: ring, reason: 'race', actorDiscordId: 'admin' }),
        ),
      ]);

      // Removal never depends on the equip, so it always lands.
      expect(remove.status).toBe('fulfilled');
      // The equip either won (and the removal then cleared it) or found the
      // gear already gone — never an unexplained failure.
      if (equip.status === 'rejected') expect(equip.reason).toBeInstanceOf(EquipmentNotOwnedError);

      const dangling = await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.equipmentId, ring));
      expect(dangling).toEqual([]);
      const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, ring));
      expect(row!.removedAt).not.toBeNull();
    }
  });
});

describe('concurrent grants with one grant key', () => {
  it('create exactly one instance, and exactly one caller creates it', async () => {
    const player = await createPlayer(t.db);
    const results = await times(PARALLEL, () =>
      t.db.transaction((tx) =>
        svc.equipment.grantEquipment(tx, {
          playerId: player,
          definitionKey: 'training_ring',
          source: { type: 'boss', key: 'oh_pwincess' },
          grantKey: `boss:race:${player}`,
        }),
      ),
    );
    expect(results.filter((r) => !r.alreadyGranted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.instances[0]!.id)).size).toBe(1);
    const [rows] = await t.db.select({ n: count() }).from(playerEquipment).where(eq(playerEquipment.playerId, player));
    expect(rows!.n).toBe(1);
    const [events] = await t.db.select({ n: count() }).from(equipmentEvents).where(eq(equipmentEvents.playerId, player));
    expect(events!.n).toBe(1);
  });

  it('without a key, every grant is its own instance', async () => {
    const player = await createPlayer(t.db);
    await times(PARALLEL, () => grant(t.db, svc, player, 'training_ring'));
    const [rows] = await t.db.select({ n: count() }).from(playerEquipment).where(eq(playerEquipment.playerId, player));
    expect(rows!.n).toBe(PARALLEL);
  });
});

describe('concurrent ensureActiveLoadout', () => {
  it('creates exactly one loadout and hands every caller the same one', async () => {
    const player = await createPlayer(t.db);
    const rows = await times(PARALLEL, () => t.db.transaction((tx) => svc.equipment.ensureActiveLoadout(tx, player)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    const [n] = await t.db.select({ n: count() }).from(playerLoadouts).where(eq(playerLoadouts.playerId, player));
    expect(n!.n).toBe(1);
  });
});

describe('concurrent unlocks', () => {
  it('write one row, and exactly one caller is told it unlocked the feature', async () => {
    const player = await createPlayer(t.db);
    const results = await times(PARALLEL, () =>
      t.db.transaction((tx) =>
        svc.featureUnlocks.unlock(tx, { playerId: player, featureKey: 'equipment', source: 'onboarding' }),
      ),
    );
    expect(results.filter((r) => r.newlyUnlocked)).toHaveLength(1);
    const [n] = await t.db
      .select({ n: count() })
      .from(playerFeatureUnlocks)
      .where(eq(playerFeatureUnlocks.playerId, player));
    expect(n!.n).toBe(1);
  });
});
