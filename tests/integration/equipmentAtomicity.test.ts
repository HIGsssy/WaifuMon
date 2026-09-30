/**
 * Multi-statement equipment writes are atomic even when a caller hands them
 * the bare `Db` rather than a transaction.
 *
 * `DbOrTx` admits both, so `adminRemove(db, …)` type-checks. Each of these
 * methods therefore opens its own transaction (a savepoint when it is already
 * inside one). The proof: a trigger makes the *last* write of each operation
 * fail, and every earlier write must be rolled back with it.
 *
 * Own database, because the triggers affect every write to those tables.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playerEquipment, playerFeatureUnlocks, playerLoadoutSlots } from '../../src/db/schema';
import { createTestDb, type TestDb } from '../helpers/testDb';
import {
  buildEquipmentServices,
  createPlayer,
  defineGear,
  grant,
  unlockEquipment,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

let t: TestDb;
let svc: EquipmentServices;

beforeAll(async () => {
  t = await createTestDb();
  svc = buildEquipmentServices(t.db);
  await defineGear(svc, 'attack');
  // Fail the audit row for these actions, and the `granted` event for one key.
  await t.pool.query(`
    create function fail_marked_writes() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'player_progression_events'
         and new.metadata->>'reason' = 'FAIL_AUDIT' then
        raise exception 'forced audit failure';
      end if;
      if tg_table_name = 'equipment_events'
         and new.metadata->>'grantKey' like 'FAIL_EVENT%' then
        raise exception 'forced event failure';
      end if;
      return new;
    end $$;
    create trigger fail_audit before insert on player_progression_events
      for each row execute function fail_marked_writes();
    create trigger fail_event before insert on equipment_events
      for each row execute function fail_marked_writes();
  `);
});

afterAll(async () => {
  await t?.cleanup();
});

describe('called with the bare Db', () => {
  it('adminRemove rolls the slot clearing and the removal back when the audit fails', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    const ring = await grant(t.db, svc, player, 'training_ring');
    await svc.equipment.equip(player, { slot: 'attack', equipmentId: ring });

    await expect(
      svc.equipment.adminRemove(t.db, { playerId: player, equipmentId: ring, reason: 'FAIL_AUDIT', actorDiscordId: 'admin' }),
    ).rejects.toThrow(/forced audit failure/);

    const [row] = await t.db.select().from(playerEquipment).where(eq(playerEquipment.id, ring));
    expect(row!.removedAt).toBeNull();
    expect(await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.equipmentId, ring))).toHaveLength(1);
  });

  it('grantEquipment rolls the instance back when its event fails', async () => {
    const player = await createPlayer(t.db);
    await expect(
      svc.equipment.grantEquipment(t.db, {
        playerId: player,
        definitionKey: 'training_ring',
        source: { type: 'admin' },
        grantKey: 'FAIL_EVENT-1',
      }),
    ).rejects.toThrow(/forced event failure/);
    expect(await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, player))).toEqual([]);
  });

  it('revoke keeps the unlock when the audit fails', async () => {
    const player = await createPlayer(t.db);
    await unlockEquipment(t.db, svc, player);
    await expect(
      svc.featureUnlocks.revoke(t.db, { playerId: player, featureKey: 'equipment', actorDiscordId: 'admin', reason: 'FAIL_AUDIT' }),
    ).rejects.toThrow(/forced audit failure/);
    expect(await svc.featureUnlocks.isUnlocked(player, 'equipment')).toBe(true);
  });
});

describe('inside a caller transaction', () => {
  it('a caught equipment failure does not poison the caller’s transaction', async () => {
    // A reward path (e.g. an encounter effect) may catch an equipment failure
    // and carry on. The savepoint is what keeps the rest of its transaction
    // usable after a failed statement.
    const player = await createPlayer(t.db);
    const survivor = await t.db.transaction(async (tx) => {
      await svc.equipment
        .grantEquipment(tx, { playerId: player, definitionKey: 'training_ring', source: { type: 'admin' }, grantKey: 'FAIL_EVENT-2' })
        .catch(() => undefined);
      return svc.equipment.grantEquipment(tx, { playerId: player, definitionKey: 'training_ring', source: { type: 'admin' } });
    });
    expect(survivor.newInstanceIds).toHaveLength(1);
    const rows = await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, player));
    expect(rows.map((r) => r.id)).toEqual(survivor.newInstanceIds);
  });

  it('unlock and the feature row still commit with the caller', async () => {
    const player = await createPlayer(t.db);
    await t.db.transaction((tx) => svc.featureUnlocks.unlock(tx, { playerId: player, featureKey: 'equipment', source: 'onboarding' }));
    const rows = await t.db
      .select()
      .from(playerFeatureUnlocks)
      .where(and(eq(playerFeatureUnlocks.playerId, player), eq(playerFeatureUnlocks.featureKey, 'equipment')));
    expect(rows).toHaveLength(1);
  });
});
