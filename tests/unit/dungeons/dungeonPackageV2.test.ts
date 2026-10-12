import { describe, expect, it } from 'vitest';
import { eligibleRewardDefinitions, equipmentSelectorKey, type EquipmentRewardSelector } from '../../../src/modules/equipment/rewardSelector';
import { DungeonLootTableBodySchema } from '../../../src/modules/dungeons/content/dungeonRewards';
import { resolveDungeonRewardDependencies, dungeonRewardSnapshotHash } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { buildDungeonPackage, readDungeonPackage, serializeDungeonPackage, DungeonPackageV2Schema } from '../../../src/modules/dungeons/package/dungeonPackage';
import { singleRoomDungeon } from '../../helpers/dungeonFixtures';

const selector = { slot: 'attack' as const, rarity: 'R' as const };
const body = DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'item', grant: { type: 'item', item: 'table_item', quantity: { min: 1, max: 2 } } }],
  chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector } }],
  pools: [{ id: 'pick', name: 'Pick', draws: 1, entries: [
    { id: 'prize', weight: 1, grant: { type: 'item', item: 'pool_item', quantity: { min: 1, max: 1 } } },
    { id: 'none', weight: 1, nothing: true },
  ] }],
});
const definition = singleRoomDungeon([{ id: 'loot', type: 'reward', rewards: {
  guaranteed: [{ id: 'inline', grant: { type: 'item', item: 'inline_item', quantity: { min: 1, max: 1 } } }],
  chances: [], tables: [{ id: 'one', table: 'loot_one', draws: 1 }, { id: 'two', table: 'loot_two', draws: 1 }],
} }], d => { d.flags = []; });
const context = {
  lootTables: new Map(['loot_two', 'loot_one'].map(key => [key, { name: key, body, tier: 'boss', revision: 3, archivedAt: null }])),
  items: new Map(['inline_item', 'table_item', 'pool_item'].map(slug => [slug, { name: slug, category: 'material', enabled: true, maxOwned: null }])),
  resolveEquipmentSelector: (s: EquipmentRewardSelector) => eligibleRewardDefinitions(s, [
    { key: 'sword', name: 'Sword', slot: 'attack', rarity: 'R', enabled: true },
  ]),
};
function build(origin: 'draft' | 'revision' = 'draft') {
  const snapshot = resolveDungeonRewardDependencies(definition, context).snapshot!;
  return DungeonPackageV2Schema.parse(buildDungeonPackage({ definition, rewardSnapshot: snapshot,
    source: { environment: 'staging', origin, draftRevision: origin === 'draft' ? 1 : null, publishedRevision: 1 },
    exportedAt: new Date('2026-10-12T00:00:00Z'), packageId: '00000000-0000-4000-8000-000000000016',
  }));
}
type Package = ReturnType<typeof build>;
const mutate = (change: (pkg: Package) => void) => { const pkg = build(); change(pkg); return readDungeonPackage(pkg); };

describe('v2 package evidence', () => {
  it.each(['draft', 'revision'] as const)('round-trips %s rewards with complete manifests and provenance', origin => {
    const pkg = build(origin);
    expect(pkg.dependencies.dungeonLootTables.map(t => t.key)).toEqual(['loot_one', 'loot_two']);
    expect(pkg.dependencies.items).toEqual(['inline_item', 'pool_item', 'table_item']);
    expect(pkg.dependencies.equipment).toEqual([{ selectorKey: equipmentSelectorKey(selector), candidateKeys: ['sword'] }]);
    expect(pkg.rewardSnapshot.equipmentPools[equipmentSelectorKey(selector)]).toEqual([{ key: 'sword', name: 'Sword', slot: 'attack', rarity: 'R' }]);
    expect(pkg.bundled.dungeonLootTables[0]).toMatchObject({ sourceRevision: 3, tier: 'boss', body });
    expect(pkg.rewardSnapshotHash).toBe(origin === 'draft' ? null : pkg.rewardSnapshot.hash);
    const text = serializeDungeonPackage(pkg);
    expect(readDungeonPackage(text)).toEqual({ ok: true, issues: [], package: pkg });
    expect(serializeDungeonPackage(build(origin))).toBe(text);
  });

  it('exports an empty Phase 2 bundle as v2 with explicit empty manifests', () => {
    const empty = singleRoomDungeon([{ id: 'empty', type: 'reward', rewards: { guaranteed: [], chances: [], tables: [] } }]);
    const snapshot = resolveDungeonRewardDependencies(empty, context).snapshot!;
    const pkg = DungeonPackageV2Schema.parse(buildDungeonPackage({ definition: empty, rewardSnapshot: snapshot, source: build().source }));
    expect(pkg.dependencies).toMatchObject({ items: [], equipment: [], dungeonLootTables: [] });
    expect(pkg.bundled.dungeonLootTables).toEqual([]);
    expect(readDungeonPackage(pkg).ok).toBe(true);
  });

  it('preserves legacy dependencies in a dungeon with both reward formats', () => {
    const mixed = structuredClone(definition);
    mixed.rooms[0]!.actions.push({ id: 'legacy', type: 'reward', reward: { rewardTable: 'old_table', equipmentRewardTable: null, currency: { min: 0, max: 1 } }, label: '', optional: false, outcomes: {} });
    const snapshot = resolveDungeonRewardDependencies(mixed, context).snapshot!;
    const pkg = DungeonPackageV2Schema.parse(buildDungeonPackage({ definition: mixed, rewardSnapshot: snapshot, source: build().source }));
    expect(pkg.dependencies.rewardTables).toEqual([{ kind: 'expedition', id: 'old_table' }]);
    expect(pkg.dependencies.items).toEqual(['inline_item', 'pool_item', 'table_item']);
    expect(readDungeonPackage(pkg).ok).toBe(true);
  });

  it('requires a published snapshot hash and refuses extra snapshot tables even with a recomputed hash', () => {
    const revision = build('revision');
    expect(readDungeonPackage({ ...revision, rewardSnapshotHash: null }).ok).toBe(false);
    const draft = build();
    draft.rewardSnapshot.tables.extra = { ...draft.rewardSnapshot.tables.loot_one!, key: 'extra' };
    draft.rewardSnapshot.hash = dungeonRewardSnapshotHash(draft.rewardSnapshot);
    expect(readDungeonPackage(draft).ok).toBe(false);
  });

  it('refuses to invent a snapshot for v2 content', () => {
    expect(() => buildDungeonPackage({ definition, source: build().source })).toThrow(/snapshot/);
  });

  it.each([
    ['tampered body', (p: Package) => { p.bundled.dungeonLootTables[0]!.body.guaranteed = []; }],
    ['wrong body hash', (p: Package) => { p.bundled.dungeonLootTables[0]!.contentHash = '0'.repeat(64); }],
    ['missing table', (p: Package) => { p.bundled.dungeonLootTables.pop(); }],
    ['extra table', (p: Package) => { p.bundled.dungeonLootTables.push({ ...p.bundled.dungeonLootTables[0]!, key: 'extra' }); }],
    ['duplicate table', (p: Package) => { p.bundled.dungeonLootTables.push(p.bundled.dungeonLootTables[0]!); }],
    ['wrong table manifest', (p: Package) => { p.dependencies.dungeonLootTables[0]!.contentHash = '0'.repeat(64); }],
    ['duplicate manifest key', (p: Package) => { p.dependencies.dungeonLootTables.push(p.dependencies.dungeonLootTables[0]!); }],
    ['missing item manifest', (p: Package) => { p.dependencies.items.pop(); }],
    ['extra item manifest', (p: Package) => { p.dependencies.items.push('extra'); }],
    ['wrong equipment manifest', (p: Package) => { p.dependencies.equipment[0]!.candidateKeys = ['other']; }],
    ['missing equipment manifest', (p: Package) => { p.dependencies.equipment = []; }],
    ['bad snapshot hash', (p: Package) => { p.rewardSnapshot.hash = `sha256:${'0'.repeat(64)}`; }],
    ['bad origin hash', (p: Package) => { p.rewardSnapshotHash = p.rewardSnapshot.hash; }],
    ['extra snapshot item', (p: Package) => { p.rewardSnapshot.items.extra = { name: 'extra', category: 'material' }; p.rewardSnapshot.hash = dungeonRewardSnapshotHash(p.rewardSnapshot); p.dependencies.items.push('extra'); }],
    ['extra equipment pool', (p: Package) => { p.rewardSnapshot.equipmentPools.extra = p.rewardSnapshot.equipmentPools[equipmentSelectorKey(selector)]!; p.rewardSnapshot.hash = dungeonRewardSnapshotHash(p.rewardSnapshot); }],
    ['duplicate candidate', (p: Package) => { const pool = p.rewardSnapshot.equipmentPools[equipmentSelectorKey(selector)]!; pool.push(pool[0]!); p.rewardSnapshot.hash = dungeonRewardSnapshotHash(p.rewardSnapshot); }],
    ['incompatible candidate', (p: Package) => { p.rewardSnapshot.equipmentPools[equipmentSelectorKey(selector)]![0]!.slot = 'health'; }],
    ['wrong snapshot table key', (p: Package) => { p.rewardSnapshot.tables.loot_one!.key = 'other'; }],
  ] as const)('rejects %s', (_name, change) => { expect(mutate(change).ok).toBe(false); });

  it.each(['enemies', 'rewardTables', 'regions', 'currencies', 'species', 'items', 'equipment', 'dungeonLootTables'] as const)('requires the %s manifest even when otherwise sound', member => {
    const pkg = build();
    const { [member]: _removed, ...dependencies } = pkg.dependencies;
    expect(readDungeonPackage({ ...pkg, dependencies }).ok).toBe(false);
  });
  it('rejects malformed bodies and unsupported snapshot/resolver versions', () => {
    for (const raw of [
      { ...build(), rewardSnapshot: { ...build().rewardSnapshot, version: 2 } },
      { ...build(), rewardSnapshot: { ...build().rewardSnapshot, resolverVersion: 2 } },
      { ...build(), bundled: { ...build().bundled, dungeonLootTables: [{ ...build().bundled.dungeonLootTables[0], body: {} }] } },
      { ...build(), schemaVersion: 99 },
    ]) expect(readDungeonPackage(raw).ok).toBe(false);
  });
});
