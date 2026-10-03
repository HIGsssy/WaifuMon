/**
 * Dungeon runs against a real database: a generated run is stored whole, an
 * Admin edit never reaches a run already generated, a new run uses the new
 * configuration, one active run per player, and the shipped zones are seeded
 * without overwriting an edit.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonRuns, dungeonZones, rewardTables } from '../../src/db/schema';
import { validateDungeonGraph } from '../../src/modules/dungeons/dungeonGenerator';
import { createDungeonRunService, type DungeonRunService } from '../../src/modules/dungeons/dungeonRunService';
import { createDungeonZoneService, type DungeonZoneService } from '../../src/modules/dungeons/dungeonZoneService';
import {
  loadShippedDungeonZones,
  seedDungeonZones,
  type ShippedDungeonZone,
} from '../../src/modules/dungeons/dungeonZoneStore';
import { dungeonZoneHash, type DungeonZoneDefinition } from '../../src/modules/dungeons/zoneDefinition';
import type { LoadedContent } from '../../src/modules/content/schemas';
import { loadEquipmentSeedCatalogue, seedEquipmentDefinitions } from '../../src/modules/equipment/seed';
import { createProgressionCurrencyService } from '../../src/modules/progressionCurrency/progressionCurrencyService';
import { loadShippedRewardTables, seedRewardTables } from '../../src/modules/rewardTables/rewardTableStore';
import {
  DungeonGenerationError,
  DungeonRunActiveError,
  DungeonZoneInvalidError,
  DungeonZoneUnavailableError,
  PlayerNotFoundError,
} from '../../src/shared/errors';
import { CONTENT_DIR, bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const ZONE = 'scrapheap_gauntlet';
let t: TestDb;
let app: App;
let content: LoadedContent;
let shipped: ShippedDungeonZone[];
let zones: DungeonZoneService;
let runs: DungeonRunService;
let users = 0;
const newPlayer = async () => (await provisionPlayer(app, 'g-dungeon', `u-${++users}`)).playerId;
const liveZone = async (key = ZONE) => (await zones.get(key))!;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  content = app.content;
  // The shipped zone's gear tables need definitions to pay from.
  await seedEquipmentDefinitions(t.db, { catalogue: loadEquipmentSeedCatalogue(CONTENT_DIR) });
  await seedRewardTables(t.db, loadShippedRewardTables(CONTENT_DIR));
  shipped = loadShippedDungeonZones(CONTENT_DIR);
  await seedDungeonZones(t.db, shipped);
  zones = createDungeonZoneService({ db: t.db, getContent: () => content, getShipped: () => shipped });
  runs = createDungeonRunService({
    db: t.db,
    getContent: () => content,
    currencies: createProgressionCurrencyService(t.db),
  });
});
afterAll(async () => {
  await t.cleanup();
});

describe('starting a run', () => {
  it('stores the generated graph, the seed, the zone revision and the initial state', async () => {
    const playerId = await newPlayer();
    const run = await runs.startRun({ playerId, zoneKey: ZONE, seed: 4242 });
    expect(run).toMatchObject({
      playerId,
      zoneKey: ZONE,
      seed: 4242,
      status: 'active',
      zoneRevision: 1,
      currentNodeId: run.graph.startNodeId,
      currentHp: null,
      unbankedCurrency: 0,
      securedRewards: [],
      completedAt: null,
    });
    expect(validateDungeonGraph(run.snapshot.zone, run.graph)).toEqual([]);

    const [row] = await t.db.select().from(dungeonRuns).where(eq(dungeonRuns.id, run.id));
    expect(row!.graph).toEqual(run.graph);
    expect(await runs.getRun(run.id)).toEqual(run);
    expect(await runs.getActiveRun(playerId)).toEqual(run);
  });

  it('snapshots the enemies, events and currency the graph selected', async () => {
    const run = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 7 });
    const enemyKeys = [...new Set(run.graph.nodes.flatMap((n) => (n.content?.kind === 'enemy' ? [n.content.key] : [])))];
    expect(Object.keys(run.snapshot.enemies).sort()).toEqual(enemyKeys.sort());
    for (const key of enemyKeys) {
      expect(run.snapshot.enemies[key]).toEqual(content.combatEnemies!.find((e) => e.key === key));
    }
    expect(run.snapshot.currency).toMatchObject({ key: 'ascension_currency' });
    expect(run.snapshot.zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(2500);
    expect(run.snapshot.zoneContentHash).toBe(dungeonZoneHash(run.snapshot.zone));
  });

  it('draws a seed when none is given, and different runs differ', async () => {
    const a = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE });
    const b = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE });
    expect(Number.isInteger(a.seed)).toBe(true);
    expect(a.seed).not.toBe(b.seed);
  });

  it('refuses a missing zone, a disabled zone and an unknown player', async () => {
    const playerId = await newPlayer();
    await expect(runs.startRun({ playerId, zoneKey: 'nowhere' })).rejects.toBeInstanceOf(DungeonZoneUnavailableError);
    await expect(runs.startRun({ playerId: 999_999, zoneKey: ZONE })).rejects.toBeInstanceOf(PlayerNotFoundError);

    const current = await liveZone();
    const off = (await zones.setEnabled(ZONE, { enabled: false, expectedRevision: current.revision }, 'admin'))!;
    try {
      await expect(runs.startRun({ playerId, zoneKey: ZONE })).rejects.toBeInstanceOf(DungeonZoneUnavailableError);
    } finally {
      await zones.setEnabled(ZONE, { enabled: true, expectedRevision: off.revision }, 'admin');
    }
    expect(await runs.getActiveRun(playerId)).toBeNull();
  });
});

describe('one active run per player', () => {
  it('refuses a second run while one is active, and allows one after it ends', async () => {
    const playerId = await newPlayer();
    const first = await runs.startRun({ playerId, zoneKey: ZONE });
    await expect(runs.startRun({ playerId, zoneKey: ZONE })).rejects.toBeInstanceOf(DungeonRunActiveError);

    const ended = (await runs.abandonActiveRun(playerId))!;
    expect(ended).toMatchObject({ id: first.id, status: 'abandoned' });
    expect(ended.completedAt).not.toBeNull();
    expect(await runs.abandonActiveRun(playerId)).toBeNull();

    const second = await runs.startRun({ playerId, zoneKey: ZONE });
    expect(second.id).not.toBe(first.id);
  });

  it('lets exactly one of several concurrent starts through', async () => {
    const playerId = await newPlayer();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => runs.startRun({ playerId, zoneKey: ZONE })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DungeonRunActiveError);
    }
  });

  it('is enforced by the database, not only by the service', async () => {
    const playerId = await newPlayer();
    const run = await runs.startRun({ playerId, zoneKey: ZONE });
    const duplicate = {
      playerId,
      zoneKey: ZONE,
      zoneRevision: 1,
      seed: 1,
      generatorVersion: 1,
      graph: {},
      zoneSnapshot: {},
    };
    await expect(t.db.insert(dungeonRuns).values(duplicate)).rejects.toThrow();
    // A finished run does not count.
    await t.db
      .update(dungeonRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(dungeonRuns.id, run.id));
    await expect(t.db.insert(dungeonRuns).values(duplicate)).resolves.toBeDefined();
  });

  it('refuses an unknown status and a seed outside the generator range', async () => {
    const base = {
      playerId: await newPlayer(),
      zoneKey: ZONE,
      zoneRevision: 1,
      seed: 1,
      generatorVersion: 1,
      graph: {},
      zoneSnapshot: {},
    };
    await expect(
      t.db.insert(dungeonRuns).values({ ...base, status: 'paused' as never, completedAt: new Date() }),
    ).rejects.toThrow();
    await expect(t.db.insert(dungeonRuns).values({ ...base, seed: 4294967296 })).rejects.toThrow();
  });
});

describe('snapshot semantics', () => {
  it('keeps an active run exactly as generated after the zone is edited, and gives new runs the new config', async () => {
    const playerId = await newPlayer();
    const before = await runs.startRun({ playerId, zoneKey: ZONE, seed: 99 });

    const current = await liveZone();
    const edited: DungeonZoneDefinition = {
      ...current.zone,
      name: 'Scrapheap Gauntlet II',
      generation: { ...current.zone.generation, minNodes: 9, maxNodes: 9 },
      rewards: { ...current.zone.rewards, defeatCurrencyRetentionBasisPoints: 5000 },
    };
    const saved = (await zones.update(ZONE, { zone: edited, expectedRevision: current.revision }, 'admin'))!;
    expect(saved.revision).toBe(current.revision + 1);

    try {
      const after = (await runs.getRun(before.id))!;
      expect(after).toEqual(before);
      expect(after.zoneRevision).toBe(current.revision);
      expect(after.snapshot.zone.name).toBe('Scrapheap Gauntlet');
      expect(after.snapshot.zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(2500);

      const fresh = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 99 });
      expect(fresh.zoneRevision).toBe(saved.revision);
      expect(fresh.graph.nodes).toHaveLength(9);
      expect(fresh.snapshot.zone.name).toBe('Scrapheap Gauntlet II');
      expect(fresh.snapshot.zone.rewards.defeatCurrencyRetentionBasisPoints).toBe(5000);
      expect(fresh.graph).not.toEqual(before.graph);
    } finally {
      await zones.update(ZONE, { zone: current.zone, expectedRevision: saved.revision }, 'admin');
    }
  });

  it('does not rewrite an active snapshot when a referenced enemy is disabled afterwards', async () => {
    const run = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 5 });
    const bossKey = run.graph.nodes.find((n) => n.boss)!.content!.key;
    const original = content;
    content = {
      ...content,
      combatEnemies: content.combatEnemies!.map((e) => (e.key === bossKey ? { ...e, enabled: false, name: 'Gone' } : e)),
    };
    try {
      const after = (await runs.getRun(run.id))!;
      expect(after).toEqual(run);
      expect(after.snapshot.enemies[bossKey]).toMatchObject({ enabled: true, name: 'Scrapheap Colossus' });
      expect(after.graph.nodes.find((n) => n.boss)!.content).toEqual({ kind: 'enemy', key: bossKey });
      // A new run cannot be generated without its boss — and says so, with nothing stored.
      const playerId = await newPlayer();
      await expect(runs.startRun({ playerId, zoneKey: ZONE })).rejects.toBeInstanceOf(DungeonZoneInvalidError);
      expect(await runs.getActiveRun(playerId)).toBeNull();
    } finally {
      content = original;
    }
  });

  it('reproduces an equivalent graph from the stored seed and snapshot, even after content moves on', async () => {
    const run = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 31337 });
    expect(runs.reproduceGraph(run)).toEqual(run.graph);

    const current = await liveZone();
    const edited = { ...current.zone, generation: { ...current.zone.generation, minNodes: 6, maxNodes: 6 } };
    const saved = (await zones.update(ZONE, { zone: edited, expectedRevision: current.revision }, 'admin'))!;
    const original = content;
    content = { ...content, combatEnemies: content.combatEnemies!.map((e) => ({ ...e, enabled: false })) };
    try {
      const stored = (await runs.getRun(run.id))!;
      expect(runs.reproduceGraph(stored)).toEqual(run.graph);
    } finally {
      content = original;
      await zones.update(ZONE, { zone: current.zone, expectedRevision: saved.revision }, 'admin');
    }
  });

  it('snapshots the reward tables a run can pay from, and keeps them when the table changes', async () => {
    const tableId = content.expeditionRewards[0]!.id;
    const current = await liveZone();
    const edited: DungeonZoneDefinition = {
      ...current.zone,
      rewards: {
        ...current.zone.rewards,
        bands: current.zone.rewards.bands.map((b) => (b.id === 'boss' ? { ...b, rewardTable: tableId } : b)),
        completion: { ...current.zone.rewards.completion, rewardTable: tableId },
      },
    };
    const saved = (await zones.update(ZONE, { zone: edited, expectedRevision: current.revision }, 'admin'))!;
    try {
      const run = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 12 });
      expect(Object.keys(run.snapshot.rewardTables)).toContain(tableId);
      expect(run.snapshot.rewardTables[tableId]!.table.id).toBe(tableId);

      await t.db.update(rewardTables).set({ enabled: false }).where(eq(rewardTables.tableId, tableId));
      expect((await runs.getRun(run.id))!.snapshot.rewardTables[tableId]).toEqual(run.snapshot.rewardTables[tableId]);
      // A run started while the table is off is promised nothing from it.
      const later = await runs.startRun({ playerId: await newPlayer(), zoneKey: ZONE, seed: 12 });
      expect(later.snapshot.rewardTables[tableId]).toBeNull();
    } finally {
      await t.db.update(rewardTables).set({ enabled: true }).where(eq(rewardTables.tableId, tableId));
      await zones.update(ZONE, { zone: current.zone, expectedRevision: saved.revision }, 'admin');
    }
  });

  it('stores nothing when generation fails', async () => {
    const current = await liveZone();
    // Saved disabled so the editor allows it, then switched on directly — the
    // state a zone is in when its content breaks underneath it.
    const broken = {
      ...current.zone,
      key: 'jammed_zone',
      enabled: false,
      generation: {
        ...current.zone.generation,
        nodeWeights: { combat: 0, elite: 0, event: 0, reward: 0, rest: 10, miniboss: 0, exit: 0 },
        required: [],
        limits: [],
      },
    };
    await zones.create(broken, 'admin');
    await t.db.update(dungeonZones).set({ enabled: true }).where(eq(dungeonZones.zoneKey, 'jammed_zone'));
    const playerId = await newPlayer();
    await expect(runs.startRun({ playerId, zoneKey: 'jammed_zone' })).rejects.toBeInstanceOf(DungeonGenerationError);
    expect(await runs.getActiveRun(playerId)).toBeNull();
  });
});

describe('seeding shipped zones', () => {
  const hashOf = async (key: string) => (await t.db.select().from(dungeonZones).where(eq(dungeonZones.zoneKey, key)))[0]!;
  const shippedZone = () => shipped.find((z) => z.key === ZONE)!;
  const variant = (name: string): ShippedDungeonZone => {
    const definition = { ...shippedZone().definition, name };
    return { key: ZONE, definition, hash: dungeonZoneHash(definition) };
  };

  it('is idempotent, and reports an untouched zone as shipped', async () => {
    const result = await seedDungeonZones(t.db, shipped);
    expect(result).toMatchObject({ created: [], updated: [], adopted: [], diverged: [], unchanged: shipped.length });
    expect(await liveZone()).toMatchObject({ origin: 'shipped', matchesShipped: true });
  });

  it('updates an untouched row when the shipped zone changes', async () => {
    const before = await hashOf(ZONE);
    const result = await seedDungeonZones(t.db, [variant('Scrapheap Gauntlet (retuned)')]);
    expect(result.updated).toEqual([ZONE]);
    const after = await hashOf(ZONE);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.updatedBy).toBe('seed');
    expect((await liveZone()).name).toBe('Scrapheap Gauntlet (retuned)');
    // Back to the real shipped file for the tests below.
    expect((await seedDungeonZones(t.db, shipped)).updated).toEqual([ZONE]);
  });

  it('never overwrites an admin edit, reports the divergence, and adopts it once Git catches up', async () => {
    const current = await liveZone();
    const edited = { ...current.zone, description: 'Edited in the Portal.' };
    const saved = (await zones.update(ZONE, { zone: edited, expectedRevision: current.revision }, 'admin-7'))!;
    expect(saved).toMatchObject({ origin: 'edited', matchesShipped: false });

    // Git unchanged: the edit simply stays.
    const quiet = await seedDungeonZones(t.db, shipped);
    expect(quiet.diverged).toEqual([{ key: ZONE, shippedChanged: false, updatedBy: 'admin-7', revision: saved.revision }]);
    // Git changed too: still not applied, and flagged.
    const loud = await seedDungeonZones(t.db, [variant('Changed in Git')]);
    expect(loud.diverged[0]).toMatchObject({ key: ZONE, shippedChanged: true });
    expect((await liveZone()).zone.description).toBe('Edited in the Portal.');
    expect((await liveZone()).name).toBe('Scrapheap Gauntlet');

    // The edit is exported and committed: the row counts as shipped again, revision untouched.
    const committed: ShippedDungeonZone = { key: ZONE, definition: saved.zone, hash: dungeonZoneHash(saved.zone) };
    const adopted = await seedDungeonZones(t.db, [committed]);
    expect(adopted.adopted).toEqual([ZONE]);
    expect((await hashOf(ZONE)).revision).toBe(saved.revision);
    expect((await seedDungeonZones(t.db, shipped)).updated).toEqual([ZONE]);
  });

  it('leaves a zone that exists only in the database alone', async () => {
    const custom = { ...(await liveZone()).zone, key: 'portal_only', name: 'Portal Only', enabled: false };
    await zones.create(custom, 'admin');
    await seedDungeonZones(t.db, shipped);
    expect(await liveZone('portal_only')).toMatchObject({ origin: 'custom', matchesShipped: null, name: 'Portal Only' });
  });
});
