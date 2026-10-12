import { describe, expect, it } from 'vitest';
import { dungeonContentHash, buildDungeonPackage, DungeonPackageV3Schema, readDungeonPackage, serializeDungeonPackage } from '../../../src/modules/dungeons/package/dungeonPackage';
import { readImportPackage } from '../../../src/modules/dungeons/package/dungeonImportService';
import { dungeonRewardSnapshotHash } from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { eventDungeon, eventRewardSnapshot } from '../../helpers/dungeonEventFixtures';

const source = { environment: 'staging', origin: 'draft' as const, draftRevision: 1, publishedRevision: null };
const build = (origin: 'draft' | 'revision' = 'draft') => {
  const definition = eventDungeon(d => {
    d.events![0]!.artwork = { kind: 'shipped', path: 'dungeons/vault.webp' };
    d.events![0]!.choices[2]!.items = [{ item: 'z_token', quantity: 2 }, { item: 'a_token', quantity: 1 }];
    d.events![4]!.choices[0]!.items = [{ item: 'unused_token', quantity: 1 }];
    d.events![4]!.choices.push({ id: 'skip', label: 'Skip it', outcome: {} });
  });
  return DungeonPackageV3Schema.parse(buildDungeonPackage({ definition, rewardSnapshot: eventRewardSnapshot(definition),
    source: { ...source, origin, draftRevision: origin === 'draft' ? 1 : null, publishedRevision: origin === 'revision' ? 1 : null } }));
};
type Package = ReturnType<typeof build>;
const bare = () => eventDungeon(d => {
  for (const event of d.events!) for (const choice of event.choices)
    for (const branch of ['outcome', 'success', 'failure'] as const) delete choice[branch]?.rewards;
});

describe('package v3 event portability', () => {
  it.each(['draft', 'revision'] as const)('includes exact event/pool definitions, artwork and reachable reward evidence for %s', origin => {
    const pkg = build(origin);
    expect(pkg.schemaVersion).toBe(3);
    expect(pkg.dungeon.events).toEqual(build().dungeon.events);
    expect(pkg.dungeon.eventPools).toEqual(build().dungeon.eventPools);
    expect(pkg.dependencies.requiredItems).toEqual(['a_token', 'vault_key', 'z_token']);
    expect(pkg.dependencies.items).toEqual(['scrap_parts']);
    expect(pkg.dependencies.dungeonLootTables.map(t => t.key)).toEqual(['vault_hoard']);
    expect(pkg.bundled.dungeonLootTables.map(t => t.key)).toEqual(['vault_hoard']);
    expect(pkg.assets).toEqual([{ kind: 'shipped', path: 'dungeons/vault.webp' }]);
    expect(pkg.rewardSnapshotHash).toBe(origin === 'revision' ? pkg.rewardSnapshot!.hash : null);
    expect(readDungeonPackage(pkg).ok).toBe(true);
    expect(readImportPackage(pkg).ok).toBe(true);
    expect(serializeDungeonPackage(readDungeonPackage(serializeDungeonPackage(pkg)).package!)).toBe(serializeDungeonPackage(pkg));
  });
  it.each(['draft', 'revision'] as const)('carries reward-free events as v3 with null evidence for %s', origin => {
    const definition = bare();
    const pkg = DungeonPackageV3Schema.parse(buildDungeonPackage({ definition, source: { ...source, origin } }));
    expect(pkg).toMatchObject({ rewardSnapshot: null, rewardSnapshotHash: null, dependencies: { items: [], equipment: [], dungeonLootTables: [], requiredItems: ['vault_key'] }, bundled: { dungeonLootTables: [] } });
    expect(readImportPackage(pkg).ok).toBe(true);
  });
  it('excludes unused library rewards and item requirements even when they are the only rewards', () => {
    const definition = bare();
    definition.events![4]!.choices[0]!.outcome!.rewards = build().dungeon.events![4]!.choices[0]!.outcome!.rewards;
    definition.events![4]!.choices[0]!.items = [{ item: 'unused_token', quantity: 1, consume: false }];
    definition.events![4]!.choices.push({ id: 'skip', label: 'Skip it', outcome: { text: '', effects: [] } });
    const pkg = DungeonPackageV3Schema.parse(buildDungeonPackage({ definition, source }));
    expect(pkg.rewardSnapshot).toBeNull();
    expect(pkg.dependencies.requiredItems).toEqual(['vault_key']);
    expect(readDungeonPackage(pkg).ok).toBe(true);
  });
  it.each([
    ['missing manifest', (p: Package) => { delete (p.dependencies as Partial<Package['dependencies']>).requiredItems; }],
    ['missing item', (p: Package) => { p.dependencies.requiredItems.pop(); }],
    ['extra item', (p: Package) => { p.dependencies.requiredItems.push('unused_token'); }],
    ['duplicate item', (p: Package) => { p.dependencies.requiredItems.push('vault_key'); }],
    ['wrong sort', (p: Package) => { p.dependencies.requiredItems.reverse(); }],
    ['missing table', (p: Package) => { p.bundled.dungeonLootTables = []; }],
    ['duplicate table', (p: Package) => { p.bundled.dungeonLootTables.push(p.bundled.dungeonLootTables[0]!); }],
    ['duplicate table identity', (p: Package) => { p.dependencies.dungeonLootTables.push(p.dependencies.dungeonLootTables[0]!); }],
    ['tampered table', (p: Package) => { p.bundled.dungeonLootTables[0]!.body.pools.push({ id: 'other', name: 'Other', draws: 1, entries: [{ id: 'n', weight: 1, nothing: true }] }); }],
    ['tampered snapshot hash', (p: Package) => { p.rewardSnapshot!.hash = `sha256:${'0'.repeat(64)}`; }],
    ['missing snapshot', (p: Package) => { p.rewardSnapshot = null; }],
    ['incorrect origin evidence', (p: Package) => { p.rewardSnapshotHash = p.rewardSnapshot!.hash; }],
    ['extra snapshot item', (p: Package) => { p.rewardSnapshot!.items.extra = { name: 'Extra', category: 'material' }; p.rewardSnapshot!.hash = dungeonRewardSnapshotHash(p.rewardSnapshot!); }],
    ['invalid pool weight', (p: Package) => { p.dungeon.eventPools![0]!.entries[0]!.weight = 0; }],
    ['duplicate pool entry', (p: Package) => { p.dungeon.eventPools![0]!.entries.push(p.dungeon.eventPools![0]!.entries[0]!); }],
    ['invalid event reference', (p: Package) => { const entry = p.dungeon.eventPools![0]!.entries[0]!; if ('eventId' in entry) entry.eventId = 'absent'; }],
    ['invalid choice', (p: Package) => { p.dungeon.events![0]!.choices[0]!.label = ''; }],
    ['invalid effect', (p: Package) => { (p.dungeon.events![0]!.choices[0]!.outcome!.effects[0] as { type: string }).type = 'capture'; }],
  ] as const)('rejects %s in the reader and importer', (_name, tamper) => {
    const pkg = build(); tamper(pkg);
    // Structural tampering is rejected independently of the definition hash.
    try { pkg.contentHash = dungeonContentHash(pkg.dungeon); } catch { /* invalid schema */ }
    expect(readDungeonPackage(pkg).ok).toBe(false);
    expect(readImportPackage(pkg).ok).toBe(false);
  });
  it.each([1, 2])('rejects event content disguised as v%s', schemaVersion => {
    const pkg = build();
    const disguised = { ...pkg, schemaVersion };
    expect(readDungeonPackage(disguised).issues).toContainEqual(expect.objectContaining({ code: 'package_schema_version' }));
    expect(readImportPackage(disguised).ok).toBe(false);
  });
  it('rejects reward evidence or loot in a reward-free v3 package', () => {
    const pkg = DungeonPackageV3Schema.parse(buildDungeonPackage({ definition: bare(), source }));
    const withEvidence = { ...pkg, rewardSnapshot: build().rewardSnapshot };
    expect(readDungeonPackage(withEvidence).ok).toBe(false);
    expect(readDungeonPackage({ ...pkg, rewardSnapshotHash: build().rewardSnapshot!.hash }).ok).toBe(false);
    expect(readDungeonPackage({ ...pkg, bundled: build().bundled }).ok).toBe(false);
    expect(readDungeonPackage({ ...pkg, dependencies: { ...pkg.dependencies, items: ['scrap_parts'] } }).ok).toBe(false);
  });
});
