/**
 * A playable-dungeon world for integration tests: real database, real combat
 * stats, real Equipment and reward services — and its own small enemies,
 * events, reward tables and zones, so no assertion depends on shipped tuning.
 *
 * Every player made by {@link DungeonWorld.player} has a level-35 Buddy (base
 * SP 100 → Current SP 185) in the three onboarding starters:
 * ATK 83 · DEF 65 · HP 370.
 *
 * Fights run with **no damage variance** unless a world is created with
 * `combatRules`, so the HP arithmetic the tests assert is exact. The daily
 * allowance is real, on a clock the test controls (`world.clock.now`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createArtworkAssetService, type ArtworkAssetService } from '../../src/modules/artworkAssets/artworkAssetService';
import { createLocalArtworkStorage } from '../../src/modules/artworkAssets/artworkStorage';
import type { SpritePlacement } from '../../src/modules/artworkAssets/scenePlacement';
import { createEnemyCatalogueService, type EnemyCatalogueService } from '../../src/modules/enemies/enemyService';
import { dungeonZoneEnemyReferences } from '../../src/modules/enemies/enemyReferences';
import { seedCombatEnemies, shippedCombatEnemies } from '../../src/modules/enemies/enemyStore';
import { createSceneCompositionService, type SceneCompositionService } from '../../src/modules/artworkAssets/sceneComposition';
import type { DungeonZoneDefinitionInput } from '../../src/modules/dungeons/zoneDefinition';

/** A procedural zone document: the generator's blocks are always written out. */
export type PlayZoneDoc = DungeonZoneDefinitionInput & {
  generation: NonNullable<DungeonZoneDefinitionInput['generation']>;
  pools: NonNullable<DungeonZoneDefinitionInput['pools']>;
};
import { players, species as speciesTable } from '../../src/db/schema';
import { CombatEnemyDefinitionSchema, type CombatEnemyDefinition } from '../../src/modules/combat/enemyDefinitions';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { NO_DAMAGE_VARIANCE } from '../../src/modules/combat/combatMath';
import type { CombatRules } from '../../src/modules/combat/combatTypes';
import {
  createDungeonAllowanceService,
  type DungeonAllowanceService,
} from '../../src/modules/dungeons/dungeonAllowanceService';
import { generateDungeon, type DungeonGraph } from '../../src/modules/dungeons/dungeonGenerator';
import {
  createDungeonPlayService,
  type DungeonActionResult,
  type DungeonNodeView,
  type DungeonPlayService,
  type DungeonRunView,
} from '../../src/modules/dungeons/dungeonPlayService';
import { createDungeonRunService, type DungeonRunService } from '../../src/modules/dungeons/dungeonRunService';
import { createDungeonZoneService, type DungeonZoneService } from '../../src/modules/dungeons/dungeonZoneService';
import { dungeonCatalogueFromContent } from '../../src/modules/dungeons/dungeonZoneStore';
import { DungeonEventDefinitionSchema } from '../../src/modules/dungeons/eventDefinitions';
import { createCombatStatsService, type CombatStatsService } from '../../src/modules/equipment/combatStatsService';
import { createEquipmentRewardService } from '../../src/modules/equipment/equipmentRewardService';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import {
  createProgressionCurrencyService,
  type ProgressionCurrencyService,
} from '../../src/modules/progressionCurrency/progressionCurrencyService';
import { rewardTableHash } from '../../src/modules/rewardTables/rewardTableCore';
import { loadShippedRewardTables, seedRewardTables } from '../../src/modules/rewardTables/rewardTableStore';
import { DungeonGenerationError } from '../../src/shared/errors';
import { buildEquipmentServices, grant, starterRoll, unlockEquipment, type EquipmentServices } from './equipmentFixtures';
import { CONTENT_DIR, bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from './fixtures';
import { createTestDb, type TestDb } from './testDb';

export const CURRENCY = 'ascension_currency';
/** What the starter build fights with. */
export const STARTER = { attack: 83, defense: 65, maxHp: 370 } as const;

const enemy = (over: Partial<CombatEnemyDefinition> & { key: string }): CombatEnemyDefinition =>
  CombatEnemyDefinitionSchema.parse({ name: over.key, attack: 1, defense: 0, hp: 10, enabled: true, ...over });

export const TEST_ENEMIES = [
  // The starter build wins in two hits and takes one: 36 damage.
  enemy({ key: 'grunt', name: 'Grunt', attack: 60, defense: 0, hp: 150, artworkPath: 'combat/enemies/grunt.webp' }),
  enemy({ key: 'sentinel', name: 'Sentinel', attack: 60, defense: 0, hp: 160 }),
  enemy({ key: 'warden', name: 'Warden', attack: 60, defense: 0, hp: 170 }),
  enemy({ key: 'overlord', name: 'Overlord', attack: 60, defense: 0, hp: 300 }),
  // Cannot be beaten.
  enemy({ key: 'brute', name: 'Brute', attack: 100_000, defense: 0, hp: 1_000_000 }),
  // Neither side can finish the other inside the round cap.
  enemy({ key: 'wall', name: 'Wall', attack: 1, defense: 1_000_000, hp: 1_000_000 }),
];
export const TEST_EVENTS = [
  DungeonEventDefinitionSchema.parse({ key: 'shrine', name: 'Shrine', description: 'It hums.', enabled: true, hpChangeBasisPoints: 1000, paysReward: true }),
  DungeonEventDefinitionSchema.parse({ key: 'trap', name: 'Trap', description: 'It bites.', enabled: true, hpChangeBasisPoints: -1000 }),
];

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

/**
 * The base test zone: 6–8 nodes with exactly one fork, a guaranteed rest
 * (the extraction point) and exactly one reward node, flat payouts so every
 * expected total can be read off the graph.
 *
 *   any node   2 currency          reward node  5 currency + gear + 11 WaifuBux + 2 items
 *   boss      10 currency          completion   7 currency
 */
export function playZoneDoc(key: string, patch: (zone: PlayZoneDoc) => void = () => {}): PlayZoneDoc {
  const zone: PlayZoneDoc = {
    key,
    name: `Zone ${key}`,
    description: 'For tests.',
    enabled: true,
    order: 500,
    tags: ['test'],
    // Where every test player starts (`DEFAULT_REGION`).
    availableRegions: ['waifu-valley'],
    generation: {
      minNodes: 6,
      maxNodes: 8,
      branching: { minBranches: 1, maxBranches: 1, chanceBasisPoints: 0, maxLength: 1 },
      extraction: { minDepth: 2, nodeTypes: ['rest'], minPoints: 1 },
      nodeWeights: { combat: 50, elite: 0, event: 15, reward: 10, rest: 10, miniboss: 0, exit: 0 },
      boss: { required: true },
      depthRanges: {},
      required: [{ types: ['rest'], min: 1 }, { types: ['reward'], min: 1 }],
      limits: [{ types: ['reward'], max: 1 }],
      noConsecutive: ['rest'],
      maxConsecutiveSameEnemy: null,
    },
    nodeSettings: { rest: { healBasisPoints: 3000 } },
    pools: {
      combat: [{ id: 'grunt', enemyKey: 'grunt', weight: 10 }],
      elite: [{ id: 'sentinel', enemyKey: 'sentinel', weight: 10 }],
      miniboss: [{ id: 'warden', enemyKey: 'warden', weight: 10 }],
      boss: [{ id: 'overlord', enemyKey: 'overlord', weight: 10 }],
      event: [
        { id: 'shrine', eventKey: 'shrine', weight: 10 },
        { id: 'trap', eventKey: 'trap', weight: 10 },
      ],
    },
    rewards: {
      currencyKey: CURRENCY,
      defeatCurrencyRetentionBasisPoints: 2500,
      bands: [
        { id: 'all', currency: { min: 2, max: 2 } },
        { id: 'cache', nodeTypes: ['reward'], currency: { min: 5, max: 5 }, rewardTable: LOOT_TABLE, equipmentRewardTable: GEAR_TABLE },
        { id: 'boss', nodeTypes: ['boss'], currency: { min: 10, max: 10 } },
      ],
      completion: { currency: { min: 7, max: 7 } },
      extraction: {},
    },
  };
  patch(zone);
  return zone;
}

/**
 * The base *authored* test zone — the same payouts as {@link playZoneDoc},
 * laid out by hand:
 *
 *   entrance (fight)  →  pit (trap event)  →  camp (rest 10%, extraction)
 *        →  post (elite, pays 4)  |  vault (reward, pays 5 + gear + loot)
 *        →  landing (rest, the zone's 30%)  →  throne (boss)
 *
 *   entrance 2 (band)   post 4 / vault 5   boss 10 (band)   completion 7
 */
export function authoredZoneDoc(key: string, patch: (zone: DungeonZoneDefinitionInput) => void = () => {}): DungeonZoneDefinitionInput {
  const { generation: _generation, pools: _pools, ...base } = playZoneDoc(key);
  const zone: DungeonZoneDefinitionInput = {
    ...base,
    layoutMode: 'authored',
    authored: {
      startRoomId: 'entrance',
      rooms: [
        { id: 'entrance', name: 'Entrance', type: 'combat', enemyKey: 'grunt', next: ['pit'] },
        { id: 'pit', name: 'Pit', type: 'event', eventKey: 'trap', next: ['camp'] },
        { id: 'camp', name: 'Camp', type: 'rest', healBasisPoints: 1000, extraction: true, next: ['post', 'vault'] },
        { id: 'post', name: 'Guard Post', type: 'elite', enemyKey: 'sentinel', next: ['landing'], reward: { currency: { min: 4, max: 4 } } },
        {
          id: 'vault',
          name: 'Vault',
          type: 'reward',
          next: ['landing'],
          reward: { rewardTable: LOOT_TABLE, equipmentRewardTable: GEAR_TABLE, currency: { min: 5, max: 5 } },
        },
        { id: 'landing', name: 'Landing', type: 'rest', next: ['throne'] },
        { id: 'throne', name: 'Throne', type: 'boss', enemyKey: 'overlord' },
      ],
    },
  };
  patch(zone);
  return zone;
}

export interface DungeonWorld {
  t: TestDb;
  app: App;
  svc: EquipmentServices;
  stats: CombatStatsService;
  currencies: ProgressionCurrencyService;
  zones: DungeonZoneService;
  runs: DungeonRunService;
  play: DungeonPlayService;
  allowance: DungeonAllowanceService;
  /** Managed artwork, stored in a temp directory removed by `cleanup`. */
  assets: ArtworkAssetService;
  /** The Enemy Catalogue, seeded with {@link TEST_ENEMIES}; zones and runs read enemies from it. */
  enemies: EnemyCatalogueService;
  /** Set an enemy's managed artwork and placement, leaving everything else as it is. */
  setEnemyArtwork(
    key: string,
    art: { artworkAssetId?: string | null; spriteAssetId?: string | null; spritePlacement?: SpritePlacement | null },
  ): Promise<void>;
  /** Switch an enemy on or off in the catalogue. */
  setEnemyEnabled(key: string, enabled: boolean): Promise<void>;
  scenes: SceneCompositionService;
  /** Where the managed artwork and the scene cache live for this world. */
  artworkDir: string;
  /** The clock the daily allowance reads. Reassign `.now` to cross a reset. */
  clock: { now: Date };
  /** The content the services read. Reassign `.current` to "reload" it. */
  content: { current: LoadedContent };
  /** A fresh, eligible player. `buddy`, `unlocked` and `starters` default to true. */
  player(opts?: { buddy?: boolean; unlocked?: boolean; starters?: boolean }): Promise<{ playerId: number; buddyId: number | null }>;
  /** Create a zone from {@link playZoneDoc}. */
  zone(key: string, patch?: (zone: PlayZoneDoc) => void): Promise<void>;
  /** The first seed from 1 whose graph for `zoneKey` satisfies `accept`. */
  seedFor(zoneKey: string, accept: (graph: DungeonGraph) => boolean): Promise<number>;
  balance(playerId: number): Promise<number>;
  cleanup(): Promise<void>;
}

/** The timezone the test world's game day is counted in. */
export const TEST_DAILY_TIMEZONE = 'UTC';

export async function createDungeonWorld(
  opts: { combatRules?: Partial<CombatRules> | null; logger?: Parameters<typeof createDungeonPlayService>[0]['logger'] } = {},
): Promise<DungeonWorld> {
  const t = await createTestDb();
  const app = await bootstrapApp(t);
  const svc = buildEquipmentServices(t.db);
  const content = { current: { ...app.content, combatEnemies: TEST_ENEMIES, dungeonEvents: TEST_EVENTS } as LoadedContent };

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
    referenceSources: [dungeonZoneEnemyReferences],
  });
  const scenes = createSceneCompositionService({ cacheDir: path.join(artworkDir, 'cache') });
  const zones = createDungeonZoneService({ db: t.db, getContent: () => content.current, getShipped: () => [], assets, enemies });
  const runs = createDungeonRunService({ db: t.db, getContent: () => content.current, currencies, enemies });
  const clock = { now: new Date('2026-03-10T12:00:00Z') };
  const allowance = createDungeonAllowanceService({ db: t.db, timezone: TEST_DAILY_TIMEZONE, now: () => clock.now });
  const play = createDungeonPlayService({
    db: t.db,
    runs,
    allowance,
    // `null` asks for the engine's real rules, variance included.
    ...(opts.combatRules === null ? {} : { combatRules: opts.combatRules ?? { damageVariance: NO_DAMAGE_VARIANCE } }),
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

  const [speciesRow] = await t.db.select().from(speciesTable).where(eq(speciesTable.enabled, true)).limit(1);
  let seq = 0;

  return {
    t,
    app,
    svc,
    stats,
    currencies,
    zones,
    runs,
    play,
    allowance,
    assets,
    enemies,
    async setEnemyArtwork(key, art) {
      const current = (await enemies.get(key))!;
      await enemies.update(
        key,
        {
          enemy: {
            name: current.name,
            description: current.description,
            enabled: current.enabled,
            attack: current.attack,
            defense: current.defense,
            hp: current.hp,
            tags: current.tags,
            artworkAssetId: art.artworkAssetId ?? null,
            spriteAssetId: art.spriteAssetId ?? null,
            spritePlacement: art.spritePlacement ?? null,
          },
          expectedRevision: current.revision,
        },
        'admin',
      );
    },
    async setEnemyEnabled(key, enabled) {
      const current = (await enemies.get(key))!;
      if (current.enabled !== enabled) await enemies.setEnabled(key, { enabled, expectedRevision: current.revision }, 'admin');
    },
    scenes,
    artworkDir,
    clock,
    content,
    async player(opts = {}) {
      seq += 1;
      const { playerId } = await provisionPlayer(app, `g-dg-${seq}`, `u-dg-${seq}`);
      let buddyId: number | null = null;
      if (opts.buddy !== false) {
        const buddy = await insertOwnedWaifu(t.db, { playerId, speciesId: speciesRow!.id, level: 35, baseSp: 100, nickname: 'Nebula Nurse' });
        await t.db.update(players).set({ buddyWaifuId: buddy.id }).where(eq(players.id, playerId));
        buddyId = buddy.id;
      }
      if (opts.unlocked !== false) await unlockEquipment(t.db, svc, playerId);
      if (opts.starters !== false && opts.unlocked !== false) {
        for (const [slot, key] of [['attack', 'rusty_pipe'], ['defense', 'scrap_plate'], ['health', 'dented_lunchbox']] as const) {
          const id = await grant(t.db, svc, playerId, key, starterRoll(key));
          await svc.equipment.equip(playerId, { slot, equipmentId: id });
        }
      }
      return { playerId, buddyId };
    },
    async zone(key, patch) {
      await zones.create(playZoneDoc(key, patch), 'test');
    },
    async seedFor(zoneKey, accept) {
      const { zone } = (await zones.get(zoneKey))!;
      const catalogue = dungeonCatalogueFromContent(content.current);
      for (let seed = 1; seed < 5000; seed++) {
        try {
          if (accept(generateDungeon(zone, catalogue, seed))) return seed;
        } catch (err) {
          if (!(err instanceof DungeonGenerationError)) throw err;
        }
      }
      throw new Error(`no seed under 5000 gives ${zoneKey} the graph this test needs`);
    },
    balance: (playerId) => currencies.getBalance(playerId, CURRENCY),
    cleanup: async () => {
      fs.rmSync(artworkDir, { recursive: true, force: true });
      await t.cleanup();
    },
  };
}

export interface WalkOptions {
  /** Stop on a completed node, before choosing where to go next. */
  stopAt?: (view: DungeonRunView) => boolean;
  /** Which way to go at each step; the first node by default. */
  pick?: (next: DungeonNodeView[], view: DungeonRunView) => DungeonNodeView;
}

/**
 * Play a run forward: resolve the node the player is on, then enter the next,
 * until the run ends or `stopAt` says to stop. Returns the last result.
 */
export async function walk(
  play: DungeonPlayService,
  playerId: number,
  from: DungeonRunView,
  opts: WalkOptions = {},
): Promise<DungeonRunView> {
  let view = from;
  for (let guard = 0; guard < 200; guard++) {
    if (view.status !== 'active') return view;
    let result: DungeonActionResult;
    if (view.nodeStatus === 'entered') {
      result = await play.resolveNode(playerId, view.id, view.node.id);
    } else {
      if (opts.stopAt?.(view)) return view;
      const target = (opts.pick ?? ((next) => next[0]!))(view.next, view);
      result = await play.enterNode(playerId, view.id, target.id);
    }
    if (result.status !== 'applied') throw new Error(`walk: ${result.status} (${result.refusal}) at ${view.node.id}`);
    view = result.run;
  }
  throw new Error('walk: the run did not end');
}

/** Stop once the player is standing on a completed node of `type`. */
export const atCompleted = (type: string) => (view: DungeonRunView) =>
  view.node.type === type && view.nodeStatus === 'completed';
