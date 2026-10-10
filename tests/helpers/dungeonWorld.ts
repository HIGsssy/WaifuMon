/**
 * A database-backed dungeon world for integration tests: the real content and
 * run services over a migrated test database, a player factory, and a
 * one-call "create and publish this dungeon".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { players, species as speciesTable } from '../../src/db/schema';
import { createArtworkAssetService, type ArtworkAssetService } from '../../src/modules/artworkAssets/artworkAssetService';
import { createLocalArtworkStorage } from '../../src/modules/artworkAssets/artworkStorage';
import { createSceneCompositionService, type SceneCompositionService } from '../../src/modules/artworkAssets/sceneComposition';
import type { CombatRules } from '../../src/modules/combat/combatTypes';
import type { DungeonDefinition, DungeonDefinitionInput } from '../../src/modules/dungeons/content/dungeonDefinition';
import {
  createDungeonAllowanceService,
  type DungeonAllowanceService,
} from '../../src/modules/dungeons/dungeonAllowanceService';
import {
  createDungeonContentService,
  type DungeonContentService,
  type DungeonPublishResult,
} from '../../src/modules/dungeons/dungeonContentService';
import {
  createDungeonRunService,
  type DungeonActionResult,
  type DungeonRunService,
  type DungeonRunView,
} from '../../src/modules/dungeons/dungeonRunService';
import type { DungeonInput } from '../../src/modules/dungeons/engine/types';
import { dungeonEnemyReferences } from '../../src/modules/enemies/enemyReferences';
import { createEnemyCatalogueService, type EnemyCatalogueService } from '../../src/modules/enemies/enemyService';
import { seedCombatEnemies, shippedCombatEnemies } from '../../src/modules/enemies/enemyStore';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  createProgressionCurrencyService,
  type ProgressionCurrencyService,
} from '../../src/modules/progressionCurrency/progressionCurrencyService';
import { rewardTableHash } from '../../src/modules/rewardTables/rewardTableCore';
import { loadShippedRewardTables, seedRewardTables } from '../../src/modules/rewardTables/rewardTableStore';
import { CURRENCY, FIXED_RULES, TEST_ENEMIES, testDungeonInput } from './dungeonFixtures';
import { buildEquipmentServices, grant, starterRoll, unlockEquipment, type EquipmentServices } from './equipmentFixtures';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from './fixtures';
import { createTestDb, type TestDb } from './testDb';

export const GEAR_TABLE = 'test-dungeon-gear';
export const LOOT_TABLE = 'test-dungeon-loot';
const TABLES = [
  {
    id: GEAR_TABLE,
    enabled: true,
    groups: [{ id: 'gear', enabled: true, rolls: 1, chanceBasisPoints: 10_000, entries: [], equipment: [{ slot: 'attack', rarity: 'N', weight: 1 }] }],
  },
  {
    id: LOOT_TABLE,
    enabled: true,
    waifubux: { min: 11, max: 11 },
    groups: [{ id: 'loot', enabled: true, rolls: 1, chanceBasisPoints: 10_000, entries: [{ itemId: 'sticky_joystick', weight: 1, quantity: 2, enabled: true }] }],
  },
];

/** The timezone the test world's game day is counted in. */
export const TEST_DAILY_TIMEZONE = 'UTC';

export interface DungeonWorld {
  t: TestDb;
  app: App;
  svc: EquipmentServices;
  stats: CombatStatsService;
  currencies: ProgressionCurrencyService;
  content: DungeonContentService;
  runs: DungeonRunService;
  allowance: DungeonAllowanceService;
  assets: ArtworkAssetService;
  enemies: EnemyCatalogueService;
  scenes: SceneCompositionService;
  artworkDir: string;
  /** The clock the daily allowance reads. Reassign `.now` to cross a reset. */
  clock: { now: Date };
  /** A fresh, eligible player. `buddy`, `unlocked` and `starters` default to true. */
  player(opts?: { buddy?: boolean; unlocked?: boolean; starters?: boolean }): Promise<{ playerId: number; buddyId: number | null }>;
  /** Create a dungeon and publish its draft. Defaults to the test dungeon. */
  publish(definition?: DungeonDefinitionInput | DungeonDefinition): Promise<DungeonPublishResult>;
  /** Replace a dungeon's draft and publish it as the next revision. */
  republish(definition: DungeonDefinitionInput | DungeonDefinition): Promise<DungeonPublishResult>;
  /** A second run service over the same database, as a restarted process would build. */
  restartedRuns(): DungeonRunService;
  /** One step, naming the step the given view showed. */
  act(playerId: number, view: DungeonRunView, input: DungeonInput): Promise<DungeonActionResult>;
  balance(playerId: number): Promise<number>;
  cleanup(): Promise<void>;
}

export async function createDungeonWorld(
  opts: {
    combatRules?: Partial<CombatRules> | null;
    logger?: Parameters<typeof createDungeonRunService>[0]['logger'];
    equipment?: Parameters<typeof buildEquipmentServices>[1];
  } = {},
): Promise<DungeonWorld> {
  const t = await createTestDb();
  const app = await bootstrapApp(t);
  const svc = buildEquipmentServices(t.db, opts.equipment ?? {});

  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  await seedRewardTables(
    t.db,
    TABLES.map((definition, i) => ({
      kind: 'expedition' as const,
      id: definition.id,
      definition,
      hash: rewardTableHash('expedition', definition),
      position: 10_000 + i,
    })),
  );

  const stats = createCombatStatsService({
    db: t.db,
    resolveActiveBuddy: (tx, playerId) => app.collection.resolveActiveBuddy(tx, playerId),
    getMaxLevel: () => app.content.tables.waifuProgression.maxLevel,
    getAffixes: svc.getAffixes,
  });
  const currencies = createProgressionCurrencyService(t.db);
  const artworkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dg-artwork-'));
  const assets = createArtworkAssetService({ db: t.db, storage: createLocalArtworkStorage(path.join(artworkDir, 'managed')) });
  const shippedEnemies = shippedCombatEnemies(TEST_ENEMIES);
  await seedCombatEnemies(t.db, shippedEnemies);
  const enemies = createEnemyCatalogueService({
    db: t.db,
    getShipped: () => shippedEnemies,
    assets,
    referenceSources: [dungeonEnemyReferences],
  });
  const scenes = createSceneCompositionService({ cacheDir: path.join(artworkDir, 'cache') });
  const content = createDungeonContentService({
    db: t.db,
    enemies,
    getItemSlugs: () => app.content.items.map(item => item.slug),
    assetsDir: artworkDir,
    artworkStorage: createLocalArtworkStorage(path.join(artworkDir, 'managed')),
    getRegions: () => app.content.regions.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    environment: 'test',
  });
  const clock = { now: new Date('2026-03-10T12:00:00Z') };
  const allowance = createDungeonAllowanceService({ db: t.db, timezone: TEST_DAILY_TIMEZONE, now: () => clock.now });
  const buildRuns = (): DungeonRunService =>
    createDungeonRunService({
    db: t.db,
    content,
    enemies,
    allowance,
    // `null` asks for the engine's real rules, variance included.
    ...(opts.combatRules === null ? {} : { combatRules: opts.combatRules ?? FIXED_RULES }),
    ...(opts.logger ? { logger: opts.logger } : {}),
    featureUnlocks: svc.featureUnlocks,
    combatStats: stats,
    currencies,
    currency: app.currency,
    inventory: app.inventory,
    equipmentRewards: createEquipmentRewardService({
      equipment: svc.equipment,
      getAffixes: svc.getAffixes,
      featureUnlocks: svc.featureUnlocks,
    }),
  });
  const runs = buildRuns();

  const [speciesRow] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  let seq = 0;

  const world: DungeonWorld = {
    t,
    app,
    svc,
    stats,
    currencies,
    content,
    runs,
    allowance,
    assets,
    enemies,
    scenes,
    artworkDir,
    clock,
    async player(o = {}) {
      seq += 1;
      const { playerId } = await provisionPlayer(app, `g-dg-${seq}`, `u-dg-${seq}`);
      let buddyId: number | null = null;
      if (o.buddy !== false) {
        const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId: speciesRow!.id, level: 35, baseSp: 100, nickname: 'Nebula Nurse' });
        await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
        buddyId = buddy.id;
      }
      if (o.unlocked !== false) await unlockEquipment(t.db, svc, playerId);
      if (o.starters !== false && o.unlocked !== false) {
        for (const [slot, key] of [['attack', 'rusty_pipe'], ['defense', 'scrap_plate'], ['health', 'dented_lunchbox']] as const) {
          const id = await grant(t.db, svc, playerId, key, starterRoll(key));
          await svc.equipment.equip(playerId, { slot, equipmentId: id });
        }
      }
      return { playerId, buddyId };
    },
    async publish(definition = testDungeonInput()) {
      const created = await content.create({ definition }, 'test');
      return content.publish(created.key, { expectedRevision: created.draftRevision }, 'test');
    },
    async republish(definition) {
      const current = (await content.get(definition.key))!;
      const saved = await content.saveDraft(definition.key, { definition, expectedRevision: current.draftRevision }, 'test');
      return content.publish(definition.key, { expectedRevision: saved.draftRevision }, 'test');
    },
    restartedRuns: buildRuns,
    act: (playerId, view, input) => runs.act(playerId, view.id, { ...input, expectedStep: view.step }),
    balance: (playerId) => currencies.getBalance(playerId, CURRENCY),
    cleanup: async () => {
      fs.rmSync(artworkDir, { recursive: true, force: true });
      await t.cleanup();
    },
  };
  return world;
}
