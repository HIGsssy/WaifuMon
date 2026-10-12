/** C5 package portability and transaction tests; every world is a disposable migrated PostgreSQL database. */
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonContentEvents, dungeonDefinitions, dungeonImportHistory, dungeonLootTableEvents, dungeonLootTables, dungeonRevisions, dungeonRuns, equipmentDefinitions, items } from '../../src/db/schema';
import { DungeonDefinitionSchema, dungeonRewardSites, type DungeonDefinition } from '../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import { buildDungeonPackage, DungeonPackageV3Schema, dungeonContentHash, readDungeonPackage } from '../../src/modules/dungeons/package/dungeonPackage';
import type { DungeonImportApplyInput } from '../../src/modules/dungeons/package/dungeonImportService';
import type { DungeonLootImportDecisions } from '../../src/modules/dungeons/package/dungeonLootImport';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';

let w: DungeonWorld;
let n = 0;
const fresh = (kind: string) => `c5_${kind}_${++n}`;
const coins = (amount: number) => DungeonLootTableBodySchema.parse({
  guaranteed: [], chances: [{ id: 'bonus', chanceBasisPoints: 2500, grant: { type: 'currency', currency: 'waifubux', amount: { min: amount, max: amount + 2 } } }],
  pools: [{ id: 'pool', name: 'Finds', draws: 2, entries: [{ id: 'cash', weight: 7, grant: { type: 'currency', currency: 'waifubux', amount: { min: 1, max: 4 } } }, { id: 'none', weight: 3, nothing: true }] }],
});
beforeAll(async () => { w = await createDungeonWorld(); });
afterAll(async () => { await w?.cleanup(); });
const tables = (world = w) => createDungeonLootTableService({ db: world.t.db });
function packageFixture(opts: { rewards?: boolean; item?: string; mixed?: boolean; selector?: boolean } = {}) {
  const key = fresh('dungeon');
  const tableKey = fresh('loot');
  const bundle = { guaranteed: [], chances: [], tables: [{ id: 'draw', table: tableKey, draws: 1 }] };
  const definition = singleRoomDungeon([{ id: 'story', type: 'event', source: { kind: 'pool', poolId: 'finds' } },
    ...(opts.mixed ? [{ id: 'chest', type: 'reward' as const, rewards: bundle }] : [])], d => {
    d.key = key; d.flags = [];
    d.events = [{ id: 'vault', title: 'The vault', text: 'A sealed door.', choices: [
      { id: 'key', label: 'Open it', ...(opts.item ? { items: [{ item: opts.item, quantity: 1, consume: true }] } : {}), outcome: { text: 'It opens.', ...(opts.rewards === false ? {} : { rewards: bundle }) } },
      { id: 'check', label: 'Try the lock', check: { type: 'sp', baseChanceBasisPoints: 5500 }, success: { text: 'Success', ...(opts.rewards === false ? {} : { rewards: bundle }) }, failure: { text: 'Failure', ...(opts.rewards === false ? {} : { rewards: bundle }) } },
      { id: 'skip', label: 'Carry on', outcome: { text: 'You walk on.' } },
    ] }, { id: 'unused', title: 'Unused story', text: 'Saved for later.', choices: [{ id: 'take', label: 'Take it', outcome: { rewards: { guaranteed: [], chances: [], tables: [{ id: 'absent', table: 'unused_missing_loot', draws: 1 }] } } }] }];
    d.eventPools = [{ id: 'finds', name: 'Corridor finds', entries: [{ id: 'vault_entry', weight: 17, eventId: 'vault', oncePerRun: false }, { id: 'nothing_entry', weight: 3, nothing: true, text: 'Quiet.' }] }];
  });
  const body = opts.selector ? DungeonLootTableBodySchema.parse({ ...coins(7), guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector: { definitionKeys: ['source_only_sword'] } } }] }) : coins(7);
  const rewardSnapshot = resolveDungeonRewardDependencies(definition, {
    lootTables: new Map([[tableKey, { name: 'Vault rewards', body, archivedAt: null, revision: 1 }]]),
    resolveEquipmentSelector: () => [{ key: 'source_only_sword', name: 'Source sword', enabled: true, slot: 'attack', rarity: 'R' }],
  }).snapshot ?? undefined;
  return DungeonPackageV3Schema.parse(buildDungeonPackage({ definition, rewardSnapshot,
    source: { environment: 'source', origin: 'revision', draftRevision: null, publishedRevision: 1 } }));
}
type Package = ReturnType<typeof packageFixture>;
async function review(pkg: Package, lootTables: DungeonLootImportDecisions = {}, allowMissingDependencies = false, world = w): Promise<DungeonImportApplyInput> {
  const plan = await world.content.planImport(pkg, lootTables);
  expect(plan.validPackage).toBe(true); expect(plan.planHash).not.toBeNull();
  return { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: plan.target!.expectedRevision,
    decisions: { dungeon: plan.target!.status === 'new' ? 'create' : plan.target!.status === 'identical' ? 'unchanged' : 'replace', enemies: {}, lootTables, allowMissingDependencies } };
}
async function state(world = w) {
  return {
    tables: await world.t.db.select().from(dungeonLootTables).orderBy(asc(dungeonLootTables.tableKey)),
    tableEvents: await world.t.db.select().from(dungeonLootTableEvents).orderBy(asc(dungeonLootTableEvents.id)),
    drafts: await world.t.db.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.dungeonKey)),
    receipts: await world.t.db.select().from(dungeonImportHistory).orderBy(asc(dungeonImportHistory.id)),
    audit: await world.t.db.select().from(dungeonContentEvents).orderBy(asc(dungeonContentEvents.id)),
    revisions: await world.t.db.select().from(dungeonRevisions).orderBy(asc(dungeonRevisions.id)),
    runs: await world.t.db.select().from(dungeonRuns).orderBy(asc(dungeonRuns.id)),
    items: await world.t.db.select().from(items).orderBy(asc(items.id)),
    gear: await world.t.db.select().from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.id)),
  };
}
async function playerState(world = w) {
  // Snapshot all player-owned tables, plus run history, without touching any real database.
  const names = (await world.t.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND (tablename LIKE 'player%' OR tablename IN ('players', 'wallets', 'dungeon_run_events', 'dungeon_daily_usage')) ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of names) result[tablename] = (await world.t.pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]') AS rows FROM "${tablename}" t`)).rows[0].rows;
  return result;
}
async function install(pkg: Package, body = coins(99), world = w) {
  return tables(world).create({ key: pkg.bundled.dungeonLootTables[0]!.key, name: 'Local vault', body }, 'target');
}

describe('v3 target dependencies and draft import', () => {
  it('imports event-only dungeons with null evidence, retaining event and pool identities', async () => {
    const pkg = packageFixture({ rewards: false }); const before = await state();
    const request = await review(pkg); expect(await state()).toEqual(before);
    const result = await w.content.applyImport(request, 'admin');
    expect(result).toMatchObject({ createdLootTables: [], sourceSchemaVersion: 3, rewardSnapshotHash: null, publishable: true });
    expect(await w.content.get(pkg.dungeon.key)).toMatchObject({ enabled: false, published: null, draft: pkg.dungeon });
    expect((await state()).tables).toEqual(before.tables);
    await w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'publisher');
    expect(await w.content.exportPackage(pkg.dungeon.key, 'published', 'exporter')).toMatchObject({ schemaVersion: 3, rewardSnapshot: null, rewardSnapshotHash: null });
  });
  it.each(['available', 'missing', 'disabled'] as const)('reports %s required inventory items without importing global definitions', async status => {
    const slug = fresh('required');
    if (status !== 'missing') await w.t.db.insert(items).values({ slug, name: 'Vault Key', category: 'material', enabled: status !== 'disabled' });
    const pkg = packageFixture({ item: slug }); const before = await state();
    const plan = await w.content.planImport(pkg);
    expect(plan.eventDependencies).toMatchObject({ eventCount: 2, poolCount: 1, requiredItems: [{ key: slug, status }] });
    expect(plan.publishable).toBe(status === 'available');
    if (status !== 'available') {
      expect(plan.issues).toContainEqual(expect.objectContaining({ code: `event_item_${status}`, severity: 'error' }));
      await expect(w.content.applyImport(await review(pkg), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
      expect(await state()).toEqual(before);
    }
    const result = await w.content.applyImport(await review(pkg, {}, status !== 'available'), 'admin');
    expect(result.publishable).toBe(status === 'available');
    expect(await w.content.get(pkg.dungeon.key)).toMatchObject({ enabled: false, published: null, draft: pkg.dungeon });
    expect((await state()).items).toEqual(before.items);
    if (status === 'missing') await expect(w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'author')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
  });
  it('reports equipment eligibility differences and allows only an explicitly incomplete draft when no candidates exist', async () => {
    const pkg = packageFixture({ selector: true }); const before = await state();
    const plan = await w.content.planImport(pkg);
    expect(plan.equipmentChanges).toMatchObject([{ removed: [{ key: 'source_only_sword', name: 'Source sword' }], targetCandidates: [] }]);
    await expect(w.content.applyImport(await review(pkg), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
    expect((await w.content.applyImport(await review(pkg, {}, true), 'admin')).publishable).toBe(false);
    expect((await state()).gear).toEqual(before.gear);
  });
  it('copies conflicting loot and rewrites ordinary rewards plus every event outcome branch, preserving probabilities', async () => {
    const pkg = packageFixture({ mixed: true }); const current = await install(pkg); const copy = fresh('copy');
    const result = await w.content.applyImport(await review(pkg, { [current.key]: { action: 'copy', key: copy } }), 'admin');
    const draft = (await w.content.get(pkg.dungeon.key))!.draft;
    expect(dungeonRewardSites(draft).flatMap(site => site.bundle.tables.map(t => t.table))).toEqual([copy, copy, copy, copy]);
    expect(draft.eventPools).toEqual(pkg.dungeon.eventPools);
    expect(result.contentHash).toBe(dungeonContentHash(draft));
    expect((await tables().get(copy))!.body).toEqual(pkg.bundled.dungeonLootTables[0]!.body);
    expect((await tables().get(current.key))!.body).toEqual(current.body);
  });
  it('discloses both reward bodies when explicitly using an existing different table', async () => {
    const pkg = packageFixture(); const current = await install(pkg); const choices = { [current.key]: { action: 'use_existing' as const } };
    const before = await state(); const plan = await w.content.planImport(pkg, choices);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'loot_table_rewards_differ', severity: 'warning' }));
    expect(plan.lootTables![0]).toMatchObject({ incomingBody: coins(7), currentBody: current.body });
    expect((await w.content.applyImport(await review(pkg, choices), 'admin')).reusedLootTables).toEqual([current.key]);
    expect((await state()).tables).toEqual(before.tables); expect((await state()).tableEvents).toEqual(before.tableEvents);
  });
  it('refuses malformed events and disguised legacy packages without mutations', async () => {
    const pkg = packageFixture(); const invalid = structuredClone(pkg); const entry = invalid.dungeon.eventPools![0]!.entries[0]!; if ('eventId' in entry) entry.eventId = 'missing'; invalid.contentHash = dungeonContentHash(invalid.dungeon);
    const before = await state();
    for (const raw of [invalid, { ...pkg, schemaVersion: 1 }, { ...pkg, schemaVersion: 2 }, { ...pkg, dependencies: { ...pkg.dependencies, requiredItems: ['unreported'] } }]) {
      expect((await w.content.planImport(raw)).validPackage).toBe(false);
      await expect(w.content.applyImport({ package: raw, requestId: randomUUID(), expectedPlanHash: `sha256:${'0'.repeat(64)}`, expectedRevision: null,
        decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: true } }, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    }
    expect(await state()).toEqual(before);
  });
});

describe('v3 locks, rollback and receipt integrity', () => {
  it('table edits and copy-key insertion invalidate plans', async () => {
    const pkg = packageFixture(); const current = await install(pkg); const copy = fresh('copy'); const choices = { [current.key]: { action: 'copy' as const, key: copy } };
    const request = await review(pkg, choices);
    await tables().update(current.key, { expectedRevision: 1, body: coins(101) }, 'author');
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    const next = await review(pkg, choices); await tables().create({ key: copy, name: 'Taken', body: coins(1) }, 'author');
    await expect(w.content.applyImport(next, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
  });
  it('required item availability changes invalidate reward-free plans', async () => {
    const slug = fresh('key'); await w.t.db.insert(items).values({ slug, name: 'Vault Key', category: 'material', enabled: true });
    const pkg = packageFixture({ rewards: false, item: slug }); const request = await review(pkg);
    await w.t.db.update(items).set({ enabled: false }).where(eq(items.slug, slug));
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
  });
  it('rolls back all tables, catalogue events, draft and receipt on final audit failure', async () => {
    const pkg = packageFixture(); const request = await review(pkg); const before = await state();
    await w.t.pool.query("CREATE FUNCTION c5_reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'imported' THEN RAISE EXCEPTION 'c5 audit failure'; END IF; RETURN NEW; END $$");
    await w.t.pool.query('CREATE TRIGGER c5_reject_import BEFORE INSERT ON dungeon_content_events FOR EACH ROW EXECUTE FUNCTION c5_reject_import()');
    try { await expect(w.content.applyImport(request, 'admin')).rejects.toThrow(/c5 audit failure/); expect(await state()).toEqual(before); }
    finally { await w.t.pool.query('DROP TRIGGER c5_reject_import ON dungeon_content_events'); await w.t.pool.query('DROP FUNCTION c5_reject_import()'); }
  });
  it('returns the original receipt on exact retries after local edits', async () => {
    const pkg = packageFixture(); const request = await review(pkg); const result = await w.content.applyImport(request, 'admin');
    await w.content.saveDraft(pkg.dungeon.key, { expectedRevision: 1, definition: { ...pkg.dungeon, name: 'Later draft' } }, 'author');
    const before = await state(); expect(await w.content.applyImport(request, 'admin')).toEqual({ ...result, replayed: true }); expect(await state()).toEqual(before);
    await expect(w.content.applyImport(request, 'different_admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_REQUEST_CONFLICT' });
  });
  it('concurrent imports cannot overwrite a shared missing table', async () => {
    const pkg = packageFixture(); const second = { ...pkg, packageId: randomUUID(), dungeon: { ...pkg.dungeon, key: fresh('other') } };
    second.source = { ...second.source, dungeonKey: second.dungeon.key }; second.contentHash = dungeonContentHash(second.dungeon);
    const a = await review(pkg); const b = await review(second);
    const outcomes = await Promise.allSettled([w.content.applyImport(a, 'admin'), w.content.applyImport(b, 'admin')]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'DUNGEON_IMPORT_STALE' } });
    expect((await tables().get(pkg.bundled.dungeonLootTables[0]!.key))!.body).toEqual(coins(7));
    expect((await w.content.importHistory(pkg.dungeon.key)).length + (await w.content.importHistory(second.dungeon.key)).length).toBe(1);
  });
  it('concurrent exact retries share one committed receipt irrespective of lock acquisition order', async () => {
    const pkg = packageFixture(); const request = await review(pkg);
    const results = await Promise.all([w.content.applyImport(request, 'admin'), w.content.applyImport(request, 'admin')]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.importId).toBe(results[1]!.importId);
    expect(await w.content.importHistory(pkg.dungeon.key)).toHaveLength(1);
  });
});

describe('v3 published portability', () => {
  it('refuses structurally invalid reward-free event draft exports with field-level authoring errors and no writes', async () => {
    const pkg = packageFixture({ rewards: false });
    const invalid = structuredClone(pkg.dungeon);
    const entry = invalid.eventPools![0]!.entries[0]!;
    if ('eventId' in entry) entry.eventId = 'missing_event';
    await w.content.create({ definition: invalid }, 'author');
    const before = await state();
    await expect(w.content.exportPackage(invalid.key, 'draft', 'exporter')).rejects.toMatchObject({ code: 'DUNGEON_INVALID', issues: expect.arrayContaining([expect.objectContaining({ code: 'event_missing' })]) });
    expect(await state()).toEqual(before);
  });
  it('draft exports follow current dependencies; numbered exports retain pinned events and frozen deleted loot without any writes', async () => {
    const pkg = packageFixture(); await install(pkg, coins(7)); await w.publish(pkg.dungeon);
    const pinned = DungeonPackageV3Schema.parse(await w.content.exportPackage(pkg.dungeon.key, 'published', 'author'));
    const player = await w.player(); await w.runs.start(player.playerId, pkg.dungeon.key);
    const tableKey = pkg.bundled.dungeonLootTables[0]!.key;
    await tables().update(tableKey, { expectedRevision: 1, body: coins(77) }, 'author');
    const definition = structuredClone(pkg.dungeon); definition.events![0]!.text = 'New draft story'; definition.eventPools![0]!.entries[0]!.weight = 41;
    await w.content.saveDraft(definition.key, { expectedRevision: 1, definition }, 'author');
    const before = await state(); const playersBefore = await playerState();
    const current = DungeonPackageV3Schema.parse(await w.content.exportPackage(definition.key, 'draft', 'author'));
    expect(current.dungeon).toEqual(definition); expect(current.bundled.dungeonLootTables[0]!.body).toEqual(coins(77));
    expect(current.rewardSnapshotHash).toBeNull();
    const published = DungeonPackageV3Schema.parse(await w.content.exportPackage(definition.key, 'published', 'author'));
    expect(published.dungeon).toEqual(pinned.dungeon); expect(published.rewardSnapshot).toEqual(pinned.rewardSnapshot);
    expect(await state()).toEqual(before); expect(await playerState()).toEqual(playersBefore);
    // Mutable deletion cannot affect revision exports even when the draft cannot export.
    await w.t.db.delete(dungeonLootTables).where(eq(dungeonLootTables.tableKey, tableKey));
    const afterDeletion = await state();
    const numbered = DungeonPackageV3Schema.parse(await w.content.exportPackage(definition.key, { revision: 1 }, 'author'));
    expect(numbered.dungeon).toEqual(pinned.dungeon); expect(numbered.rewardSnapshot).toEqual(pinned.rewardSnapshot);
    expect(readDungeonPackage(numbered).ok).toBe(true); expect(await state()).toEqual(afterDeletion);
    await expect(w.content.exportPackage(definition.key, 'draft', 'author')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
  });
  it('imports a real published v3 into a separate database, edits it losslessly and republishes without modifying player state or old revisions/runs', async () => {
    const other = await createDungeonWorld();
    try {
      expect((await other.t.pool.query('SELECT current_database() AS name')).rows[0].name).not.toBe((await w.t.pool.query('SELECT current_database() AS name')).rows[0].name);
      const slug = fresh('portable_key');
      const pkg = packageFixture({ item: slug });
      for (const world of [w, other]) await world.t.db.insert(items).values({ slug, name: 'Portable Key', category: 'material', enabled: true });
      await install(pkg, coins(7)); await w.publish(pkg.dungeon);
      const published = DungeonPackageV3Schema.parse(await w.content.exportPackage(pkg.dungeon.key, 'published', 'exporter'));
      await other.player(); const player = await w.player(); await w.runs.start(player.playerId, pkg.dungeon.key);
      const sourceBefore = await state(); const sourcePlayers = await playerState(); const targetPlayers = await playerState(other);
      const request = await review(published, {}, false, other);
      await other.content.applyImport(request, 'importer');
      expect(await other.content.get(pkg.dungeon.key)).toMatchObject({ enabled: false, published: null, draft: published.dungeon });
      const imported = (await other.content.get(pkg.dungeon.key))!.draft;
      const changed: DungeonDefinition = DungeonDefinitionSchema.parse({ ...imported, name: 'Reviewed import', rooms: imported.rooms.map((room, i) => i ? room : { ...room, name: 'Renamed hall' }) });
      await other.content.saveDraft(imported.key, { definition: changed, expectedRevision: 1 }, 'author');
      expect((await other.content.get(imported.key))!.draft.events).toEqual(published.dungeon.events);
      expect((await other.content.get(imported.key))!.draft.eventPools).toEqual(published.dungeon.eventPools);
      await other.content.publish(imported.key, { expectedRevision: 2 }, 'publisher');
      const reexported = DungeonPackageV3Schema.parse(await other.content.exportPackage(imported.key, 'published', 'exporter'));
      expect(reexported.dungeon.events).toEqual(published.dungeon.events); expect(reexported.dungeon.eventPools).toEqual(published.dungeon.eventPools);
      expect(reexported.rewardSnapshot!.tables).toEqual(published.rewardSnapshot!.tables);
      expect(reexported.rewardSnapshot!.items).toEqual(published.rewardSnapshot!.items);
      expect(reexported.rewardSnapshot!.equipmentPools).toEqual(published.rewardSnapshot!.equipmentPools);
      expect(readDungeonPackage(reexported).ok).toBe(true);
      expect(await state()).toEqual(sourceBefore); expect(await playerState()).toEqual(sourcePlayers); expect(await playerState(other)).toEqual(targetPlayers);
      // Replacing a published target disables/unpublishes only its mutable row.
      await other.content.setEnabled(imported.key, true, 'operator');
      const targetPlayer = await other.player();
      await other.runs.start(targetPlayer.playerId, imported.key);
      const playersDuringRun = await playerState(other);
      const revisions = (await state(other)).revisions; const runs = (await state(other)).runs;
      expect(runs.some(run => run.status === 'active')).toBe(true);
      await other.content.applyImport(await review(published, {}, false, other), 'importer');
      expect(await other.content.get(imported.key)).toMatchObject({ enabled: false, published: null });
      expect((await state(other)).revisions).toEqual(revisions); expect((await state(other)).runs).toEqual(runs);
      expect(await playerState(other)).toEqual(playersDuringRun);
    } finally { await other.cleanup(); }
  });
});
