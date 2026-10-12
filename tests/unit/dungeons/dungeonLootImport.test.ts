import { describe, expect, it } from 'vitest';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies, dungeonLootBodyHash } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { buildDungeonPackage, DungeonPackageV2Schema } from '../../../src/modules/dungeons/package/dungeonPackage';
import { planDungeonLootImport, DungeonLootImportDecisionsSchema } from '../../../src/modules/dungeons/package/dungeonLootImport';
import { readImportPackage } from '../../../src/modules/dungeons/package/dungeonImportService';
import type { DungeonLootTableRow } from '../../../src/db/schema';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';
const body = (n: number) => DungeonLootTableBodySchema.parse({ guaranteed: [{ id: 'coins', grant: { type: 'currency', currency: 'waifubux', amount: { min: n, max: n } } }], chances: [], pools: [] });
function pkg(keys = ['source_loot']) {
  const definition = singleRoomDungeon([{ id: 'loot', type: 'reward', rewards: { guaranteed: [], chances: [], tables: keys.map((table, i) => ({ id: `loot_${i}`, table, draws: 1 })) } }]);
  const rewardSnapshot = resolveDungeonRewardDependencies(definition, { lootTables: new Map(keys.map(key => [key, { name: 'Loot', body: body(7), archivedAt: null }])) }).snapshot!;
  return DungeonPackageV2Schema.parse(buildDungeonPackage({ definition, rewardSnapshot, source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null } }));
}
function row(key: string, amount = 99): DungeonLootTableRow {
  return { tableKey: key, body: body(amount), contentHash: dungeonLootBodyHash(body(amount)), name: 'Target loot', description: '', tier: null, origin: 'portal', archivedAt: null, revision: 2, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), createdBy: null, updatedBy: null };
}
describe('pure loot import decisions', () => {
  it('defaults missing to create and identical bodies to reuse', () => {
    const p = pkg(); const create = planDungeonLootImport(p, []);
    expect(create.tablePlans[0]).toMatchObject({ status: 'missing', decision: { action: 'create' } });
    expect(create.creations[0]!.body).toEqual(body(7));
    const reuse = planDungeonLootImport(p, [row('source_loot', 7)]); expect(reuse.creations).toEqual([]); expect(reuse.tablePlans[0]!.status).toBe('identical');
  });
  it('requires decisions for conflicts and does not rewrite or create a default copy', () => {
    const p = pkg(); const plan = planDungeonLootImport(p, [row('source_loot')]);
    expect(plan.tablePlans[0]!.decision).toBeNull(); expect(plan.creations).toEqual([]); expect(plan.definition).toEqual(p.dungeon);
    expect(plan.issues[0]!.code).toBe('loot_table_decision_required');
  });
  it('copies exact bodies and rewrites references without mutating package or destination', () => {
    const p = pkg(); const rows = [row('source_loot')]; const before = structuredClone({ p, rows });
    const plan = planDungeonLootImport(p, rows, { source_loot: { action: 'copy', key: 'copied_loot' } });
    expect(plan.creations[0]!.body).toEqual(body(7)); expect(plan.rewrites.get('source_loot')).toBe('copied_loot');
    expect({ p, rows }).toEqual(before); expect(DungeonDefinitionSchema.safeParse(plan.definition).success).toBe(true);
  });
  it('rejects two tables copied to the same key', () => {
    const plan = planDungeonLootImport(pkg(['one', 'two']), [row('one'), row('two')], { one: { action: 'copy', key: 'copy' }, two: { action: 'copy', key: 'copy' } });
    expect(plan.creations).toHaveLength(1); expect(plan.issues.map(i => i.code)).toContain('loot_table_copy_key_taken');
  });
  it('suggests bounded portable keys even when the source key is64 characters and suggestions are occupied', () => {
    const source = 'a'.repeat(64); const plan = planDungeonLootImport(pkg([source]), [row(source), row(`${'a'.repeat(55)}_imported`)]);
    expect(plan.tablePlans[0]!.suggestedCopyKey).toHaveLength(64); expect(plan.tablePlans[0]!.suggestedCopyKey).toMatch(/_imported_2$/);
  });
  it('suggests distinct keys for source keys sharing the truncated prefix', () => {
    const one = `${'a'.repeat(63)}b`; const two = `${'a'.repeat(63)}c`;
    const plan = planDungeonLootImport(pkg([one, two]), [row(one), row(two)]);
    expect(new Set(plan.tablePlans.map(t => t.suggestedCopyKey)).size).toBe(2);
  });
  it('rejects unrelated, state-incompatible and overwrite choices', () => {
    expect(planDungeonLootImport(pkg(), [], { stranger: { action: 'create' } }).issues[0]!.code).toBe('loot_table_decision_invalid');
    expect(planDungeonLootImport(pkg(), [row('source_loot')], { source_loot: { action: 'create' } }).issues[0]!.code).toBe('loot_table_decision_invalid');
    expect(DungeonLootImportDecisionsSchema.safeParse({ source_loot: { action: 'overwrite' } }).success).toBe(false);
    expect(DungeonLootImportDecisionsSchema.safeParse({ source_loot: { action: 'copy', key: 'Invalid key' } }).success).toBe(false);
  });
  it('warns about use-existing and leaves current contents untouched', () => {
    const rows = [row('source_loot')]; const plan = planDungeonLootImport(pkg(), rows, { source_loot: { action: 'use_existing' } });
    expect(plan.creations).toEqual([]); expect(plan.issues[0]).toMatchObject({ severity: 'warning', code: 'loot_table_rewards_differ' }); expect(rows[0]!.body).toEqual(body(99));
  });
  it('rejects Phase2 content disguised as v1 before a legacy import can ignore it', () => {
    const p = pkg(); const { rewardSnapshot: _snapshot, rewardSnapshotHash: _hash, ...envelope } = p;
    const { dungeonLootTables: _tables, ...dependencies } = p.dependencies;
    const downgraded = { ...envelope, schemaVersion: 1, dependencies: { ...dependencies, equipment: [] }, bundled: { enemies: [] } };
    expect(readImportPackage(downgraded)).toMatchObject({ ok: false, package: null, issues: expect.arrayContaining([expect.objectContaining({ code: 'package_schema_version' })]) });
  });
});
