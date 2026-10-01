/**
 * Equipment as a boss reward: a reward group's `equipment` entry competes in
 * the group's normal gate and weighted pick, and a winning draw is paid
 * through the shared Equipment reward path inside the participation's payout
 * transaction. The boss decides *whether* gear drops; the reward service picks
 * the base definition (with a draw derived from the participation, so a retry
 * picks the same one); `grantEquipment` rolls the instance.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bossEncounters,
  bossParticipations,
  equipmentEvents,
  guildBossState,
  playerEquipment,
  playerInventory,
  playerWaifus,
  players,
  species,
  type BossEncounterRow,
} from '../../src/db/schema';
import { buildMyResult } from '../../src/discord/bossPresenter';
import type { BossEquipmentRewardView } from '../../src/modules/bosses/bossEncounterService';
import { bossDrawRng } from '../../src/modules/bosses/bossRandom';
import { listRewardableDefinitions } from '../../src/modules/equipment/equipmentRewardService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { eligibleRewardDefinitions, pickRewardDefinition } from '../../src/modules/equipment/rewardSelector';
import type { BossRewardTable } from '../../src/modules/content/schemas';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { TEST_AFFIXES } from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let guildDbId: number;
let playerIds: number[] = [];
let shippedTables: BossRewardTable[];

const MINUTE = 60_000;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { bossRng: seededRng(1234), equipmentRng: seededRng(5) });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  const players4 = [];
  for (let i = 0; i < 4; i += 1) players4.push(await provisionPlayer(app, 'g-boss-gear', `u-boss-gear-${i}`));
  guildDbId = players4[0]!.guildDbId;
  playerIds = players4.map((p) => p.playerId);
  shippedTables = JSON.parse(JSON.stringify(app.content.bossRewards));
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
  for (const key of ['combat_knife', 'semi_auto_sidearm', 'throbbing_mace']) await app.gear.definitions.setEnabled(key, true);
});
afterEach(() => {
  app.content.bossRewards.length = 0;
  app.content.bossRewards.push(...JSON.parse(JSON.stringify(shippedTables)));
});

/** Replace the first table's groups — the one `openEncounter` pays from. */
function withGroups(groups: unknown[]): BossRewardTable {
  const table = app.content.bossRewards[0]!;
  table.groups = groups as BossRewardTable['groups'];
  return table;
}

const certainGear = (equipment: Record<string, unknown>[]) => ({
  id: 'gear',
  enabled: true,
  rolls: 1,
  chanceBasisPoints: 10_000,
  entries: [],
  equipment: equipment.map((e) => ({ enabled: true, weight: 1, ...e })),
});

async function giveBuddy(playerId: number): Promise<void> {
  const [sp] = await t.db.select({ id: species.id }).from(species).where(eq(species.enabled, true)).limit(1);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: sp!.id, level: 20, xp: 0, baseSp: 120 });
  await t.db.update(players).set({ buddyWaifuId: waifu.id }).where(eq(players.id, playerId));
}

async function openEncounter(): Promise<BossEncounterRow> {
  const boss = app.content.bosses[0]!;
  const now = new Date();
  const [row] = await t.db
    .insert(bossEncounters)
    .values({
      guildId: guildDbId,
      region: 'waifu-valley',
      bossId: boss.id,
      bossName: boss.name,
      bossAffinity: boss.affinity,
      bossArtwork: null,
      rewardTable: app.content.bossRewards[0]!.id,
      rewardTableVersion: 'test',
      calcVersion: 1,
      affinityVersion: 1,
      channelId: 'c-boss-gear',
      messageId: 'm-gear',
      status: 'scouting',
      scheduledAt: now,
      scoutingStartedAt: now,
      deadlineAt: new Date(now.getTime() + 60 * MINUTE),
    })
    .returning();
  return row!;
}

/** Open, commit `count` players, resolve. Returns each participant's gear, in commit order. */
async function fight(count = 1) {
  const encounter = await openEncounter();
  for (const [i, playerId] of playerIds.slice(0, count).entries()) {
    await giveBuddy(playerId);
    await app.bosses.commit(encounter.id, guildDbId, playerId, { discordUserId: `u-${i}`, trainerName: `T${i}` });
  }
  const result = await app.bosses.resolve(encounter.id);
  return { encounter, result: result! };
}

const ownedGear = (playerId: number) =>
  t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));

describe('a gear entry in a boss table', () => {
  it('fires through normal resolution and persists one R Attack instance', async () => {
    withGroups([certainGear([{ slot: 'attack', rarity: 'R' }])]);
    const { result } = await fight();
    const entry = result.participants[0]!;
    expect(entry.equipment).toHaveLength(1);
    const won = entry.equipment![0]!;
    expect(won.slot).toBe('attack');
    expect(won.rarity).toBe('R');
    const [row] = await ownedGear(playerIds[0]!);
    expect(row!.id).toBe(won.equipmentId);
    expect(row!.sourceType).toBe('boss');
    expect(row!.sourceKey).toBe(app.content.bosses[0]!.id);
    expect(row!.grantKey).toBe(`boss:${entry.participation.id}:gear:0:0`);
    expect(TEST_AFFIXES.get(row!.affixKey!)!.pool).toBe('attack.R');
  });

  it('picks the base definition with a draw derived from the participation', async () => {
    withGroups([certainGear([{ rarity: 'R' }])]);
    const { encounter, result } = await fight(4);
    const eligible = eligibleRewardDefinitions({ rarity: 'R' }, await listRewardableDefinitions(t.db));
    for (const entry of result.participants) {
      const expected = pickRewardDefinition(
        eligible,
        bossDrawRng(encounter.id, entry.participation.id, 'reward:gear:0:equipment'),
      );
      expect(entry.equipment![0]!.definitionKey).toBe(expected.key);
    }
  });

  it('never grants a disabled definition', async () => {
    await app.gear.definitions.setEnabled('combat_knife', false);
    await app.gear.definitions.setEnabled('throbbing_mace', false);
    withGroups([certainGear([{ slot: 'attack', rarity: 'R' }])]);
    const { result } = await fight(4);
    for (const entry of result.participants) expect(entry.equipment![0]!.definitionKey).toBe('semi_auto_sidearm');
  });

  it('honours an explicit whitelist', async () => {
    withGroups([certainGear([{ definitionKeys: ['combat_knife', 'throbbing_mace'] }])]);
    const { result } = await fight(4);
    for (const entry of result.participants) {
      expect(['combat_knife', 'throbbing_mace']).toContain(entry.equipment![0]!.definitionKey);
    }
  });

  it('respects the group gate: a 0.01% group almost never drops gear', async () => {
    withGroups([{ ...certainGear([{ rarity: 'N' }]), chanceBasisPoints: 1 }]);
    const { result } = await fight(4);
    expect(result.participants.flatMap((p) => p.equipment ?? [])).toEqual([]);
  });

  it('pays items and gear from the same table side by side', async () => {
    withGroups([
      {
        id: 'standard-item',
        enabled: true,
        rolls: 1,
        chanceBasisPoints: 10_000,
        entries: [{ itemId: 'energy_drink', enabled: true, weight: 1, quantity: 1 }],
      },
      certainGear([{ slot: 'defense', rarity: 'N' }]),
    ]);
    const { result } = await fight();
    const entry = result.participants[0]!;
    expect(entry.rewards.map((r) => r.slug)).toEqual(['energy_drink']);
    expect(entry.equipment).toHaveLength(1);
  });
});

describe('retries and failures', () => {
  it('resolving again does not duplicate gear', async () => {
    withGroups([certainGear([{ rarity: 'R' }])]);
    const { encounter } = await fight();
    const again = await app.bosses.resolve(encounter.id);
    expect(again?.applied ?? false).toBe(false);
    expect(await ownedGear(playerIds[0]!)).toHaveLength(1);
  });

  it('a replay of the payout grant key returns the same instance', async () => {
    withGroups([certainGear([{ rarity: 'R' }])]);
    const { encounter, result } = await fight();
    const entry = result.participants[0]!;
    const replay = await t.db.transaction((tx) =>
      app.equipmentRewards.grantRandomEquipmentReward(tx, {
        playerId: playerIds[0]!,
        selector: { rarity: 'R' },
        source: { type: 'boss', key: encounter.bossId },
        grantKey: `boss:${entry.participation.id}:gear:0`,
        rng: bossDrawRng(encounter.id, entry.participation.id, 'reward:gear:0:equipment'),
      }),
    );
    expect(replay.alreadyGranted).toBe(true);
    expect(replay.equipmentId).toBe(entry.equipment![0]!.equipmentId);
    expect(await ownedGear(playerIds[0]!)).toHaveLength(1);
  });

  it('a selector nothing can satisfy refuses the payout as a whole', async () => {
    withGroups([
      {
        id: 'standard-item',
        enabled: true,
        rolls: 1,
        chanceBasisPoints: 10_000,
        entries: [{ itemId: 'energy_drink', enabled: true, weight: 1, quantity: 1 }],
      },
      certainGear([{ slot: 'health', rarity: 'SR' }]),
    ]);
    const encounter = await openEncounter();
    await giveBuddy(playerIds[0]!);
    await app.bosses.commit(encounter.id, guildDbId, playerIds[0]!, { discordUserId: 'u-0', trainerName: 'T0' });
    await expect(app.bosses.resolve(encounter.id)).rejects.toThrow(/no enabled equipment definition/);
    const [participation] = await t.db
      .select()
      .from(bossParticipations)
      .where(eq(bossParticipations.encounterId, encounter.id));
    expect(participation!.rewardStatus).toBe('pending');
    expect(await ownedGear(playerIds[0]!)).toEqual([]);
    const inventory = await t.db.select().from(playerInventory).where(and(eq(playerInventory.playerId, playerIds[0]!)));
    expect(inventory).toEqual([]);
  });
});

describe('unchanged without gear', () => {
  it('the shipped tables pay items and no equipment', async () => {
    const { result } = await fight(2);
    for (const entry of result.participants) {
      expect(entry.equipment).toEqual([]);
      expect(entry.rewards.length).toBeGreaterThan(0);
    }
    expect(await ownedGear(playerIds[0]!)).toEqual([]);
  });
});

describe('presentation', () => {
  it('My Result names the generated gear with a formatted multiplier only', async () => {
    withGroups([certainGear([{ definitionKeys: ['combat_knife'] }])]);
    const { encounter, result } = await fight();
    const entry = result.participants[0]!;
    const won = entry.equipment![0] as BossEquipmentRewardView;
    const text = buildMyResult(encounter, entry);
    const affix = TEST_AFFIXES.get(
      (await ownedGear(playerIds[0]!))[0]!.affixKey!,
    )!;
    expect(text).toContain('**Equipment**');
    expect(text).toContain(`Combat Knife ${affix.suffix}`);
    expect(text).toContain(`ATK ×${(won.rolledMultiplierBp / 10_000).toFixed(2)}`);
    expect(text).not.toContain(affix.key);
    expect(text).not.toContain(String(won.rolledMultiplierBp));
  });
});
