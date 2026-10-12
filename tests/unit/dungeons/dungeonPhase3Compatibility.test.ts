/**
 * Phase 3 must not move anything an event-free dungeon already hashes to.
 *
 * Every value below was recorded on `Delve` at 0dc68a4, before the event
 * schemas and the shared reward traversal existed. A change here means
 * existing publications would read as "Dungeon changed" and existing v1/v2
 * packages would fail verification.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DungeonLootTableRow } from '../../../src/db/schema';
import { eligibleRewardDefinitions, type EquipmentRewardSelector } from '../../../src/modules/equipment/rewardSelector';
import { canonicalJson } from '../../../src/modules/rewardTables/rewardTableCore';
import { DungeonDefinitionSchema, dungeonDependencies } from '../../../src/modules/dungeons/content/dungeonDefinition';
import { DungeonLootTableBodySchema } from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  dungeonGameplayHash,
  dungeonLootBodyHash,
  resolveDungeonRewardDependencies,
} from '../../../src/modules/dungeons/content/dungeonRewardSnapshot';
import { planDungeonLootImport } from '../../../src/modules/dungeons/package/dungeonLootImport';
import {
  DungeonPackageV2Schema,
  buildDungeonPackage,
  dungeonContentHash,
  readDungeonPackage,
  serializeDungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import { validateDungeonDefinition } from '../../../src/modules/dungeons/validation/dungeonValidation';
import { testDungeon } from '../../helpers/dungeonFixtures';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const EXAMPLE = path.resolve(__dirname, '../../../content/dungeons/examples/service_tunnels.dungeon.json');
const V1_GOLDEN = path.join(__dirname, 'fixtures/packageV1.json');

const selector = { slot: 'attack' as const, rarity: 'R' as const };
const body = (amount: number) => DungeonLootTableBodySchema.parse({
  guaranteed: [{ id: 'item', grant: { type: 'item', item: 'table_item', quantity: { min: 1, max: amount } } }],
  chances: [{ id: 'gear', chanceBasisPoints: 100, grant: { type: 'equipment', selector } }],
  pools: [{ id: 'pick', name: 'Pick', draws: 1, entries: [
    { id: 'prize', weight: 1, grant: { type: 'item', item: 'pool_item', quantity: { min: 1, max: 1 } } },
    { id: 'none', weight: 1, nothing: true },
  ] }],
});
/** Rewards on a fight, a boss and a treasure, in three rooms, so traversal order shows. */
const v2Definition = DungeonDefinitionSchema.parse({
  key: 'golden_v2', name: 'Golden', entranceRoomId: 'a', availableRegions: ['waifu-valley'],
  settings: { progressionCurrency: 'ascension_currency', defeatCurrencyRetentionBasisPoints: 5000 },
  rooms: [
    { id: 'a', name: 'A', actions: [{ id: 'fight', type: 'combat', waves: [{ enemy: { key: 'grunt' } }], rewards: {
      guaranteed: [{ id: 'shards', grant: { type: 'currency', currency: 'shards', amount: { min: 1, max: 3 } } }],
      chances: [{ id: 'gear', chanceBasisPoints: 2500, grant: { type: 'equipment', selector } }],
      tables: [{ id: 't', table: 'loot_b', draws: 2 }],
    } }] },
    { id: 'b', name: 'B', actions: [{ id: 'chest', type: 'reward', rewards: {
      guaranteed: [{ id: 'inline', grant: { type: 'item', item: 'inline_item', quantity: { min: 1, max: 1 } } }],
      chances: [], tables: [{ id: 'one', table: 'loot_a', draws: 1 }, { id: 'two', table: 'loot_b', draws: 1 }],
    } }] },
    { id: 'c', name: 'C', kind: 'exit', actions: [{ id: 'boss', type: 'boss', waves: [{ enemy: { key: 'overlord' } }], rewards: {
      guaranteed: [{ id: 'bux', grant: { type: 'currency', currency: 'waifubux', amount: { min: 5, max: 9 } } }],
      chances: [], tables: [{ id: 'missing', table: 'loot_missing', draws: 1 }],
    } }] },
  ],
  connections: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }],
});
const items = new Map(['inline_item', 'table_item', 'pool_item'].map((slug) => [slug, { name: slug, category: 'material', enabled: true, maxOwned: null }]));
const resolveEquipmentSelector = (s: EquipmentRewardSelector) => eligibleRewardDefinitions(s, [
  { key: 'sword', name: 'Sword', slot: 'attack', rarity: 'R', enabled: true },
]);
const table = (key: string, amount: number) => [key, { name: key, body: body(amount), tier: 'boss', revision: 3, archivedAt: null }] as const;
const brokenContext = { lootTables: new Map([table('loot_a', 1), table('loot_b', 2)]), items, resolveEquipmentSelector };
const completeContext = { ...brokenContext, lootTables: new Map([table('loot_a', 1), table('loot_b', 2), table('loot_missing', 3)]) };

describe('Phase 3 compatibility goldens (recorded before events existed)', () => {
  it('keeps the shipped example and the v1 golden package byte-for-byte', () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    expect(dungeonContentHash(DungeonDefinitionSchema.parse(example.dungeon))).toBe(example.contentHash);
    expect(example.contentHash).toMatchInlineSnapshot(`"sha256:1c6fa06bc5ef51e612f4ed334e67fe2411183a72b55e0832859286241d02d955"`);
    expect(sha(dungeonDependencies(DungeonDefinitionSchema.parse(example.dungeon)))).toMatchInlineSnapshot(`"f990c775651bfb9ed4a48d48a1050a3e1dace9c799eaa09bb94feeb511fd9c7d"`);
    expect(sha(validateDungeonDefinition(example.dungeon).issues)).toMatchInlineSnapshot(`"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"`);

    const golden = fs.readFileSync(V1_GOLDEN, 'utf8');
    const read = readDungeonPackage(golden);
    expect(read.ok).toBe(true);
    expect(serializeDungeonPackage(read.package!)).toBe(golden);
    expect(read.package!.contentHash).toMatchInlineSnapshot(`"sha256:df17d7e4b16b928a446973b1876d50e90a3af02501f0184f7c07968521855d5f"`);
    expect(sha(golden)).toMatchInlineSnapshot(`"806ae06b4757dcee307045bfc99d6d8693dfe5a380230059da50ea9aa5d0ac01"`);
  });

  it('keeps the legacy test dungeon hash, dependencies and issues', () => {
    const legacy = testDungeon();
    expect(dungeonContentHash(legacy)).toMatchInlineSnapshot(`"sha256:df17d7e4b16b928a446973b1876d50e90a3af02501f0184f7c07968521855d5f"`);
    expect(sha(dungeonDependencies(legacy))).toMatchInlineSnapshot(`"a33e78c2f6f306889b79ee9799349b72bcaee8cbdcee34a218afc554247b9535"`);
    expect(sha(validateDungeonDefinition(legacy).issues)).toMatchInlineSnapshot(`"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"`);
    expect(sha(serializeDungeonPackage(buildDungeonPackage({
      definition: legacy, source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null },
      exportedAt: new Date('2026-10-12T00:00:00Z'), packageId: '00000000-0000-4000-8000-000000000003',
    })))).toMatchInlineSnapshot(`"9d97007d5f3c5cf0bd2fab834fe2ecf46e28a6d2a22a1e44daf43261b5286ff1"`);
  });

  it('keeps v2 content, snapshot and gameplay hashes, and the dependency walk', () => {
    expect(dungeonContentHash(v2Definition)).toMatchInlineSnapshot(`"sha256:f183b602ae18b464c623d5a898f06f6c5f6e773bb2b1b08eb8f5e48f018c4003"`);
    expect(dungeonDependencies(v2Definition)).toMatchInlineSnapshot(`
      {
        "artwork": [],
        "currencies": [
          "ascension_currency",
          "waifubux",
        ],
        "enemies": [
          "grunt",
          "overlord",
        ],
        "equipmentSelectors": [
          {
            "rarity": "R",
            "slot": "attack",
          },
        ],
        "items": [
          "inline_item",
        ],
        "lootTables": [
          "loot_a",
          "loot_b",
          "loot_missing",
        ],
        "regions": [
          "waifu-valley",
        ],
        "rewardTables": [],
      }
    `);
    const state = resolveDungeonRewardDependencies(v2Definition, completeContext);
    expect(state.snapshot!.hash).toMatchInlineSnapshot(`"sha256:134164926091aaf374bafc5ac9942c5d61ad71b6e22c74f5ba74bfd33c96ba80"`);
    expect(dungeonGameplayHash(dungeonContentHash(v2Definition), state.snapshot!.hash)).toMatchInlineSnapshot(`"sha256:ae81d53c711bcc265e07d335c37c73bd78249bae42660e8bfa3ac63f3bca60e9"`);
    expect(sha(state)).toMatchInlineSnapshot(`"37d00dbc4c1a02b34a7baadce15b3291063e95df04c804be9ea0d76229985c4c"`);
    expect(sha(resolveDungeonRewardDependencies(v2Definition, brokenContext))).toMatchInlineSnapshot(`"f511c25de6b75d70fea5564b034e8449a187aa4b5290f967a9d9d4daebafba15"`);
  });

  it('keeps v2 validation issues, in order, with their paths', () => {
    const issues = validateDungeonDefinition(v2Definition, brokenContext).issues;
    expect(issues.map((i) => `${i.severity} ${i.code} ${i.path}`)).toMatchInlineSnapshot(`
      [
        "error reward_table_missing rooms[2].actions[0].rewards.tables[0]",
      ]
    `);
    expect(sha(issues)).toMatchInlineSnapshot(`"35d8630a571a5718037629967b7f9c4e6e38b0425c1e41f35d9bbbe2b7377cf1"`);
    const noItems = validateDungeonDefinition(v2Definition, { ...completeContext, items: new Map() }).issues;
    expect(noItems.map((i) => `${i.severity} ${i.code} ${i.path}`)).toMatchInlineSnapshot(`
      [
        "error reward_item_missing rooms[0].actions[0].rewards.tables[0].body.guaranteed[0].grant",
        "error reward_item_missing rooms[0].actions[0].rewards.tables[0].body.pools[0].entries[0].grant",
        "error reward_item_missing rooms[1].actions[0].rewards.guaranteed[0].grant",
        "error reward_item_missing rooms[1].actions[0].rewards.tables[0].body.guaranteed[0].grant",
        "error reward_item_missing rooms[1].actions[0].rewards.tables[0].body.pools[0].entries[0].grant",
        "error reward_item_missing rooms[1].actions[0].rewards.tables[1].body.guaranteed[0].grant",
        "error reward_item_missing rooms[1].actions[0].rewards.tables[1].body.pools[0].entries[0].grant",
        "error reward_item_missing rooms[2].actions[0].rewards.tables[0].body.guaranteed[0].grant",
        "error reward_item_missing rooms[2].actions[0].rewards.tables[0].body.pools[0].entries[0].grant",
      ]
    `);
    expect(sha(noItems)).toMatchInlineSnapshot(`"fb37d4981f2928ae7a4df45d15f2f1f59e02612680309a119491e2d0c07548e8"`);
    expect(sha(validateDungeonDefinition(v2Definition, completeContext).issues)).toMatchInlineSnapshot(`"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"`);
  });

  it('keeps v2 package bytes for a draft and a revision', () => {
    const snapshot = resolveDungeonRewardDependencies(v2Definition, completeContext).snapshot!;
    const bytes = (['draft', 'revision'] as const).map((origin) => {
      const pkg = buildDungeonPackage({
        definition: v2Definition, rewardSnapshot: snapshot,
        source: { environment: 'staging', origin, draftRevision: origin === 'draft' ? 1 : null, publishedRevision: 1 },
        exportedAt: new Date('2026-10-12T00:00:00Z'), packageId: '00000000-0000-4000-8000-000000000003',
      });
      expect(pkg.schemaVersion).toBe(2);
      expect(readDungeonPackage(serializeDungeonPackage(pkg)).ok).toBe(true);
      return `${origin} ${sha(serializeDungeonPackage(pkg))}`;
    });
    expect(bytes).toMatchInlineSnapshot(`
      [
        "draft 8397391ab6e44de7674b4dbb46f3e13c97ff36a61a476b3e1fd52adccea367ea",
        "revision fed8706d14d771072e6c710a1c166744550be2efd2788c9b7a888ebb6a986f68",
      ]
    `);
  });

  it('keeps the import-as-copy rewrite', () => {
    const snapshot = resolveDungeonRewardDependencies(v2Definition, completeContext).snapshot!;
    const pkg = DungeonPackageV2Schema.parse(buildDungeonPackage({
      definition: v2Definition, rewardSnapshot: snapshot,
      source: { environment: 'staging', origin: 'draft', draftRevision: 1, publishedRevision: null },
    }));
    const row: DungeonLootTableRow = {
      tableKey: 'loot_b', body: body(9), contentHash: dungeonLootBodyHash(body(9)), name: 'Target', description: '', tier: null,
      origin: 'portal', archivedAt: null, revision: 2, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), createdBy: null, updatedBy: null,
    };
    const plan = planDungeonLootImport(pkg, [row], { loot_b: { action: 'copy', key: 'loot_b_copy' } });
    expect(dungeonContentHash(plan.definition)).toMatchInlineSnapshot(`"sha256:3fd56f81c10df11fbeabd61bc17ff8496b6d161c45012ff7b85a60d1da163bc7"`);
    expect(dungeonDependencies(plan.definition).lootTables).toEqual(['loot_a', 'loot_b_copy', 'loot_missing']);
  });
});
