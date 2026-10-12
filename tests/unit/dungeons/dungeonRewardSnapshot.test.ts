/** T6 reward snapshots: what is pinned, what the two hashes cover, and how drift is reported. Pure. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DungeonDefinitionSchema } from '../../../src/modules/dungeons/content/dungeonDefinition';
import type {
  DungeonLootTableBody,
  DungeonRewardBundle,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  DungeonRewardSnapshotSchema,
  dungeonGameplayHash,
  dungeonLootBodyHash,
  dungeonRewardDependencyChanges,
  dungeonRewardSnapshotHash,
  hasDungeonRewardBundles,
  readDungeonRewardSnapshot,
  resolveDungeonRewardDependencies,
} from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { dungeonLootTableContentHash } from '../../../src/modules/dungeons/dungeonLootTableService';
import { resolveRewardBundle } from '../../../src/modules/dungeons/engine/lootResolver';
import { dungeonContentHash } from '../../../src/modules/dungeons/package/dungeonPackage';
import type { DungeonRewardValidationContext } from '../../../src/modules/dungeons/validation/dungeonRewardValidation';
import {
  eligibleRewardDefinitions,
  equipmentSelectorKey,
  type RewardableDefinition,
} from '../../../src/modules/equipment/rewardSelector';
import { canonicalJson } from '../../../src/modules/rewardTables/rewardTableCore';
import { singleRoomDungeon, testDungeon } from '../../helpers/dungeonFixtures';

const selector = { slot: 'attack', rarity: 'R' } as const;
const selectorKey = equipmentSelectorKey(selector);
const hoard = (quantity = 1): DungeonLootTableBody => ({
  guaranteed: [
    { id: 'charm', grant: { type: 'item', item: 'charm', quantity: { min: quantity, max: quantity } } },
  ],
  chances: [{ id: 'gear', chanceBasisPoints: 5000, grant: { type: 'equipment', selector } }],
  pools: [
    {
      id: 'extras',
      name: 'Extras',
      draws: 1,
      entries: [
        { id: 'none', weight: 1, nothing: true },
        { id: 'gem', weight: 1, grant: { type: 'item', item: 'gem', quantity: { min: 1, max: 1 } } },
      ],
    },
  ],
});
const bundle: DungeonRewardBundle = {
  guaranteed: [{ id: 'coin', grant: { type: 'item', item: 'coin', quantity: { min: 1, max: 1 } } }],
  chances: [],
  tables: [{ id: 'loot', table: 'hoard', draws: 1 }],
};
const dungeon = (rewards: DungeonRewardBundle = bundle) =>
  singleRoomDungeon([{ id: 'boss_hoard', type: 'reward', rewards }]);
const gear: RewardableDefinition[] = [
  { key: 'zweihander', name: 'Zweihander', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'axe', name: 'Axe', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'shield', name: 'Shield', slot: 'defense', rarity: 'R', enabled: true },
];
const item = (name: string) => ({ name, category: 'material', enabled: true, maxOwned: null });
const context = (
  over: {
    body?: unknown;
    table?: Partial<{ name: string; tier: string | null; revision: number; archivedAt: Date | null }>;
    gear?: RewardableDefinition[];
    items?: [string, ReturnType<typeof item>][];
    noTable?: boolean;
  } = {},
): DungeonRewardValidationContext => ({
  lootTables: new Map(
    over.noTable
      ? []
      : [
          [
            'hoard',
            { name: 'Boss Hoard', tier: 'boss', revision: 3, archivedAt: null, body: over.body ?? hoard(), ...over.table },
          ],
        ],
  ),
  items: new Map(over.items ?? [['charm', item('Charm')], ['gem', item('Gem')], ['coin', item('Coin')]]),
  resolveEquipmentSelector: (s) => eligibleRewardDefinitions(s, over.gear ?? gear),
});
const snapshotOf = (ctx = context()) => {
  const { snapshot } = resolveDungeonRewardDependencies(dungeon(), ctx);
  if (!snapshot) throw new Error('expected a complete snapshot');
  return snapshot;
};

describe('building a reward snapshot', () => {
  it('pins exact table bodies, eligible equipment identities, item metadata and the resolver version', () => {
    const snapshot = snapshotOf();
    expect(snapshot).toEqual({
      format: 'waifumon-dungeon-reward-snapshot',
      version: 1,
      resolverVersion: 1,
      tables: {
        hoard: {
          key: 'hoard',
          name: 'Boss Hoard',
          tier: 'boss',
          sourceRevision: 3,
          contentHash: dungeonLootTableContentHash(hoard()),
          body: hoard(),
        },
      },
      equipmentPools: {
        [selectorKey]: [
          { key: 'axe', name: 'Axe', slot: 'attack', rarity: 'R' },
          { key: 'zweihander', name: 'Zweihander', slot: 'attack', rarity: 'R' },
        ],
      },
      items: {
        charm: { name: 'Charm', category: 'material' },
        coin: { name: 'Coin', category: 'material' },
        gem: { name: 'Gem', category: 'material' },
      },
      hash: snapshot.hash,
    });
    expect(DungeonRewardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.hash).toBe(dungeonRewardSnapshotHash(snapshot));
    expect(dungeonLootBodyHash(hoard())).toBe(dungeonLootTableContentHash(hoard()));
  });
  it('is deterministic whatever order the catalogues were read in, and survives a JSON round trip', () => {
    const reordered = snapshotOf(
      context({ gear: [...gear].reverse(), items: [['gem', item('Gem')], ['coin', item('Coin')], ['charm', item('Charm')]] }),
    );
    expect(canonicalJson(reordered)).toBe(canonicalJson(snapshotOf()));
    expect(readDungeonRewardSnapshot(JSON.parse(JSON.stringify(snapshotOf())))).toEqual(snapshotOf());
  });
  it('gives a legacy-only definition no snapshot and no reported changes', () => {
    const legacy = testDungeon();
    expect(hasDungeonRewardBundles(legacy)).toBe(false);
    const state = resolveDungeonRewardDependencies(legacy, context());
    expect(state).toEqual({ tables: {}, equipment: {}, items: {}, snapshot: null });
    expect(dungeonRewardDependencyChanges(null, state)).toEqual([]);
  });
  it('pins an empty v2 bundle as an empty snapshot rather than as legacy', () => {
    const { snapshot } = resolveDungeonRewardDependencies(
      dungeon({ guaranteed: [], chances: [], tables: [] }),
      context(),
    );
    expect(snapshot).toMatchObject({ tables: {}, equipmentPools: {}, items: {} });
  });
  it.each([
    ['a missing table', context({ noTable: true })],
    ['an archived table', context({ table: { archivedAt: new Date() } })],
    ['an unreadable table body', context({ body: { guaranteed: 'nope' } })],
    ['a missing item', context({ items: [['charm', item('Charm')], ['coin', item('Coin')]] })],
    ['a selector nothing matches', context({ gear: [gear[2]!] })],
    ['an omitted catalogue', {}],
  ])('builds nothing while there is %s', (_name, ctx) => {
    expect(resolveDungeonRewardDependencies(dungeon(), ctx).snapshot).toBeNull();
  });
  it('rejects a stored snapshot that was altered after it was hashed', () => {
    const snapshot = snapshotOf();
    const tampered = structuredClone(snapshot);
    tampered.tables.hoard!.body = hoard(99);
    expect(readDungeonRewardSnapshot(tampered)).toBeNull();
    expect(readDungeonRewardSnapshot({ ...snapshot, equipmentPools: {} })).toBeNull();
    expect(readDungeonRewardSnapshot({ ...snapshot, extra: true })).toBeNull();
    expect(readDungeonRewardSnapshot(null)).toBeNull();
  });
  it('feeds the T2 resolver unchanged, so a pinned revision can be rolled later', () => {
    const snapshot = snapshotOf();
    const view = {
      hash: snapshot.hash,
      tables: new Map(Object.entries(snapshot.tables).map(([key, t]) => [key, t.body])),
      equipmentPools: snapshot.equipmentPools,
    };
    const identity = { roomId: 'hall', actionId: 'boss_hoard' };
    const plan = resolveRewardBundle(bundle, view, 42, identity);
    expect(plan).toMatchObject({ v: 2, snapshotHash: snapshot.hash });
    expect(resolveRewardBundle(bundle, view, 42, identity)).toEqual(plan);
  });
});

describe('what the hashes cover', () => {
  const base = snapshotOf();
  it('ignores display metadata: table name, tier and authoring revision, item and gear names', () => {
    const renamed = snapshotOf(
      context({
        table: { name: 'Renamed', tier: null, revision: 9 },
        items: [['charm', { ...item('Lucky Charm'), category: 'key' }], ['gem', item('Gem')], ['coin', item('Coin')]],
        gear: gear.map((g) => ({ ...g, name: `${g.name} II` })),
      }),
    );
    expect(renamed.tables.hoard).toMatchObject({ name: 'Renamed', tier: null, sourceRevision: 9 });
    expect(renamed.hash).toBe(base.hash);
  });
  it('changes with a table body', () => {
    const edited = snapshotOf(context({ body: hoard(2) }));
    expect(edited.hash).not.toBe(base.hash);
    expect(edited.tables.hoard!.contentHash).not.toBe(base.tables.hoard!.contentHash);
  });
  it('changes when the eligible equipment changes, in either direction', () => {
    const more = snapshotOf(
      context({ gear: [...gear, { key: 'club', name: 'Club', slot: 'attack', rarity: 'R', enabled: true }] }),
    );
    const fewer = snapshotOf(context({ gear: gear.map((g) => (g.key === 'axe' ? { ...g, enabled: false } : g)) }));
    expect(new Set([base.hash, more.hash, fewer.hash]).size).toBe(3);
  });
  it('derives the gameplay hash from the untouched content hash and the snapshot hash', () => {
    const definition = dungeon();
    const contentHash = dungeonContentHash(definition);
    const expected = `sha256:${createHash('sha256')
      .update(canonicalJson({ v: 1, contentHash, rewardSnapshotHash: base.hash }))
      .digest('hex')}`;
    expect(dungeonGameplayHash(contentHash, base.hash)).toBe(expected);
    expect(dungeonGameplayHash(contentHash, snapshotOf(context({ body: hoard(2) })).hash)).not.toBe(expected);
    // Building a snapshot never touches the definition or its hash.
    expect(dungeonContentHash(DungeonDefinitionSchema.parse(definition))).toBe(contentHash);
  });
});

describe('reporting dependency changes', () => {
  const published = snapshotOf();
  const changes = (ctx: DungeonRewardValidationContext) =>
    dungeonRewardDependencyChanges(published, resolveDungeonRewardDependencies(dungeon(), ctx));
  it('reports nothing while the catalogues still match, metadata edits included', () => {
    expect(changes(context())).toEqual([]);
    expect(changes(context({ table: { name: 'Renamed', revision: 7 } }))).toEqual([]);
  });
  it('reports a changed, archived, missing or unreadable table with both hashes', () => {
    const publishedHash = published.tables.hoard!.contentHash;
    expect(changes(context({ body: hoard(2) }))).toEqual([
      { kind: 'table', tableKey: 'hoard', name: 'Boss Hoard', status: 'changed', publishedHash, currentHash: dungeonLootBodyHash(hoard(2)) },
    ]);
    expect(changes(context({ table: { archivedAt: new Date() } }))).toEqual([
      { kind: 'table', tableKey: 'hoard', name: 'Boss Hoard', status: 'archived', publishedHash, currentHash: publishedHash },
    ]);
    // A deleted table is named from the snapshot.
    expect(changes(context({ noTable: true }))).toEqual([
      { kind: 'table', tableKey: 'hoard', name: 'Boss Hoard', status: 'missing', publishedHash, currentHash: null },
    ]);
    expect(changes(context({ body: {} }))).toMatchObject([{ kind: 'table', status: 'invalid', currentHash: null }]);
  });
  it('reports equipment that became or stopped being eligible', () => {
    const club: RewardableDefinition = { key: 'club', name: 'Club', slot: 'attack', rarity: 'R', enabled: true };
    expect(changes(context({ gear: [...gear.filter((g) => g.key !== 'axe'), club] }))).toEqual([
      { kind: 'equipment', selectorKey, description: 'Any R Attack Equipment', status: 'changed', added: ['club'], removed: ['axe'] },
    ]);
    expect(changes(context({ gear: [gear[2]!] }))).toEqual([
      { kind: 'equipment', selectorKey, description: 'Any R Attack Equipment', status: 'empty', added: [], removed: ['axe', 'zweihander'] },
    ]);
  });
  it('lists a broken dependency even when nothing is published, and nothing for a healthy unpublished draft', () => {
    const none = (ctx: DungeonRewardValidationContext) =>
      dungeonRewardDependencyChanges(null, resolveDungeonRewardDependencies(dungeon(), ctx));
    expect(none(context())).toEqual([]);
    expect(none(context({ noTable: true }))).toEqual([
      { kind: 'table', tableKey: 'hoard', name: 'hoard', status: 'missing', publishedHash: null, currentHash: null },
    ]);
  });
});
