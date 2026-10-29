import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dungeonLootTables, dungeonLootTableEvents, dungeonDefinitions, dungeonImportHistory, dungeonContentEvents, dungeonRevisions, dungeonRuns, equipmentDefinitions, items } from '../../src/db/schema';
import { resolveDungeonRewardDependencies } from '../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { DungeonLootTableBodySchema } from '../../src/modules/dungeons/content/dungeonRewards';
import { buildDungeonPackage, DungeonPackageV2Schema, dungeonContentHash } from '../../src/modules/dungeons/package/dungeonPackage';
import { createDungeonLootTableService } from '../../src/modules/dungeons/dungeonLootTableService';
import type { DungeonImportApplyInput } from '../../src/modules/dungeons/package/dungeonImportService';
import type { DungeonLootImportDecisions } from '../../src/modules/dungeons/package/dungeonLootImport';
import type { DungeonValidationContext } from '../../src/modules/dungeons/validation/dungeonValidation';
import { singleRoomDungeon } from '../helpers/dungeonFixtures';
import { createDungeonWorld, type DungeonWorld } from '../helpers/dungeonWorld';
let w: DungeonWorld;
let n = 0;
const fresh = (prefix: string) => `import_v2_${prefix}_${++n}`;
beforeAll(async () => { w = await createDungeonWorld(); });
afterAll(async () => { await w?.cleanup(); });
function currencyPackage(override?: unknown, sourceContext: DungeonValidationContext = {}) {
  const tableKey = fresh('loot');
  const body = DungeonLootTableBodySchema.parse(override ?? { guaranteed: [{ id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: 7, max: 9 } } }], chances: [], pools: [] });
  const definition = singleRoomDungeon([{ id: 'hoard', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [{ id: 'draw', table: tableKey, draws: 1 }] } }], d => { d.key = fresh('dungeon'); d.flags = []; });
  const rewardSnapshot = resolveDungeonRewardDependencies(definition, { ...sourceContext, lootTables: new Map([[tableKey, { name: 'Coin hoard', archivedAt: null, body }]]) }).snapshot!;
  return DungeonPackageV2Schema.parse(buildDungeonPackage({ definition, rewardSnapshot, source: { environment: 'staging', origin: 'revision', draftRevision: null, publishedRevision: 1 } }));
}
describe('v2 import version dispatch', () => {
  it('currency-only v2 cannot succeed through a path that ignores its bundled tables', async () => {
    const pkg = currencyPackage();
    const plan = await w.content.planImport(pkg);
    expect(plan.lootTables).toMatchObject([{ status: 'missing', decision: { action: 'create' } }]);
    expect(plan.planHash).not.toBeNull();
    const input = { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: null, decisions: { dungeon: 'create' as const, enemies: {}, allowMissingDependencies: false } };
    const result = await w.content.applyImport(input, 'admin');
    expect(result.result).toBe('created');
    const rows = await w.t.db.select().from(dungeonLootTables).where(eq(dungeonLootTables.tableKey, pkg.bundled.dungeonLootTables[0]!.key));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toEqual(pkg.bundled.dungeonLootTables[0]!.body);
  });
});

const lootService = () => createDungeonLootTableService({ db: w.t.db });
const coinBody = (amount: number) => DungeonLootTableBodySchema.parse({ guaranteed: [{ id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: amount, max: amount } } }], chances: [], pools: [] });
async function installTable(pkg: ReturnType<typeof currencyPackage>, body = pkg.bundled.dungeonLootTables[0]!.body) {
  const table = pkg.bundled.dungeonLootTables[0]!;
  return lootService().create({ key: table.key, name: 'Destination coins', body }, 'target_author');
}
async function review(pkg: ReturnType<typeof currencyPackage>, lootTables: DungeonLootImportDecisions = {}, allowMissingDependencies = false): Promise<DungeonImportApplyInput> {
  const plan = await w.content.planImport(pkg, lootTables);
  expect(plan.validPackage).toBe(true);
  expect(plan.planHash).not.toBeNull();
  return { package: pkg, requestId: randomUUID(), expectedPlanHash: plan.planHash!, expectedRevision: plan.target!.expectedRevision,
    decisions: { dungeon: plan.target!.status === 'new' ? 'create' : plan.target!.status === 'identical' ? 'unchanged' : 'replace', enemies: {}, lootTables, allowMissingDependencies } };
}
async function state() {
  return { tables: await w.t.db.select().from(dungeonLootTables).orderBy(asc(dungeonLootTables.tableKey)),
    tableEvents: await w.t.db.select().from(dungeonLootTableEvents).orderBy(asc(dungeonLootTableEvents.id)),
    drafts: await w.t.db.select().from(dungeonDefinitions).orderBy(asc(dungeonDefinitions.dungeonKey)),
    receipts: await w.t.db.select().from(dungeonImportHistory).orderBy(asc(dungeonImportHistory.id)),
    audit: await w.t.db.select().from(dungeonContentEvents).orderBy(asc(dungeonContentEvents.id)),
    revisions: await w.t.db.select().from(dungeonRevisions).orderBy(asc(dungeonRevisions.id)),
    runs: await w.t.db.select().from(dungeonRuns).orderBy(asc(dungeonRuns.id)) };
}
async function waitForLock(pattern: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = await w.t.pool.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1", [pattern]);
    if (result.rows.length) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}
describe('v2 loot decisions and draft provenance', () => {
  it('plans read-only, creates an imported table, event and disabled draft from revision evidence', async () => {
    const pkg = currencyPackage();
    const before = await state();
    const request = await review(pkg);
    expect(await state()).toEqual(before);
    const result = await w.content.applyImport(request, 'admin');
    const key = pkg.bundled.dungeonLootTables[0]!.key;
    expect(result).toMatchObject({ createdLootTables: [key], reusedLootTables: [], contentHash: pkg.contentHash, sourceSchemaVersion: 2, rewardSnapshotHash: pkg.rewardSnapshot.hash });
    const draft = await w.content.get(pkg.dungeon.key);
    expect(draft).toMatchObject({ enabled: false, published: null, draft: pkg.dungeon, draftHash: pkg.contentHash });
    const [row] = await w.t.db.select().from(dungeonLootTables).where(eq(dungeonLootTables.tableKey, key));
    expect(row).toMatchObject({ origin: 'import', revision: 1, body: pkg.bundled.dungeonLootTables[0]!.body, contentHash: pkg.bundled.dungeonLootTables[0]!.contentHash });
    const [event] = await w.t.db.select().from(dungeonLootTableEvents).where(eq(dungeonLootTableEvents.tableKey, key));
    expect(event).toMatchObject({ action: 'imported', origin: 'import', previousContentHash: null, details: { packageId: pkg.packageId, sourceTableKey: key, dungeonKey: pkg.dungeon.key, rewardSnapshotHash: pkg.rewardSnapshot.hash } });
    expect((await w.content.importHistory(pkg.dungeon.key))[0]!.result).toMatchObject({ createdLootTables: [key], sourceSchemaVersion: 2 });
    expect((await w.content.history(pkg.dungeon.key))[0]!.details).toMatchObject({ source: pkg.source, rewardSnapshotHash: pkg.rewardSnapshot.hash });
    expect((await state()).revisions).toEqual(before.revisions);
    expect((await state()).runs).toEqual(before.runs);
  });
  it('reuses identical bodies without modifying table metadata or creating events', async () => {
    const pkg = currencyPackage();
    await installTable(pkg);
    const before = await state();
    expect((await w.content.planImport(pkg)).lootTables).toMatchObject([{ status: 'identical', decision: { action: 'use_existing' } }]);
    const result = await w.content.applyImport(await review(pkg), 'admin');
    expect(result).toMatchObject({ createdLootTables: [], reusedLootTables: [pkg.bundled.dungeonLootTables[0]!.key] });
    const after = await state();
    expect(after.tables).toEqual(before.tables); expect(after.tableEvents).toEqual(before.tableEvents);
  });
  it('requires an explicit conflict choice even when names match and incomplete drafts are allowed', async () => {
    const pkg = currencyPackage();
    await installTable(pkg, coinBody(99));
    const plan = await w.content.planImport(pkg);
    expect(plan.lootTables).toMatchObject([{ status: 'different', decision: null }]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'loot_table_decision_required', severity: 'error' }));
    const before = await state();
    await expect(w.content.applyImport(await review(pkg, {}, true), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
  });
  it('copies a conflict and rewrites every reference without changing source probabilities or destination tables', async () => {
    const original = currencyPackage();
    const definition = structuredClone(original.dungeon);
    definition.rooms[0]!.actions.push({ ...definition.rooms[0]!.actions[0]!, id: 'second_hoard' });
    const pkg = DungeonPackageV2Schema.parse(buildDungeonPackage({ definition, rewardSnapshot: original.rewardSnapshot, source: original.source }));
    const current = await installTable(pkg, coinBody(99));
    const before = await state();
    const copy = fresh('copy');
    const choices = { [current.key]: { action: 'copy' as const, key: copy } };
    const plan = await w.content.planImport(pkg, choices);
    expect(plan.resultingContentHash).not.toBe(pkg.contentHash);
    const result = await w.content.applyImport(await review(pkg, choices), 'admin');
    const draft = (await w.content.get(pkg.dungeon.key))!;
    const refs = draft.draft.rooms.flatMap(room => room.actions.flatMap(action => 'rewards' in action ? action.rewards?.tables.map(t => t.table) ?? [] : []));
    expect(refs).toEqual([copy, copy]);
    expect(result).toMatchObject({ createdLootTables: [copy], tableKeyChanges: { [current.key]: copy }, contentHash: dungeonContentHash(draft.draft) });
    expect(result.contentHash).toBe(plan.resultingContentHash);
    const [copied] = await w.t.db.select().from(dungeonLootTables).where(eq(dungeonLootTables.tableKey, copy));
    expect(copied!.body).toEqual(pkg.bundled.dungeonLootTables[0]!.body);
    expect((await lootService().get(current.key))!.body).toEqual(current.body);
    expect((await state()).tableEvents.filter(e => e.tableKey === current.key)).toEqual(before.tableEvents.filter(e => e.tableKey === current.key));
  });
  it('copies chance percentages, weighted pools and Nothing entries exactly', async () => {
    const rewardBody = DungeonLootTableBodySchema.parse({
      guaranteed: [],
      chances: [{ id: 'bonus', chanceBasisPoints: 2500, grant: { type: 'currency', currency: 'waifubux', amount: { min: 2, max: 5 } } }],
      pools: [{ id: 'pick', name: 'Weighted coins', draws: 2, entries: [
        { id: 'coins', weight: 4, grant: { type: 'currency', currency: 'waifubux', amount: { min: 1, max: 3 } } },
        { id: 'none', weight: 3, nothing: true },
      ] }],
    });
    const pkg = currencyPackage(rewardBody); const current = await installTable(pkg, coinBody(99)); const copy = fresh('weighted_copy');
    const result = await w.content.applyImport(await review(pkg, { [current.key]: { action: 'copy', key: copy } }), 'admin');
    expect(result.createdLootTables).toEqual([copy]);
    const imported = (await lootService().get(copy))!;
    expect(imported.body).toEqual(rewardBody); expect(imported.contentHash).toBe(pkg.bundled.dungeonLootTables[0]!.contentHash);
  });
  it('use-existing reports the changed rewards and applies only the destination body', async () => {
    const pkg = currencyPackage(); const current = await installTable(pkg, coinBody(99));
    const choices = { [current.key]: { action: 'use_existing' as const } };
    const plan = await w.content.planImport(pkg, choices);
    expect(plan.lootTables![0]).toMatchObject({ incomingBody: pkg.bundled.dungeonLootTables[0]!.body, currentBody: coinBody(99) });
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'loot_table_rewards_differ', severity: 'warning' }));
    const before = await state();
    const result = await w.content.applyImport(await review(pkg, choices), 'admin');
    expect(result.createdLootTables).toEqual([]); expect(result.reusedLootTables).toEqual([current.key]);
    expect((await state()).tables).toEqual(before.tables); expect((await state()).tableEvents).toEqual(before.tableEvents);
  });
  it('leave-missing requires explicit incomplete acceptance and creates no table', async () => {
    const pkg = currencyPackage(); const key = pkg.bundled.dungeonLootTables[0]!.key;
    const choices = { [key]: { action: 'leave_missing' as const } };
    await expect(w.content.applyImport(await review(pkg, choices), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    const result = await w.content.applyImport(await review(pkg, choices, true), 'admin');
    expect(result.publishable).toBe(false); expect(result.createdLootTables).toEqual([]);
    expect((await w.content.get(pkg.dungeon.key))!.draft).toEqual(pkg.dungeon);
    await expect(w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
  });
  it('refuses occupied or duplicate copy keys without partial writes', async () => {
    const pkg = currencyPackage(); const current = await installTable(pkg, coinBody(99));
    const choices = { [current.key]: { action: 'copy' as const, key: current.key } };
    const before = await state();
    await expect(w.content.applyImport(await review(pkg, choices), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
  });
  it('replacing an existing published target changes only its draft, keeping publication, enabled state, old revisions and active runs', async () => {
    const pkg = currencyPackage(); await installTable(pkg);
    const { revision } = await w.publish(pkg.dungeon); const player = await w.player(); await w.runs.start(player.playerId, pkg.dungeon.key);
    // Live state alone is no longer a reason to replace: the identical draft is unchanged.
    const identical = await w.content.planImport(pkg);
    expect(identical.target).toMatchObject({ status: 'identical', changedFields: [], enabled: true, publishedRevision: revision.number });
    const before = await state();
    const definition = { ...pkg.dungeon, name: 'Updated hoard' };
    const changed = DungeonPackageV2Schema.parse(buildDungeonPackage({ definition, rewardSnapshot: pkg.rewardSnapshot, source: { environment: 'staging', origin: 'revision', draftRevision: null, publishedRevision: 2 } }));
    const plan = await w.content.planImport(changed);
    expect(plan.target).toMatchObject({ status: 'different', changedFields: ['name'], enabled: true, publishedRevision: revision.number });
    const result = await w.content.applyImport(await review(changed), 'admin');
    expect(result).toMatchObject({ result: 'replaced', enabled: true, publishedRevision: revision.number });
    expect(await w.content.get(pkg.dungeon.key)).toMatchObject({ enabled: true, open: true, published: { revisionId: revision.revisionId }, draft: definition });
    const after = await state(); expect(after.revisions).toEqual(before.revisions); expect(after.runs).toEqual(before.runs);
  });
});
describe('v2 dependencies', () => {
  it.each(['missing', 'disabled', 'capped'] as const)('reports %s items and permits only an explicitly incomplete draft', async status => {
    const slug = fresh('item');
    const item = { name: 'Fragile prize', category: 'material', enabled: true, maxOwned: null };
    if (status !== 'missing') await w.t.db.insert(items).values({ slug, ...item, enabled: status !== 'disabled', maxOwned: status === 'capped' ? 1 : null });
    const body = { guaranteed: [{ id: 'item', grant: { type: 'item', item: slug, quantity: { min: 1, max: 1 } } }], chances: [], pools: [] };
    const pkg = currencyPackage(body, { items: new Map([[slug, item]]) });
    const plan = await w.content.planImport(pkg);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: `reward_item_${status}` }));
    const before = await state();
    await expect(w.content.applyImport(await review(pkg), 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
    const result = await w.content.applyImport(await review(pkg, {}, true), 'admin');
    expect(result.publishable).toBe(false);
    expect((await w.content.get(pkg.dungeon.key))!.draft).toEqual(pkg.dungeon);
    await expect(w.content.publish(pkg.dungeon.key, { expectedRevision: 1 }, 'publisher')).rejects.toMatchObject({ code: 'DUNGEON_INVALID' });
  });
  it('reports candidate identities/names that differ from the source and never imports global gear', async () => {
    const selector = { slot: 'attack' as const, rarity: 'R' as const };
    const body = { guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector } }], chances: [], pools: [] };
    const pkg = currencyPackage(body, { resolveEquipmentSelector: () => [{ key: 'source_sword', name: 'Source sword', slot: 'attack', rarity: 'R', enabled: true }] });
    const before = await w.t.db.select().from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.key));
    const plan = await w.content.planImport(pkg);
    expect(plan.equipmentChanges).toMatchObject([{ removed: [{ key: 'source_sword', name: 'Source sword' }] }]);
    expect(plan.equipmentChanges![0]!.added.length).toBeGreaterThan(0);
    const result = await w.content.applyImport(await review(pkg), 'admin'); expect(result.publishable).toBe(true);
    expect(await w.t.db.select().from(equipmentDefinitions).orderBy(asc(equipmentDefinitions.key))).toEqual(before);
  });
  it('empty selectors block publication and archived identical tables are never restored by import', async () => {
    const selector = { definitionKeys: ['missing_source_sword'] };
    const pkg = currencyPackage({ guaranteed: [{ id: 'gear', grant: { type: 'equipment', selector } }], chances: [], pools: [] }, { resolveEquipmentSelector: () => [{ key: 'missing_source_sword', name: 'Lost sword', slot: 'attack', rarity: 'R', enabled: true }] });
    const current = await installTable(pkg); await lootService().archive(current.key, { expectedRevision: 1 }, 'author');
    const plan = await w.content.planImport(pkg);
    expect(plan.issues.map(i => i.code)).toEqual(expect.arrayContaining(['reward_equipment_empty', 'reward_table_archived']));
    const result = await w.content.applyImport(await review(pkg, {}, true), 'admin'); expect(result.publishable).toBe(false);
    expect((await lootService().get(current.key))!.archivedAt).not.toBeNull();
  });
  it('rejects tampered packages before writes', async () => {
    const pkg = currencyPackage(); pkg.bundled.dungeonLootTables[0]!.body = coinBody(999);
    const before = await state(); const plan = await w.content.planImport(pkg); expect(plan.validPackage).toBe(false);
    await expect(w.content.applyImport({ package: pkg, requestId: randomUUID(), expectedPlanHash: `sha256:${'0'.repeat(64)}`, expectedRevision: null, decisions: { dungeon: 'create', enemies: {}, allowMissingDependencies: true } }, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_INVALID' });
    expect(await state()).toEqual(before);
  });
});
describe('v2 stale plans, locks and receipts', () => {
  it('destination edits and copy-key creation invalidate reviewed plans', async () => {
    const pkg = currencyPackage(); const current = await installTable(pkg, coinBody(99));
    const choices = { [current.key]: { action: 'copy' as const, key: fresh('copy') } };
    const request = await review(pkg, choices);
    await lootService().update(current.key, { expectedRevision: 1, body: coinBody(100) }, 'author');
    await expect(w.content.applyImport(request, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    const next = await review(pkg, choices);
    await lootService().create({ key: choices[current.key]!.key, name: 'Taken', body: coinBody(1) }, 'author');
    await expect(w.content.applyImport(next, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_STALE' });
    expect(await w.content.get(pkg.dungeon.key)).toBeNull();
  });
  it('waits for an in-flight edit and refuses the stale plan after that edit commits', async () => {
    const pkg = currencyPackage(); const current = await installTable(pkg, coinBody(99));
    const request = await review(pkg, { [current.key]: { action: 'use_existing' } });
    const client = await w.t.pool.connect(); let applying: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN'); await client.query('UPDATE dungeon_loot_tables SET revision = revision + 1 WHERE table_key = $1', [current.key]);
      applying = w.content.applyImport(request, 'admin');
      const outcome = applying.then(value => ({ value }), error => ({ error }));
      expect(await waitForLock('LOCK TABLE dungeon_loot_tables%')).toBe(true);
      await client.query('COMMIT');
      expect(await outcome).toMatchObject({ error: { code: 'DUNGEON_IMPORT_STALE' } });
      expect(await w.content.get(pkg.dungeon.key)).toBeNull();
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('holds the equipment catalogue against new candidate inserts until apply commits', async () => {
    const pkg = currencyPackage(); const request = await review(pkg);
    const [template] = await w.t.db.select().from(equipmentDefinitions).limit(1);
    const { id: _id, ...copy } = template!;
    const client = await w.t.pool.connect();
    let importing: Promise<unknown> | undefined;
    let inserting: Promise<unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT currency_key FROM progression_currencies ORDER BY currency_key FOR UPDATE');
      importing = w.content.applyImport(request, 'admin');
      const outcome = importing.then(value => ({ value }), error => ({ error }));
      expect(await waitForLock('%progression_currencies%for share%')).toBe(true);
      inserting = w.t.db.insert(equipmentDefinitions).values({ ...copy, key: fresh('new_candidate'), name: 'Concurrent candidate' }).then(() => undefined);
      expect(await waitForLock('insert into "equipment_definitions"%')).toBe(true);
      await client.query('COMMIT');
      expect(await outcome).toMatchObject({ value: { result: 'created' } });
      await inserting;
    } finally { await client.query('ROLLBACK'); client.release(); await inserting; }
  });
  it('rolls back tables, their events, draft and receipt when the final audit write fails', async () => {
    const pkg = currencyPackage(); const request = await review(pkg); const before = await state();
    await w.t.pool.query("CREATE FUNCTION t17_reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'imported' THEN RAISE EXCEPTION 't17 forced audit failure'; END IF; RETURN NEW; END $$");
    await w.t.pool.query('CREATE TRIGGER t17_reject_import BEFORE INSERT ON dungeon_content_events FOR EACH ROW EXECUTE FUNCTION t17_reject_import()');
    try { await expect(w.content.applyImport(request, 'admin')).rejects.toThrow(/t17 forced audit failure/); expect(await state()).toEqual(before); }
    finally { await w.t.pool.query('DROP TRIGGER t17_reject_import ON dungeon_content_events'); await w.t.pool.query('DROP FUNCTION t17_reject_import()'); }
  });
  it('returns exact committed receipts after later edits and never duplicates content or history', async () => {
    const pkg = currencyPackage(); const request = await review(pkg);
    const first = await w.content.applyImport(request, 'admin');
    await w.content.saveDraft(pkg.dungeon.key, { definition: { ...pkg.dungeon, name: 'Later local draft' }, expectedRevision: 1 }, 'author');
    const before = await state();
    expect(await w.content.applyImport(request, 'admin')).toEqual({ ...first, replayed: true });
    expect(await state()).toEqual(before);
    await expect(w.content.applyImport({ ...request, decisions: { ...request.decisions, allowMissingDependencies: true } }, 'admin')).rejects.toMatchObject({ code: 'DUNGEON_IMPORT_REQUEST_CONFLICT' });
  });
  it('serializes same-request retries and separate imports without table-lock upgrade deadlocks', async () => {
    const one = currencyPackage(); const two = currencyPackage(); const a = await review(one); const b = await review(two);
    const results = await Promise.all([w.content.applyImport(a, 'admin'), w.content.applyImport(a, 'admin'), w.content.applyImport(b, 'admin')]);
    expect(results.map(r => r.replayed)).toEqual([false, true, false]);
    expect((await w.content.importHistory(one.dungeon.key))).toHaveLength(1);
    expect((await w.content.importHistory(two.dungeon.key))).toHaveLength(1);
  });
});
