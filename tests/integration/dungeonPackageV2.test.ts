import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { dungeonDefinitions, dungeonRevisions, dungeonRuns, dungeonLootTables, dungeonLootTableEvents, equipmentDefinitions, items } from '../../src/db/schema';
import { createDungeonLootTableService, type DungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { dungeonGameplayHash, dungeonRewardSnapshotHash, readDungeonRewardSnapshot } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { DungeonPackageV2Schema, readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import { equipmentSelectorKey } from '../../src/modules/equipment/rewardSelector';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
let tables: DungeonLootTableService;
let n = 0;
const fresh = (kind: string) => `package_v2_${kind}_${++n}`;
beforeAll(async () => { w = await createDungeonWorld(); tables = createDungeonLootTableService({ db: w.t.db }); });
afterAll(async () => { await w?.cleanup(); });
const body = (slug: string, quantity = 1) => DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'prize', grant: { type: 'item', item: slug, quantity: { min: quantity, max: quantity } } }], chances: [], pools: [],
});
async function setup() {
  const slug = fresh('item');
  await w.t.db.insert(items).values({ slug, name: 'Export prize', category: 'material', enabled: true });
  const table = await tables.create({ key: fresh('loot'), name: 'Converted hoard', origin: 'converted', description: 'A converted table', body: body(slug) }, 'author');
  const definition = singleRoomDungeon([{ id: 'hoard', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'loot', table: table.key, draws: 1 }] } }], d => { d.key = fresh('dungeon'); });
  await w.content.create({ definition }, 'author');
  await w.content.publish(definition.key, { expectedRevision: 1 }, 'publisher');
  return { slug, table, definition, key: definition.key };
}
const exportV2 = async (key: string, origin: Parameters<DungeonWorld['content']['exportPackage']>[1]) =>
  DungeonPackageV2Schema.parse(await w.content.exportPackage(key, origin, 'exporter'));
const unchangedState = async () => ({
  definitions: await w.t.db.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.dungeonKey)),
  revisions: await w.t.db.select().from(dungeonRevisions).orderBy(asc(dungeonRevisions.id)),
  runs: await w.t.db.select().from(dungeonRuns).orderBy(asc(dungeonRuns.id)),
  tables: await w.t.db.select().from(dungeonLootTables).orderBy(asc(dungeonLootTables.tableKey)),
  tableEvents: await w.t.db.select().from(dungeonLootTableEvents).orderBy(asc(dungeonLootTableEvents.id)),
});

describe('database package v2 exports', () => {
  it('drafts carry current bodies, while published revisions keep their original bodies after edits', async () => {
    const { key, slug, table } = await setup();
    const pinned = await exportV2(key, 'published');
    const player = await w.player();
    await w.runs.start(player.playerId, key);
    await tables.update(table.key, { expectedRevision: 1, body: body(slug, 9) }, 'author');
    const before = await unchangedState();
    const draft = await exportV2(key, 'draft');
    const published = await exportV2(key, 'published');
    const numbered = await exportV2(key, { revision: 1 });
    expect(draft.bundled.dungeonLootTables[0]).toMatchObject({ body: body(slug, 9), sourceRevision: 2, description: 'A converted table', origin: 'converted' });
    expect(draft.rewardSnapshotHash).toBeNull();
    expect(published.bundled).toEqual(pinned.bundled);
    expect(published.bundled.dungeonLootTables[0]).toMatchObject({ description: null, origin: null });
    expect(published.rewardSnapshot).toEqual(pinned.rewardSnapshot);
    expect(numbered.rewardSnapshotHash).toBe(pinned.rewardSnapshotHash);
    expect(readDungeonPackage(draft).ok).toBe(true);
    expect(readDungeonPackage(published).ok).toBe(true);
    expect(await unchangedState()).toEqual(before);
    const again = await exportV2(key, 'draft');
    const identity = (p: typeof again) => ({ ...p, packageId: null, exportedAt: null });
    expect(identity(again)).toEqual(identity(draft));
  });

  it('exports published bodies after archival and deletion without reading live reward catalogues', async () => {
    const { key, table, definition } = await setup();
    const pinned = await exportV2(key, 'published');
    await tables.archive(table.key, { expectedRevision: 1 }, 'author');
    expect((await exportV2(key, 'published')).rewardSnapshot).toEqual(pinned.rewardSnapshot);
    await expect(w.content.exportPackage(key, 'draft', 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID', issues: expect.arrayContaining([expect.objectContaining({ code: 'reward_table_archived' })]) });
    // Deletion's existing guard requires clearing the draft's reference first.
    await w.content.saveDraft(key, { definition: { ...definition, rooms: [{ ...definition.rooms[0]!, actions: [] }, definition.rooms[1]!] }, expectedRevision: 1 }, 'author');
    await tables.delete(table.key, { expectedRevision: 2 }, 'author');
    const before = await unchangedState();
    expect((await exportV2(key, { revision: 1 })).rewardSnapshot).toEqual(pinned.rewardSnapshot);
    expect(await unchangedState()).toEqual(before);
  });

  it('equipment and item manifests preserve publication candidates even after eligibility changes', async () => {
    const { key, slug, table, definition } = await setup();
    const selector = { slot: 'attack' as const, rarity: 'N' as const };
    await tables.update(table.key, { expectedRevision: 1, body: DungeonLootTableBodySchema.parse({ ...body(slug), chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector } }] }) }, 'author');
    await w.content.publish(key, { expectedRevision: 1 }, 'publisher');
    const snapshot = (await exportV2(key, 'published')).rewardSnapshot;
    const candidates = snapshot.equipmentPools[equipmentSelectorKey(selector)]!;
    expect(candidates.length).toBeGreaterThan(0);
    await w.t.db.update(equipmentDefinitions).set({ enabled: false }).where(eq(equipmentDefinitions.key, candidates[0]!.key));
    try {
      const pkg = await exportV2(key, 'published');
      expect(pkg.dependencies.items).toEqual([slug]);
      expect(pkg.dependencies.equipment).toEqual([{ selectorKey: equipmentSelectorKey(selector), candidateKeys: candidates.map(c => c.key).sort() }]);
      expect(pkg.rewardSnapshot.equipmentPools).toEqual(snapshot.equipmentPools);
      expect(readDungeonPackage(pkg).ok).toBe(true);
      expect((await exportV2(key, 'draft')).dependencies.equipment[0]!.candidateKeys).not.toContain(candidates[0]!.key);
      expect(pkg.dungeon).toEqual(definition);
    } finally { await w.t.db.update(equipmentDefinitions).set({ enabled: true }).where(eq(equipmentDefinitions.key, candidates[0]!.key)); }
  });

  it.each(['missing', 'invalid'] as const)('refuses %s draft tables without falling back to published contents', async mode => {
    const { key, table } = await setup();
    if (mode === 'missing') await w.t.db.delete(dungeonLootTables).where(eq(dungeonLootTables.tableKey, table.key));
    else await w.t.pool.query('UPDATE dungeon_loot_tables SET body = $1 WHERE table_key = $2', [JSON.stringify({ broken: true }), table.key]);
    const before = await unchangedState();
    await expect(w.content.exportPackage(key, 'draft', 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID', issues: expect.arrayContaining([expect.objectContaining({ code: mode === 'missing' ? 'reward_table_missing' : 'reward_table_invalid' })]) });
    expect(readDungeonPackage(await exportV2(key, 'published')).ok).toBe(true);
    expect(await unchangedState()).toEqual(before);
  });

  it('rejects capped, disabled or missing draft items', async () => {
    const { key, slug } = await setup();
    for (const patch of [{ maxOwned: 1 }, { maxOwned: null, enabled: false }]) {
      await w.t.db.update(items).set(patch).where(eq(items.slug, slug));
      await expect(w.content.exportPackage(key, 'draft', 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
    }
    await w.t.db.delete(items).where(eq(items.slug, slug));
    await expect(w.content.exportPackage(key, 'draft', 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
    expect(readDungeonPackage(await exportV2(key, 'published')).ok).toBe(true);
  });

  it('refuses absent, unsupported, corrupt and definition-incompatible revision snapshots', async () => {
    const { key } = await setup();
    const [original] = await w.t.db.select().from(dungeonRevisions).where(eq(dungeonRevisions.dungeonKey, key));
    const snapshot = readDungeonRewardSnapshot(original!.rewardSnapshot)!;
    const extra = { ...snapshot, items: { ...snapshot.items, extra: { name: 'Extra', category: 'material' } } };
    extra.hash = dungeonRewardSnapshotHash(extra);
    const cases = [
      { rewardSnapshot: null, gameplayHash: null },
      { rewardSnapshot: { ...snapshot, version: 2 }, gameplayHash: original!.gameplayHash },
      { rewardSnapshot: { ...snapshot, resolverVersion: 99 }, gameplayHash: original!.gameplayHash },
      { rewardSnapshot: { ...snapshot, hash: `sha256:${'0'.repeat(64)}` }, gameplayHash: original!.gameplayHash },
      { rewardSnapshot: snapshot, gameplayHash: `sha256:${'0'.repeat(64)}` },
      { rewardSnapshot: extra, gameplayHash: dungeonGameplayHash(original!.contentHash, extra.hash) },
    ];
    for (const [i, patch] of cases.entries()) {
      await w.t.db.insert(dungeonRevisions).values({ dungeonKey: key, number: i + 2, content: original!.content, contentHash: original!.contentHash, draftRevision: 1, ...patch });
      await expect(w.content.exportPackage(key, { revision: i + 2 }, 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID', issues: expect.arrayContaining([expect.objectContaining({ code: 'reward_snapshot_invalid' })]) });
    }
  });

  it('uses a consistent draft read when a table edit commits during export', async () => {
    const { key, table, slug } = await setup();
    // Enemy lookup is after reward snapshot resolution; pause there and edit the catalogue.
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { entered = r; });
    const original = w.enemies.definitions.bind(w.enemies);
    const spy = vi.spyOn(w.enemies, 'definitions').mockImplementationOnce(async tx => { entered(); await gate; return original(tx); });
    const exporting = exportV2(key, 'draft');
    try {
      await ready;
      await tables.update(table.key, { expectedRevision: 1, body: body(slug, 5) }, 'author');
    } finally { release(); spy.mockRestore(); }
    const pkg = await exporting;
    expect(pkg.bundled.dungeonLootTables[0]!.body).toEqual(body(slug));
    expect(pkg.bundled.dungeonLootTables[0]!.sourceRevision).toBe(1);
    expect(readDungeonPackage(pkg).ok).toBe(true);
  });
});
