/**
 * Equipment as an expedition reward.
 *
 * A reward group's `equipment` entry competes in the group's normal gate and
 * weighted pick. The three steps line up with the expedition's own lifecycle:
 *
 *   - **deploy** resolves each gear entry's eligible definitions and
 *     snapshots them on the plan (a bad selector refuses the mission here);
 *   - **resolve** picks the base definition from that snapshot with a derived
 *     draw — deterministic, so a retried resolution agrees with itself;
 *   - **claim** grants the instance through the shared reward path, keyed on
 *     the row and the draw, so it is paid exactly once.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  items,
  playerEquipment,
  playerExpeditions,
  players,
  species as speciesTable,
  type SpeciesRow,
} from '../../src/db/schema';
import { rewardLines } from '../../src/discord/commands/waifumonExpeditions';
import {
  ExpeditionDefinitionSchema,
  ExpeditionRewardTableSchema,
  ExpeditionsConfigSchema,
  type ExpeditionRewardTable,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';
import { affixPoolOf } from '../../src/modules/equipment/affixCatalogue';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import type { ExpeditionResolutionPlan } from '../../src/modules/expeditions/types';
import type { ExpeditionRewardPayload } from '../../src/modules/expeditions/expeditionRewards';
import { ExpeditionAlreadyClaimedError, ExpeditionContentError } from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { TEST_AFFIXES, unlockEquipment } from '../helpers/equipmentFixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let demon: SpeciesRow;
let userSeq = 0;

function definition(key: string, durationMinutes: number): RegionalExpedition {
  return {
    ...ExpeditionDefinitionSchema.parse({
      key,
      name: 'Gear Run',
      type: 'salvage_dive',
      durationMinutes,
      recommendedLevel: 10,
      baseSuccessChance: 0.5,
      rewardTable: 'gear_success',
      exceptionalRewardTable: null,
      failureRewardTable: null,
    }),
    region: 'waifu-valley',
  };
}

/** Install a success table with these groups beside a standard WaifuBux + salvage payout. */
function installSuccessTable(groups: unknown[]): void {
  const table: ExpeditionRewardTable = ExpeditionRewardTableSchema.parse({
    id: 'gear_success',
    waifubux: { min: 200, max: 200 },
    groups: [
      { id: 'salvage', chanceBasisPoints: 10_000, entries: [{ itemId: 'exp_gear_scrap', weight: 1, quantity: 2 }] },
      ...groups,
    ],
  });
  app.content.expeditions = [60, 180, 360, 1080].map((m) => definition(m === 360 ? 'gear_run' : `gear_run_${m}`, m));
  app.content.expeditionRewards = [table];
  app.content.tables.expeditions = ExpeditionsConfigSchema.parse({ enabled: true });
}

const gearGroup = (equipment: Record<string, unknown>[], chanceBasisPoints = 10_000) => ({
  id: 'gear',
  chanceBasisPoints,
  equipment: equipment.map((e) => ({ weight: 1, ...e })),
});

/** A player and a copy to deploy. Gear needs the Equipment feature, so they have it unless told otherwise. */
async function playerWithWaifu({ unlocked = true } = {}) {
  userSeq += 1;
  const { playerId } = await provisionPlayer(app, 'g-exp-gear', `u-exp-gear-${userSeq}`);
  if (unlocked) await unlockEquipment(t.db, app.gear, playerId);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: demon.id, level: 10 });
  return { playerId, waifuId: waifu.id };
}

/** Deploy, make it due with a successful outcome, and return its id. */
async function finishedMission(playerId: number, waifuId: number): Promise<number> {
  const view = await app.expeditions.deploy(playerId, 'gear_run', waifuId);
  await t.db
    .update(playerExpeditions)
    .set({ completesAt: sql`now() - interval '1 minute'`, successChance: 1, exceptionalChance: 0 })
    .where(eq(playerExpeditions.id, view.id));
  return view.id;
}

const rowOf = async (id: number) => (await t.db.select().from(playerExpeditions).where(eq(playerExpeditions.id, id)))[0]!;
const gearOf = (playerId: number) => t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId));

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { equipmentRng: seededRng(11) });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await t.db
    .insert(items)
    .values({ slug: 'exp_gear_scrap', name: 'Gear Scrap', category: 'salvage', sellValue: 5 })
    .onConflictDoNothing();
  [demon] = await t.db.select().from(speciesTable).where(eq(speciesTable.affinity, 'dominant')).limit(1) as [SpeciesRow];
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  for (const key of ['combat_knife', 'kevlar_carrier', 'railcarbine']) await app.gear.definitions.setEnabled(key, true);
});

describe('a gear entry in a mission table', () => {
  it('snapshots the eligible pool at deploy, picks at resolve, grants at claim', async () => {
    installSuccessTable([gearGroup([{ slot: 'attack', rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);

    const plan = (await rowOf(id)).resolutionPlan as unknown as ExpeditionResolutionPlan;
    const pool = Object.values(plan.equipmentPools!)[0]!.map((d) => d.key).sort();
    expect(pool).toEqual(['combat_knife', 'semi_auto_sidearm', 'throbbing_mace']);

    // Resolution (lazy, on read) fixes the base definition but grants nothing yet.
    await app.expeditions.getActive(playerId);
    const resolved = await rowOf(id);
    const payload = resolved.rewards as unknown as ExpeditionRewardPayload;
    expect(payload.equipment).toHaveLength(1);
    expect(pool).toContain(payload.equipment![0]!.definitionKey);
    expect((resolved.resolutionPlan as unknown as ExpeditionResolutionPlan).equipmentPools).toBeUndefined();
    expect(await gearOf(playerId)).toEqual([]);

    const result = await app.expeditions.claim(playerId, id);
    expect(result.equipmentGranted).toHaveLength(1);
    const granted = result.equipmentGranted[0]!;
    expect(granted.definitionKey).toBe(payload.equipment![0]!.definitionKey);
    expect(granted.drawKey).toBe('success:gear:0');
    const [row] = await gearOf(playerId);
    expect(row!.id).toBe(granted.equipmentId);
    expect(row!.sourceType).toBe('expedition');
    expect(row!.sourceKey).toBe('gear_run');
    expect(row!.grantKey).toBe(`expedition:${id}:success:gear:0:0`);
    const definition = (await app.gear.definitions.getByKey(granted.definitionKey))!;
    expect(TEST_AFFIXES.get(row!.affixKey!)!.pool).toBe(affixPoolOf(definition));
  });

  it.each(['N', 'R', 'SR'] as const)('a %s selector pays a %s definition', async (rarity) => {
    installSuccessTable([gearGroup([{ rarity }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    expect(result.equipmentGranted.map((g) => g.rarity)).toEqual([rarity]);
  });

  it('honours an explicit whitelist', async () => {
    installSuccessTable([gearGroup([{ definitionKeys: ['kevlar_carrier', 'phase_cloak'] }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    expect(['kevlar_carrier', 'phase_cloak']).toContain(result.equipmentGranted[0]!.definitionKey);
  });

  it('follows the group gate: a 0% group never pays, and says so', async () => {
    installSuccessTable([gearGroup([{ rarity: 'N' }], 0)]);
    const { playerId, waifuId } = await playerWithWaifu();
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    expect(result.equipmentGranted).toEqual([]);
    expect(result.rewards.warnings.map((w) => w.groupId)).toContain('gear');
  });

  it('pays a definition disabled after deploy — the mission was promised it', async () => {
    installSuccessTable([gearGroup([{ definitionKeys: ['railcarbine'] }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);
    await app.gear.definitions.setEnabled('railcarbine', false);
    const result = await app.expeditions.claim(playerId, id);
    expect(result.equipmentGranted[0]!.definitionKey).toBe('railcarbine');
  });
});

describe('claims and retries', () => {
  it('a second claim pays nothing, and the grant key replays the same instance', async () => {
    installSuccessTable([gearGroup([{ rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);
    const first = await app.expeditions.claim(playerId, id);
    await expect(app.expeditions.claim(playerId, id)).rejects.toBeInstanceOf(ExpeditionAlreadyClaimedError);
    expect(await gearOf(playerId)).toHaveLength(1);

    const granted = first.equipmentGranted[0]!;
    const replay = await t.db.transaction((tx) =>
      app.equipmentRewards.grantChosenEquipmentReward(tx, {
        playerId,
        definitionKey: granted.definitionKey,
        allowDisabled: true,
        source: { type: 'expedition', key: 'gear_run' },
        grantKey: `expedition:${id}:${granted.drawKey}`,
      }),
    );
    expect(replay).toMatchObject({
      alreadyGranted: true,
      equipmentId: granted.equipmentId,
      affixKey: granted.affixKey,
      rolledMultiplierBp: granted.rolledMultiplierBp,
    });
    expect(await gearOf(playerId)).toHaveLength(1);
  });

  it('resolution is deterministic: the same row always picks the same definition', async () => {
    installSuccessTable([gearGroup([{ rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);
    const before = await rowOf(id);
    await app.expeditions.getActive(playerId);
    const first = ((await rowOf(id)).rewards as unknown as ExpeditionRewardPayload).equipment;
    // Put the row back exactly as it was and resolve again.
    await t.db
      .update(playerExpeditions)
      .set({ status: 'active', resolvedAt: null, outcome: null, rewards: null, resolutionPlan: before.resolutionPlan })
      .where(eq(playerExpeditions.id, id));
    await app.expeditions.getActive(playerId);
    const second = ((await rowOf(id)).rewards as unknown as ExpeditionRewardPayload).equipment;
    expect(second).toEqual(first);
  });
});

describe('bad content fails at deploy', () => {
  it.each([
    ['nothing eligible', { slot: 'health', rarity: 'SR' }],
    ['an unknown definition', { definitionKeys: ['imaginary_blade'] }],
    ['a disabled definition', { definitionKeys: ['combat_knife'] }],
    ['a definition of the wrong slot', { slot: 'defense', definitionKeys: ['combat_knife'] }],
  ])('refuses %s, writing nothing', async (_label, selector) => {
    await app.gear.definitions.setEnabled('combat_knife', _label !== 'a disabled definition');
    // Every slot/rarity now ships content, so empty the SR Health pool deliberately.
    await app.gear.definitions.setEnabled('glitch_earring', _label !== 'nothing eligible');
    installSuccessTable([gearGroup([selector])]);
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(app.expeditions.deploy(playerId, 'gear_run', waifuId)).rejects.toBeInstanceOf(ExpeditionContentError);
    const rows = await t.db.select().from(playerExpeditions).where(eq(playerExpeditions.playerId, playerId));
    expect(rows).toEqual([]);
  });
});

describe('everything else is unchanged', () => {
  it('currency and items pay alongside gear', async () => {
    installSuccessTable([gearGroup([{ rarity: 'N' }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    expect(result.rewards.waifubux).toBe(200);
    expect(result.itemsGranted).toEqual([{ slug: 'exp_gear_scrap', name: 'Gear Scrap', quantity: 2 }]);
    expect(result.equipmentGranted).toHaveLength(1);
  });

  it('a gear-free table persists exactly the payload shape it always did', async () => {
    installSuccessTable([]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);
    const plan = (await rowOf(id)).resolutionPlan as Record<string, unknown>;
    expect(plan).not.toHaveProperty('equipmentPools');
    const result = await app.expeditions.claim(playerId, id);
    expect(result.rewards).not.toHaveProperty('equipment');
    expect(result.rewards.sources[0]).not.toHaveProperty('equipment');
    expect(result.equipmentGranted).toEqual([]);
  });
});

describe('Equipment eligibility is decided at deploy', () => {
  it('a locked deploy (even past Level 35) snapshots no gear; ordinary rewards are unchanged', async () => {
    installSuccessTable([gearGroup([{ rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu({ unlocked: false });
    await t.db.update(players).set({ level: 60 }).where(eq(players.id, playerId));
    const id = await finishedMission(playerId, waifuId);

    const plan = (await rowOf(id)).resolutionPlan as unknown as ExpeditionResolutionPlan;
    expect(plan.equipmentWithheld).toBe(true);
    expect(plan).not.toHaveProperty('equipmentPools');
    expect(plan.successTable!.groups.map((g) => g.id)).toEqual(['salvage']);

    const result = await app.expeditions.claim(playerId, id);
    expect(result.rewards.waifubux).toBe(200);
    expect(result.itemsGranted).toEqual([{ slug: 'exp_gear_scrap', name: 'Gear Scrap', quantity: 2 }]);
    expect(result.equipmentGranted).toEqual([]);
    expect(result.rewards.sources.flatMap((s) => s.equipment ?? [])).toEqual([]);
    expect(await gearOf(playerId)).toEqual([]);
  });

  it('a mixed group pays its items to a locked player instead of drawing gear', async () => {
    installSuccessTable([
      {
        id: 'mixed',
        chanceBasisPoints: 10_000,
        entries: [{ itemId: 'exp_gear_scrap', weight: 1, quantity: 1 }],
        equipment: [{ weight: 50, rarity: 'R' }],
      },
    ]);
    const { playerId, waifuId } = await playerWithWaifu({ unlocked: false });
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    expect(result.itemsGranted).toEqual([{ slug: 'exp_gear_scrap', name: 'Gear Scrap', quantity: 3 }]);
    expect(result.equipmentGranted).toEqual([]);
  });

  it('unlocking after a locked deploy does not add gear at claim, and the claim stays single', async () => {
    installSuccessTable([gearGroup([{ rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu({ unlocked: false });
    const id = await finishedMission(playerId, waifuId);
    await unlockEquipment(t.db, app.gear, playerId);
    const result = await app.expeditions.claim(playerId, id);
    expect(result.equipmentGranted).toEqual([]);
    await expect(app.expeditions.claim(playerId, id)).rejects.toBeInstanceOf(ExpeditionAlreadyClaimedError);
    expect(await gearOf(playerId)).toEqual([]);
  });

  it('an unlocked deploy keeps its promised gear even if the unlock is revoked before the claim', async () => {
    installSuccessTable([gearGroup([{ rarity: 'R' }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const id = await finishedMission(playerId, waifuId);
    const plan = (await rowOf(id)).resolutionPlan as unknown as ExpeditionResolutionPlan;
    expect(plan.equipmentWithheld).toBeUndefined();
    expect(Object.keys(plan.equipmentPools!)).toHaveLength(1);

    await t.db.transaction((tx) =>
      app.gear.featureUnlocks.revoke(tx, { playerId, featureKey: 'equipment', actorDiscordId: 'a', reason: 'staging reset' }),
    );
    const result = await app.expeditions.claim(playerId, id);
    expect(result.equipmentGranted).toHaveLength(1);
    await expect(app.expeditions.claim(playerId, id)).rejects.toBeInstanceOf(ExpeditionAlreadyClaimedError);
    expect(await gearOf(playerId)).toHaveLength(1);
  });
});

describe('presentation', () => {
  it('result lines show the generated name and formatted multiplier only', async () => {
    installSuccessTable([gearGroup([{ definitionKeys: ['combat_knife'] }])]);
    const { playerId, waifuId } = await playerWithWaifu();
    const result = await app.expeditions.claim(playerId, await finishedMission(playerId, waifuId));
    const granted = result.equipmentGranted[0]!;
    const lines = rewardLines(
      { ...result.rewards.sources[0]!, equipment: result.rewards.sources[0]!.equipment },
      new Map(result.itemsGranted.map((i) => [i.slug, i.name])),
      undefined,
      new Map(result.equipmentGranted.map((g) => [g.drawKey, g])),
    ).join('\n');
    const affix = TEST_AFFIXES.get(granted.affixKey!)!;
    expect(lines).toContain(`Combat Knife ${affix.suffix}`);
    expect(lines).toContain(`ATK ×${(granted.rolledMultiplierBp / 10_000).toFixed(2)}`);
    expect(lines).not.toContain(affix.key);
    expect(lines).not.toContain(String(granted.rolledMultiplierBp));
  });
});
