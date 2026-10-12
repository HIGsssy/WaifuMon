import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { equipmentEvents, playerEquipment, playerLoadoutSlots } from '../../src/db/schema';
import { DungeonLootTableBodySchema, DungeonRewardBundleSchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { DUNGEON_ID_MAX_LENGTH } from '../../src/modules/dungeons/content/dungeonIdentifiers';
import { resolveRewardBundle } from '../../src/modules/dungeons/engine/lootResolver';
import { equipmentGrantKey, rewardClaimKey } from '../../src/modules/dungeons/engine/rewards';
import { buildAffixCatalogue } from '../../src/modules/equipment/affixCatalogue';
import {
  EQUIPMENT_COMBAT_BONUS_FILE,
  EquipmentCombatBonusFileSchema,
  combatBonusCatalogueFromFile,
} from '../../src/modules/equipment/combatBonuses';
import {
  createEquipmentRewardService,
  type EquipmentRewardGrant,
  type EquipmentRewardService,
  type GrantChosenEquipmentRewardInput,
} from '../../src/modules/equipment/equipmentRewardService';
import { rollEquipmentInstance, type EquipmentRoll } from '../../src/modules/equipment/equipmentRoll';
import { equipmentSelectorKey } from '../../src/modules/equipment/rewardSelector';
import { seededRng } from '../../src/shared/random';
import { buildEquipmentServices, createPlayer, unlockEquipment, type EquipmentServices } from '../helpers/equipmentFixtures';
import { CONTENT_DIR } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const DEFINITION = {
  key: 'seeded_test_gear', name: 'Seeded Test Gear', slot: 'attack', rarity: 'SR',
  multiplierMinBp: 4_000, multiplierMaxBp: 6_000, multiplierStepBp: 500,
} as const;
const AFFIXES = buildAffixCatalogue([0, 1, 2].map((i) => ({
  key: `seeded_flair_${i}`, suffix: `of Seeded Flair ${i}`, pool: 'attack.SR' as const, enabled: true,
})));
const BONUSES = combatBonusCatalogueFromFile(EquipmentCombatBonusFileSchema.parse(
  JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, EQUIPMENT_COMBAT_BONUS_FILE), 'utf8')),
));
const properties = (instance: EquipmentRoll): EquipmentRoll => ({
  rolledMultiplierBp: instance.rolledMultiplierBp,
  affixKey: instance.affixKey,
  combatBonuses: instance.combatBonuses,
});
const expected = (seed: number) => rollEquipmentInstance(DEFINITION, {
  rng: seededRng(seed), affixes: AFFIXES, combatBonuses: BONUSES,
});

let t: TestDb;
let svc: EquipmentServices;
let rewards: EquipmentRewardService;
let playerId: number;
let sharedRng: ReturnType<typeof seededRng>;
let next: MockInstance<() => number>;
let intInclusive: MockInstance<(min: number, max: number) => number>;
const source = { type: 'dungeon', key: 't7_test' } as const;
const pay = (extra: Partial<GrantChosenEquipmentRewardInput> = {}) => t.db.transaction((tx) =>
  rewards.grantChosenEquipmentReward(tx, { playerId, definitionKey: DEFINITION.key, source, ...extra }),
);
const rows = () => t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));
const events = () => t.db.select().from(equipmentEvents).where(eq(equipmentEvents.playerId, playerId));
const expectNoSharedDraws = () => {
  expect(next).not.toHaveBeenCalled();
  expect(intInclusive).not.toHaveBeenCalled();
};

beforeAll(async () => {
  t = await createTestDb();
  await buildEquipmentServices(t.db).definitions.create(DEFINITION);
});
afterAll(async () => { await t?.cleanup(); });
beforeEach(async () => {
  sharedRng = seededRng(99);
  next = vi.spyOn(sharedRng, 'next');
  intInclusive = vi.spyOn(sharedRng, 'intInclusive');
  svc = buildEquipmentServices(t.db, { rng: sharedRng, affixes: AFFIXES, combatBonuses: () => BONUSES });
  rewards = createEquipmentRewardService({
    equipment: svc.equipment, getAffixes: svc.getAffixes, featureUnlocks: svc.featureUnlocks, rng: sharedRng,
  });
  await svc.definitions.setEnabled(DEFINITION.key, true);
  playerId = await createPlayer(t.db);
  await unlockEquipment(t.db, svc, playerId);
});

describe('seeded equipment grants', () => {
  it.each([0, 42, 0xffff_ffff])('seed %i reproduces multiplier, affix and two bonuses without shared RNG', async (rollSeed) => {
    const first = await pay({ rollSeed });
    const second = await pay({ rollSeed });
    expect(properties(first)).toEqual(expected(rollSeed));
    expect(properties(second)).toEqual(properties(first));
    expect(first.combatBonuses).toHaveLength(2);
    expect(first.equipmentId).not.toBe(second.equipmentId);
    expectNoSharedDraws();
  });

  it('a forced rollback removes ownership/events and retry reproduces every rolled property', async () => {
    const grantKey = `t7:rollback:${playerId}`;
    let rolledBack: EquipmentRewardGrant | undefined;
    await expect(t.db.transaction(async (tx) => {
      rolledBack = await rewards.grantChosenEquipmentReward(tx, {
        playerId, definitionKey: DEFINITION.key, source, grantKey, rollSeed: 42,
      });
      expect(await tx.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toHaveLength(1);
      expect(await tx.select().from(equipmentEvents).where(eq(equipmentEvents.playerId, playerId))).toHaveLength(1);
      throw new Error('forced failure after equipment and audit inserts');
    })).rejects.toThrow('forced failure');
    expect(await rows()).toEqual([]);
    expect(await events()).toEqual([]);
    const retry = await pay({ grantKey, rollSeed: 42 });
    expect(properties(retry)).toEqual(properties(rolledBack!));
    expect(retry.alreadyGranted).toBe(false);
    expect(await rows()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    expectNoSharedDraws();
  });

  it('committed chosen-reward replay returns the stored instance before generation or eligibility', async () => {
    const grantKey = `t7:replay:${playerId}`;
    const first = await pay({ grantKey, rollSeed: 42 });
    await svc.definitions.setEnabled(DEFINITION.key, false);
    const grantEquipment = vi.spyOn(svc.equipment, 'grantEquipment');
    const isUnlocked = vi.spyOn(svc.featureUnlocks, 'isUnlocked');
    // Even an unusable seed is irrelevant to a committed replay: no new roll.
    const replay = await pay({ grantKey, rollSeed: Number.NaN });
    expect(replay).toEqual({ ...first, alreadyGranted: true });
    expect(grantEquipment).not.toHaveBeenCalled();
    expect(isUnlocked).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
    expectNoSharedDraws();
  });

  it('core grant-key replay keeps the original instance even with a different seed', async () => {
    const core = (rollSeed: number) => t.db.transaction((tx) => svc.equipment.grantEquipment(tx, {
      playerId, definitionKey: DEFINITION.key, source, grantKey: `t7:core:${playerId}`, rollSeed,
    }));
    const first = await core(42);
    const replay = await core(123);
    expect(replay.instances).toEqual(first.instances);
    expect(replay.newInstanceIds).toEqual([]);
    expect(replay.alreadyGranted).toBe(true);
    expect(await events()).toHaveLength(1);
    expectNoSharedDraws();
  });

  it('distinct seeds can produce different properties', async () => {
    const first = await pay({ rollSeed: 42 });
    const second = await pay({ rollSeed: 123 });
    expect(properties(first)).not.toEqual(properties(second));
  });

  it('seeded copies advance a local stream independently and repeat across grants', async () => {
    const core = () => t.db.transaction((tx) => svc.equipment.grantEquipment(tx, {
      playerId, definitionKey: DEFINITION.key, source, quantity: 3, rollSeed: 42,
    }));
    const rng = seededRng(42);
    const sequence = Array.from({ length: 3 }, () => rollEquipmentInstance(DEFINITION, {
      rng, affixes: AFFIXES, combatBonuses: BONUSES,
    }));
    expect((await core()).instances.map(properties)).toEqual(sequence);
    expect((await core()).instances.map(properties)).toEqual(sequence);
    expect(new Set(sequence.map((roll) => JSON.stringify(roll))).size).toBeGreaterThan(1);
    expectNoSharedDraws();
  });

  it('unseeded chosen and random callers keep the shared stream, unaffected by seeded grants', async () => {
    const reference = seededRng(99);
    const roll = () => rollEquipmentInstance(DEFINITION, { rng: reference, affixes: AFFIXES, combatBonuses: BONUSES });
    expect(properties(await pay())).toEqual(roll());
    const drawsBefore = intInclusive.mock.calls.length;
    await pay({ rollSeed: 42 });
    expect(intInclusive.mock.calls).toHaveLength(drawsBefore);
    expect(properties(await pay())).toEqual(roll());
    // Random rewards still draw the definition before its instance properties.
    reference.intInclusive(0, 0);
    const random = await t.db.transaction((tx) => rewards.grantRandomEquipmentReward(tx, {
      playerId, selector: { definitionKeys: [DEFINITION.key] }, source,
    }));
    expect(properties(random)).toEqual(roll());
  });

  it.each([-1, 0x1_0000_0000, 1.5, NaN, Infinity, -Infinity, '42', null])('rejects invalid fresh rollSeed %s before RNG or writes', async (seed) => {
    await expect(pay({ rollSeed: seed as number })).rejects.toThrow('rollSeed must be an unsigned 32-bit integer');
    await expect(t.db.transaction((tx) => svc.equipment.grantEquipment(tx, {
      playerId, definitionKey: DEFINITION.key, source, rollSeed: seed as number,
    }))).rejects.toBeInstanceOf(RangeError);
    expect(await rows()).toEqual([]);
    expect(await events()).toEqual([]);
    expectNoSharedDraws();
  });

  it('a seeded fixed grant stays dictated and consumes no RNG', async () => {
    const result = await t.db.transaction((tx) => svc.equipment.grantEquipment(tx, {
      playerId, definitionKey: DEFINITION.key, source, rollSeed: 42,
      roll: { kind: 'fixed', rolledMultiplierBp: 4_500, affixKey: null },
    }));
    expect(properties(result.instances[0]!)).toEqual({ rolledMultiplierBp: 4_500, affixKey: null, combatBonuses: [] });
    expectNoSharedDraws();
  });

  it('ownership, source, actor and event properties remain correct and rewards never equip', async () => {
    const grantKey = `t7:audit:${playerId}`;
    const reward = await pay({ rollSeed: 42, grantKey, actorDiscordId: 't7_actor' });
    expect(await rows()).toMatchObject([{
      id: reward.equipmentId, playerId, sourceType: 'dungeon', sourceKey: source.key,
      grantKey: `${grantKey}:0`, grantedBy: 't7_actor', ...properties(reward),
    }]);
    expect(await events()).toMatchObject([{
      playerId, equipmentId: reward.equipmentId, kind: 'granted', actorDiscordId: 't7_actor',
      metadata: { definitionKey: DEFINITION.key, sourceType: 'dungeon', sourceKey: source.key,
        grantKey: `${grantKey}:0`, rollKind: 'random', ...properties(reward) },
    }]);
    expect(await t.db.select().from(playerLoadoutSlots).where(eq(playerLoadoutSlots.playerId, playerId))).toEqual([]);
  });

  it('T2 drops have independent seeds/keys and remain stable after authoring reordering', async () => {
    const grant = { type: 'equipment' as const, selector: { definitionKeys: [DEFINITION.key] } };
    const bundle = DungeonRewardBundleSchema.parse({
      guaranteed: [{ id: 'first', grant }, { id: 'second', grant }], chances: [], tables: [],
    });
    const snapshot = { hash: 't7_test_snapshot', tables: new Map(), equipmentPools: {
      [equipmentSelectorKey(grant.selector)]: [DEFINITION],
    } };
    const place = { roomId: 'room', actionId: 'action' };
    const plan = resolveRewardBundle(bundle, snapshot, 42, place);
    expect(resolveRewardBundle({ ...bundle, guaranteed: [...bundle.guaranteed].reverse() }, snapshot, 42, place)).toEqual(plan);
    const drops = plan.secured.equipment;
    expect(new Set(drops.map((drop) => drop.rollSeed)).size).toBe(2);
    const claimKey = rewardClaimKey(String(playerId), place.roomId, place.actionId);
    const keys = drops.map((drop) => `dungeon:${claimKey}:${drop.dropId}`);
    expect(new Set(keys).size).toBe(2);
    for (const [i, drop] of drops.entries()) {
      const reward = await pay({ definitionKey: drop.definitionKey, rollSeed: drop.rollSeed, grantKey: keys[i]! });
      expect(properties(reward)).toEqual(expected(drop.rollSeed));
      expect(await pay({ rollSeed: drop.rollSeed, grantKey: keys[i]! })).toEqual({ ...reward, alreadyGranted: true });
    }
    expect(new Set((await rows()).map((row) => row.grantKey))).toEqual(new Set(keys.map((key) => `${key}:0`)));
    expect(await events()).toHaveLength(2);
    expectNoSharedDraws();
  });

  it('max-length T2 drop IDs fit unbounded text and cannot collide with legacy numeric keys', async () => {
    const id = 'a'.repeat(DUNGEON_ID_MAX_LENGTH);
    const grant = { type: 'equipment' as const, selector: { definitionKeys: [DEFINITION.key] } };
    const table = DungeonLootTableBodySchema.parse({ guaranteed: [], chances: [], pools: [{
      id, name: 'Maximum ID', draws: 10, entries: [{ id, weight: 1, grant }],
    }] });
    const bundle = DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [{ id, table: 'test_table', draws: 1 }] });
    const snapshot = { hash: 't7_long_keys', tables: new Map([['test_table', table]]), equipmentPools: {
      [equipmentSelectorKey(grant.selector)]: [DEFINITION],
    } };
    const plan = resolveRewardBundle(bundle, snapshot, 42, { roomId: id, actionId: id });
    const claimKey = rewardClaimKey('9223372036854775807', id, id);
    const legacy = equipmentGrantKey(claimKey, 0);
    expect(legacy).toBe(`dungeon:${claimKey}:0`);
    const { rows: columns } = await t.pool.query(
      "SELECT data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'player_equipment' AND column_name = 'grant_key'",
    );
    expect(columns).toEqual([{ data_type: 'text', character_maximum_length: null }]);
    for (const drop of plan.secured.equipment) {
      const grantKey = `dungeon:${claimKey}:${drop.dropId}`;
      expect(drop.dropId).toHaveLength(89);
      expect(`${grantKey}:0`).toHaveLength(205);
      expect(drop.dropId).toMatch(/^[gct]:/);
      expect(grantKey).not.toBe(legacy);
      await pay({ grantKey, rollSeed: drop.rollSeed });
    }
    expect(await rows()).toHaveLength(10);
    // Exercise a key beyond the design's approximate 220-character estimate too.
    const longKey = `t7:${'x'.repeat(1024)}`;
    await pay({ grantKey: longKey, rollSeed: 42 });
    expect((await rows()).some((row) => row.grantKey === `${longKey}:0`)).toBe(true);
  });
});
