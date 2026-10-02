/**
 * Expeditions against the database-backed reward tables: deploy reads the live
 * `reward_tables` row inside its transaction and snapshots it onto the
 * mission, so an admin edit reaches future deployments only.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerEquipment,
  playerExpeditions,
  rewardTables,
  species as speciesTable,
  type SpeciesRow,
} from '../../src/db/schema';
import {
  ExpeditionDefinitionSchema,
  ExpeditionsConfigSchema,
  type RegionalExpedition,
} from '../../src/modules/content/schemas';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import type { ExpeditionResolutionPlan } from '../../src/modules/expeditions/types';
import {
  createRewardTableService,
  type RewardTableService,
} from '../../src/modules/rewardTables/rewardTableService';
import { databaseRewardTableSource } from '../../src/modules/rewardTables/rewardTableStore';
import { ExpeditionContentError } from '../../src/shared/errors';
import { seededRng } from '../../src/shared/random';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const TABLE = 'db_success';
const ADMIN = '333333333333333333';

let t: TestDb;
let app: App;
let tables: RewardTableService;
let demon: SpeciesRow;
let userSeq = 0;

function definition(key: string, durationMinutes: number): RegionalExpedition {
  return {
    ...ExpeditionDefinitionSchema.parse({
      key,
      name: 'Store Run',
      type: 'salvage_dive',
      durationMinutes,
      recommendedLevel: 10,
      baseSuccessChance: 0.5,
      rewardTable: TABLE,
    }),
    region: 'waifu-valley',
  };
}

const liveTable = (waifubux: number, groups: unknown[] = []) => ({
  id: TABLE,
  waifubux: { min: waifubux, max: waifubux },
  groups,
});

async function setLive(table: Record<string, unknown>) {
  const current = await tables.get('expedition', TABLE);
  if (!current) return tables.create('expedition', table, ADMIN);
  return tables.update('expedition', TABLE, { table, expectedRevision: current.revision }, ADMIN);
}

async function playerWithWaifu() {
  userSeq += 1;
  const { playerId } = await provisionPlayer(app, 'g-exp-store', `u-exp-store-${userSeq}`);
  const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: demon.id, level: 10 });
  return { playerId, waifuId: waifu.id };
}

const planOf = async (id: number) =>
  (await t.db.select().from(playerExpeditions).where(eq(playerExpeditions.id, id)))[0]!
    .resolutionPlan as unknown as ExpeditionResolutionPlan;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t, { equipmentRng: seededRng(4), rewardTables: databaseRewardTableSource });
  await seedEquipmentDefinitions(t.db, { mode: 'insert-missing', catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  tables = createRewardTableService({ db: t.db, getContent: () => app.content, getShipped: () => [] });
  [demon] = (await t.db.select().from(speciesTable).where(eq(speciesTable.affinity, 'dominant')).limit(1)) as [
    SpeciesRow,
  ];
  app.content.expeditions = [60, 180, 360, 1080].map((m) => definition(m === 360 ? 'store_run' : `store_run_${m}`, m));
  // The in-memory content deliberately carries a *different* table under the
  // same id: deploy must read the database row, not this.
  app.content.expeditionRewards = [
    { id: TABLE, enabled: true, waifuXp: 0, playerXp: 0, waifubux: { min: 1, max: 1 }, groups: [] },
  ];
  app.content.tables.expeditions = ExpeditionsConfigSchema.parse({ enabled: true });
});
afterAll(async () => {
  await t.cleanup();
});
beforeEach(async () => {
  await t.db.delete(rewardTables);
});

describe('deploy against the live table store', () => {
  it('snapshots the database row, not the content file', async () => {
    await setLive(liveTable(300));
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'store_run', waifuId);
    expect((await planOf(view.id)).successTable!.waifubux).toEqual({ min: 300, max: 300 });
  });

  it('pays the deployed snapshot even after the table is edited', async () => {
    await setLive(liveTable(300, [{ id: 'gear', equipment: [{ slot: 'attack', rarity: 'R', weight: 1 }] }]));
    const { playerId, waifuId } = await playerWithWaifu();
    const view = await app.expeditions.deploy(playerId, 'store_run', waifuId);
    await setLive(liveTable(5, [{ id: 'gear', equipment: [{ slot: 'defense', weight: 1 }] }]));

    await t.db
      .update(playerExpeditions)
      .set({ completesAt: sql`now() - interval '1 minute'`, successChance: 1, exceptionalChance: 0 })
      .where(eq(playerExpeditions.id, view.id));
    const claim = await app.expeditions.claim(playerId, view.id);
    expect(claim.rewards.waifubux).toBe(300);
    expect(claim.equipmentGranted.map((g) => g.slot)).toEqual(['attack']);
    expect(await t.db.select().from(playerEquipment).where(eq(playerEquipment.playerId, playerId))).toHaveLength(1);
  });

  it('refuses to deploy when the live table is disabled or missing', async () => {
    const { playerId, waifuId } = await playerWithWaifu();
    await expect(app.expeditions.deploy(playerId, 'store_run', waifuId)).rejects.toBeInstanceOf(ExpeditionContentError);
    await setLive({ ...liveTable(300), enabled: false });
    await expect(app.expeditions.deploy(playerId, 'store_run', waifuId)).rejects.toThrow(/disabled reward table/);
  });

  it('a later deploy uses the edited table', async () => {
    await setLive(liveTable(300));
    const a = await playerWithWaifu();
    const first = await app.expeditions.deploy(a.playerId, 'store_run', a.waifuId);
    await setLive(liveTable(450));
    const b = await playerWithWaifu();
    const second = await app.expeditions.deploy(b.playerId, 'store_run', b.waifuId);
    expect((await planOf(first.id)).successTable!.waifubux).toEqual({ min: 300, max: 300 });
    expect((await planOf(second.id)).successTable!.waifubux).toEqual({ min: 450, max: 450 });
  });
});
