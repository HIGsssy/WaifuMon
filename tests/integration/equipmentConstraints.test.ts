/**
 * The equipment invariants the *database* enforces, proven with raw SQL that
 * bypasses the service entirely. If a future code path forgets a check, these
 * constraints are what still refuse the row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/testDb';
import {
  buildEquipmentServices,
  createPlayer,
  defineGear,
  expectPgError,
  grant,
  type EquipmentServices,
} from '../helpers/equipmentFixtures';

const FK = '23503';
const UNIQUE = '23505';
const CHECK = '23514';

let t: TestDb;
let svc: EquipmentServices;
let alice: number;
let bob: number;
let aliceAttack: number;
let aliceDefense: number;
let bobAttack: number;
let aliceLoadout: number;

async function q(text: string, params: unknown[] = []) {
  return t.pool.query(text, params);
}

beforeAll(async () => {
  t = await createTestDb();
  svc = buildEquipmentServices(t.db);
  await defineGear(svc, 'attack', 'defense');
  alice = await createPlayer(t.db, 'alice');
  bob = await createPlayer(t.db, 'bob');
  aliceAttack = await grant(t.db, svc, alice, 'training_ring');
  aliceDefense = await grant(t.db, svc, alice, 'padded_belt');
  bobAttack = await grant(t.db, svc, bob, 'training_ring');
  const { rows } = await q(
    `insert into player_loadouts (player_id, name, is_active) values ($1, 'Default', true) returning id`,
    [alice],
  );
  aliceLoadout = Number(rows[0].id);
});

afterAll(async () => {
  await t?.cleanup();
});

function slotRow(loadoutId: number, playerId: number, slot: string, equipmentId: number) {
  return q(
    `insert into player_loadout_slots (loadout_id, player_id, slot, equipment_id) values ($1, $2, $3, $4)`,
    [loadoutId, playerId, slot, equipmentId],
  );
}

describe('player_loadout_slots', () => {
  it("refuses another player's instance", async () => {
    // Claimed as Alice's row: the (equipment, player, slot) key does not exist.
    await expectPgError(slotRow(aliceLoadout, alice, 'attack', bobAttack), FK);
    // Claimed as Bob's row: the (loadout, player) key does not exist.
    await expectPgError(slotRow(aliceLoadout, bob, 'attack', bobAttack), FK);
  });

  it('refuses an instance in the wrong slot', async () => {
    await expectPgError(slotRow(aliceLoadout, alice, 'attack', aliceDefense), FK);
    await expectPgError(slotRow(aliceLoadout, alice, 'defense', aliceAttack), FK);
  });

  it('refuses a second item in the same slot of one loadout', async () => {
    const second = await grant(t.db, svc, alice, 'training_ring');
    await slotRow(aliceLoadout, alice, 'attack', aliceAttack);
    await expectPgError(slotRow(aliceLoadout, alice, 'attack', second), UNIQUE);
    await q(`delete from player_loadout_slots where loadout_id = $1`, [aliceLoadout]);
  });

  it('refuses an unknown slot', async () => {
    await expectPgError(slotRow(aliceLoadout, alice, 'relic', aliceAttack), CHECK);
  });

  it('allows one instance in several loadouts (presets)', async () => {
    const { rows } = await q(
      `insert into player_loadouts (player_id, name, is_active) values ($1, 'Boss Killer', false) returning id`,
      [alice],
    );
    const preset = Number(rows[0].id);
    await slotRow(aliceLoadout, alice, 'attack', aliceAttack);
    await slotRow(preset, alice, 'attack', aliceAttack);
    const { rows: count } = await q(
      `select count(*)::int as n from player_loadout_slots where equipment_id = $1`,
      [aliceAttack],
    );
    expect(count[0].n).toBe(2);
    await q(`delete from player_loadout_slots where equipment_id = $1`, [aliceAttack]);
  });

  it('refuses to hard-delete an equipped instance', async () => {
    await slotRow(aliceLoadout, alice, 'attack', aliceAttack);
    await expectPgError(q(`delete from player_equipment where id = $1`, [aliceAttack]), FK);
    await q(`delete from player_loadout_slots where equipment_id = $1`, [aliceAttack]);
  });
});

describe('player_loadouts', () => {
  it('allows only one active loadout per player', async () => {
    await expectPgError(
      q(`insert into player_loadouts (player_id, name, is_active) values ($1, 'Second', true)`, [alice]),
      UNIQUE,
    );
  });

  it('refuses two loadouts with the same name, case-insensitively', async () => {
    await expectPgError(
      q(`insert into player_loadouts (player_id, name) values ($1, 'default')`, [alice]),
      UNIQUE,
    );
  });

  it('refuses a blank name', async () => {
    await expectPgError(q(`insert into player_loadouts (player_id, name) values ($1, '  ')`, [bob]), CHECK);
  });
});

describe('player_equipment', () => {
  it('refuses a duplicate grant key', async () => {
    await grant(t.db, svc, alice, 'training_ring', { grantKey: 'dup-test' });
    const { rows } = await q(`select definition_id from player_equipment where id = $1`, [aliceAttack]);
    await expectPgError(
      q(
        `insert into player_equipment (player_id, definition_id, slot, source_type, grant_key)
         values ($1, $2, 'attack', 'admin', 'dup-test:0')`,
        [bob, rows[0].definition_id],
      ),
      UNIQUE,
    );
  });

  it('refuses an unknown source type', async () => {
    const { rows } = await q(`select definition_id from player_equipment where id = $1`, [aliceAttack]);
    await expectPgError(
      q(
        `insert into player_equipment (player_id, definition_id, slot, source_type) values ($1, $2, 'attack', 'lootbox')`,
        [alice, rows[0].definition_id],
      ),
      CHECK,
    );
  });

  it('refuses a removal without a reason', async () => {
    await expectPgError(q(`update player_equipment set removed_at = now() where id = $1`, [aliceAttack]), CHECK);
  });
});

describe('equipment_definitions', () => {
  it('refuses a hard delete while any instance references it', async () => {
    await expectPgError(q(`delete from equipment_definitions where key = 'training_ring'`), FK);
  });

  it('refuses a definition that does not affect its own stat', async () => {
    await expectPgError(
      q(`insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('bad', 'Bad', 'defense', 'N', 5000)`),
      CHECK,
    );
  });

  it('refuses multipliers over the ceiling', async () => {
    await expectPgError(
      q(`insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('huge', 'Huge', 'attack', 'N', 20001)`),
      CHECK,
    );
  });

  it('refuses an unknown slot, rarity or region', async () => {
    await expectPgError(
      q(`insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('r1', 'R', 'relic', 'N', 1)`),
      CHECK,
    );
    await expectPgError(
      q(`insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('r2', 'R', 'attack', 'Z', 1)`),
      CHECK,
    );
    await expectPgError(
      q(
        `insert into equipment_definitions (key, name, slot, rarity, attack_bp, region_id) values ('r3', 'R', 'attack', 'N', 1, 'narnia')`,
      ),
      CHECK,
    );
  });

  it('refuses a duplicate key', async () => {
    await expectPgError(
      q(`insert into equipment_definitions (key, name, slot, rarity, attack_bp) values ('training_ring', 'X', 'attack', 'N', 1)`),
      UNIQUE,
    );
  });
});

describe('player_feature_unlocks', () => {
  it('refuses an unknown feature key or source', async () => {
    await expectPgError(
      q(`insert into player_feature_unlocks (player_id, feature_key, source) values ($1, 'dungeon', 'admin')`, [alice]),
      CHECK,
    );
    await expectPgError(
      q(`insert into player_feature_unlocks (player_id, feature_key, source) values ($1, 'equipment', 'gift')`, [alice]),
      CHECK,
    );
  });

  it('allows one row per player and feature', async () => {
    await q(`insert into player_feature_unlocks (player_id, feature_key, source) values ($1, 'equipment', 'admin')`, [bob]);
    await expectPgError(
      q(`insert into player_feature_unlocks (player_id, feature_key, source) values ($1, 'equipment', 'onboarding')`, [bob]),
      UNIQUE,
    );
  });
});
