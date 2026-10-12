import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DungeonActionSchema,
  DungeonDefinitionSchema,
  DungeonSettingsSchema,
  dungeonDependencies,
} from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  DUNGEON_REWARD_LIMITS as L,
  DungeonRewardGrantSchema,
  DungeonRewardBundleSchema,
  DungeonLootTableBodySchema,
  DungeonLootPoolSchema,
  DungeonLootPoolEntrySchema,
  DungeonTableDrawSchema,
  calculateDungeonLootTableWork,
  calculateDungeonRewardBundleWork,
  validateDungeonRewardBundleWork,
  validateDungeonRewardWork,
  type DungeonRewardBundle,
  type DungeonRewardGrant,
  type DungeonLootTableBody,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  buildDungeonPackage,
  dungeonContentHash,
  readDungeonPackage,
  serializeDungeonPackage,
} from '../../../src/modules/dungeons/package/dungeonPackage';
import { canonicalJson } from '../../../src/modules/rewardTables/rewardTableCore';
import { testDungeon } from '../../helpers/dungeonFixtures';

const item = (max = 1): Extract<DungeonRewardGrant, { type: 'item' }> => ({
  type: 'item',
  item: 'velvet_charm',
  quantity: { min: 1, max },
});
const gear: DungeonRewardGrant = {
  type: 'equipment',
  selector: { rarity: 'SR', slot: 'attack', definitionKeys: ['rusty_pipe'] },
};
const affection = (max = 1): DungeonRewardGrant => ({ type: 'affection', amount: { min: 1, max } });
const currency = (key: 'shards' | 'waifubux' | 'essence', max = 1): DungeonRewardGrant => ({
  type: 'currency',
  currency: key,
  amount: { min: 1, max },
});
const entries = (n: number, grant: DungeonRewardGrant = item()) =>
  Array.from({ length: n }, (_, i) => ({ id: `g-${i}`, grant }));
const chances = (n: number) =>
  entries(n).map((e, i) => ({ ...e, id: `c-${i}`, chanceBasisPoints: 5000 }));
const bundle = (over: Partial<DungeonRewardBundle> = {}): DungeonRewardBundle => ({
  guaranteed: [],
  chances: [],
  tables: [],
  ...over,
});
const body = (over: Partial<DungeonLootTableBody> = {}): DungeonLootTableBody => ({
  guaranteed: [],
  chances: [],
  pools: [],
  ...over,
});
const pool = (draws = 1) => ({
  id: 'pool',
  name: 'Rare gear',
  draws,
  entries: [
    { id: 'gear', weight: 1, grant: gear },
    { id: 'nothing', weight: 3, nothing: true as const },
  ],
});
const ref = (draws = 1) => ({ id: 'table', table: 'boss_hoard', draws });

describe('dungeon reward grant schemas', () => {
  it.each([
    currency('shards', L.atRiskCurrencyAmount),
    currency('waifubux', L.atRiskCurrencyAmount),
    currency('essence', L.essenceAmount),
    item(L.itemQuantity),
    gear,
    affection(L.affectionAmount),
  ])('accepts every grant type at its upper bound: %j', (grant) => {
    expect(DungeonRewardGrantSchema.parse(grant)).toEqual(grant);
  });

  it.each(['shards', 'waifubux', 'essence'] as const)(
    'accepts a positive fixed %s range',
    (key) => {
      expect(DungeonRewardGrantSchema.safeParse(currency(key)).success).toBe(true);
    },
  );
  it.each(['velvet_charm', 'bent_gear', 'salvage_scrap'])(
    'uses ordinary item slugs for %s',
    (slug) => {
      expect(DungeonRewardGrantSchema.safeParse({ ...item(), item: slug }).success).toBe(true);
    },
  );
  it.each([
    currency('shards', L.atRiskCurrencyAmount + 1),
    currency('waifubux', L.atRiskCurrencyAmount + 1),
    currency('essence', L.essenceAmount + 1),
    item(L.itemQuantity + 1),
    affection(L.affectionAmount + 1),
  ])('rejects grant bounds rather than truncating: %j', (grant) => {
    expect(DungeonRewardGrantSchema.safeParse(grant).success).toBe(false);
  });
  it.each([item(), affection(), currency('shards'), currency('waifubux'), currency('essence')])(
    'rejects bad ranges for %j',
    (grant) => {
      const field = grant.type === 'item' ? 'quantity' : 'amount';
      for (const range of [
        { min: 0, max: 1 },
        { min: -1, max: 1 },
        { min: 2, max: 1 },
        { min: 1.1, max: 2 },
        { min: 1, max: Infinity },
        { min: 1, max: NaN },
        { min: 1 },
      ]) {
        expect(DungeonRewardGrantSchema.safeParse({ ...grant, [field]: range }).success).toBe(
          false,
        );
      }
    },
  );
  it('validates Essence min as well as max', () => {
    expect(
      DungeonRewardGrantSchema.safeParse({
        type: 'currency',
        currency: 'essence',
        amount: { min: 100001, max: 100002 },
      }).success,
    ).toBe(false);
  });
  it.each([
    { type: 'charm', item: 'velvet_charm' },
    { type: 'salvage', item: 'bent_gear' },
    { type: 'ascension_token', amount: { min: 1, max: 1 } },
    currency('ascension_currency' as never),
    { ...item(), item: '' },
    { ...affection(), recipient: 'current_buddy' },
    { ...gear, quantity: { min: 1, max: 2 } },
    { type: 'equipment', selector: { rarities: ['epic'] } },
    { type: 'equipment', selector: { rarity: 'SSR' } },
    { type: 'equipment', selector: { definitionKeys: ['rusty_pipe', 'rusty_pipe'] } },
  ])('rejects unsupported or malformed grants: %j', (grant) => {
    expect(DungeonRewardGrantSchema.safeParse(grant).success).toBe(false);
  });
});

describe('bundles, pools and table bodies', () => {
  it('combines guaranteed grants, independent chances and multiple references', () => {
    const authored = bundle({
      guaranteed: entries(1),
      chances: chances(1),
      tables: [ref(), { ...ref(2), id: 'table-two' }],
    });
    expect(DungeonRewardBundleSchema.parse(authored)).toEqual(authored);
    const reversed = { ...authored, tables: [...authored.tables].reverse() };
    expect(DungeonRewardBundleSchema.parse(reversed).tables.map((t) => t.id)).toEqual([
      'table-two',
      'table',
    ]);
  });
  it.each([1, 9999])('accepts chance boundary %i', (chanceBasisPoints) => {
    expect(
      DungeonRewardBundleSchema.safeParse(
        bundle({ chances: [{ id: 'chance', chanceBasisPoints, grant: item() }] }),
      ).success,
    ).toBe(true);
  });
  it.each([0, 10000, -1, 1.5])('rejects chance %i', (chanceBasisPoints) => {
    expect(
      DungeonRewardBundleSchema.safeParse(
        bundle({ chances: [{ id: 'chance', chanceBasisPoints, grant: item() }] }),
      ).success,
    ).toBe(false);
  });
  it.each([1, 10])('accepts table draw boundary %i', (draws) => {
    expect(DungeonTableDrawSchema.safeParse(ref(draws)).success).toBe(true);
  });
  it.each([0, 11, 1.5])('rejects table draws %i', (draws) => {
    expect(DungeonTableDrawSchema.safeParse(ref(draws)).success).toBe(false);
  });
  it.each(['Bad-ID', '', 'x'.repeat(41), 'has space'])('rejects invalid stable ID %j', (id) => {
    expect(
      DungeonRewardBundleSchema.safeParse(bundle({ guaranteed: [{ id, grant: item() }] })).success,
    ).toBe(false);
  });
  it('accepts a 40-character stable ID and a 64-character table key', () => {
    expect(
      DungeonTableDrawSchema.safeParse({ id: 'x'.repeat(40), table: 'x'.repeat(64), draws: 1 })
        .success,
    ).toBe(true);
    for (const table of ['x'.repeat(65), 'bad-key', 'Uppercase', ''])
      expect(DungeonTableDrawSchema.safeParse({ ...ref(), table }).success).toBe(false);
  });
  it.each(['guaranteed', 'chances', 'tables'] as const)('enforces maximum %s entries', (field) => {
    const limit = { guaranteed: 12, chances: 12, tables: 4 }[field];
    const make = (n: number) =>
      field === 'guaranteed'
        ? entries(n)
        : field === 'chances'
          ? chances(n)
          : Array.from({ length: n }, (_, i) => ({ ...ref(), id: `table-${i}` }));
    expect(DungeonRewardBundleSchema.safeParse(bundle({ [field]: make(limit) })).success).toBe(
      true,
    );
    expect(DungeonRewardBundleSchema.safeParse(bundle({ [field]: make(limit + 1) })).success).toBe(
      false,
    );
  });
  it('requires all three lists with no implicit defaults', () => {
    expect(DungeonRewardBundleSchema.parse(bundle())).toEqual(bundle());
    for (const field of ['guaranteed', 'chances', 'tables']) {
      const invalid = { ...bundle() } as Record<string, unknown>;
      delete invalid[field];
      expect(DungeonRewardBundleSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('rejects duplicate bundle IDs within and across all three lists', () => {
    for (const invalid of [
      bundle({ guaranteed: [...entries(1), ...entries(1)] }),
      bundle({ chances: [...chances(1), ...chances(1)] }),
      bundle({ tables: [ref(), ref()] }),
      bundle({ guaranteed: entries(1), chances: [{ ...chances(1)[0]!, id: 'g-0' }] }),
      bundle({ guaranteed: entries(1), tables: [{ ...ref(), id: 'g-0' }] }),
      bundle({ chances: chances(1), tables: [{ ...ref(), id: 'c-0' }] }),
    ]) {
      expect(DungeonRewardBundleSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('supports weighted grants and explicit Nothing', () => {
    const authored = body({ guaranteed: entries(1), chances: chances(1), pools: [pool(2)] });
    expect(DungeonLootTableBodySchema.parse(authored)).toEqual(authored);
    expect(
      DungeonLootPoolEntrySchema.safeParse({ id: 'none', weight: 1, nothing: true }).success,
    ).toBe(true);
  });
  it.each([1, 1_000_000])('accepts weight boundary %i', (weight) => {
    expect(
      DungeonLootPoolEntrySchema.safeParse({ id: 'none', weight, nothing: true }).success,
    ).toBe(true);
  });
  it.each([0, -1, 1_000_001, 1.5])('rejects weight %i', (weight) => {
    expect(
      DungeonLootPoolEntrySchema.safeParse({ id: 'none', weight, nothing: true }).success,
    ).toBe(false);
  });
  it.each([
    { id: 'none', weight: 1 },
    { id: 'none', weight: 1, nothing: false },
    { id: 'both', weight: 1, nothing: true, grant: item() },
    { id: 'nested', weight: 1, table: 'other_table' },
  ])('rejects invalid pool alternatives: %j', (entry) => {
    expect(DungeonLootPoolEntrySchema.safeParse(entry).success).toBe(false);
  });
  it('does not accept nested tables, pool chance gates or without-replacement draws', () => {
    expect(DungeonLootTableBodySchema.safeParse({ ...body(), tables: [ref()] }).success).toBe(
      false,
    );
    for (const extra of [{ unique: true }, { replacement: false }, { chanceBasisPoints: 5000 }])
      expect(DungeonLootPoolSchema.safeParse({ ...pool(), ...extra }).success).toBe(false);
  });
  it.each(['guaranteed', 'chances', 'pools'] as const)(
    'enforces maximum table %s count',
    (field) => {
      const limit = { guaranteed: 12, chances: 20, pools: 6 }[field];
      const make = (n: number) =>
        field === 'guaranteed'
          ? entries(n)
          : field === 'chances'
            ? chances(n)
            : Array.from({ length: n }, (_, i) => ({ ...pool(), id: `pool-${i}` }));
      expect(DungeonLootTableBodySchema.safeParse(body({ [field]: make(limit) })).success).toBe(
        true,
      );
      expect(DungeonLootTableBodySchema.safeParse(body({ [field]: make(limit + 1) })).success).toBe(
        false,
      );
    },
  );
  it('enforces pool pick, entry and name bounds', () => {
    for (const draws of [1, 10])
      expect(DungeonLootPoolSchema.safeParse(pool(draws)).success).toBe(true);
    for (const draws of [0, 11, 1.5])
      expect(DungeonLootPoolSchema.safeParse(pool(draws)).success).toBe(false);
    for (const n of [1, 40])
      expect(
        DungeonLootPoolSchema.safeParse({
          ...pool(),
          entries: entries(n).map((e) => ({ ...e, weight: 1 })),
        }).success,
      ).toBe(true);
    for (const n of [0, 41])
      expect(
        DungeonLootPoolSchema.safeParse({
          ...pool(),
          entries: entries(n).map((e) => ({ ...e, weight: 1 })),
        }).success,
      ).toBe(false);
    for (const name of ['', ' '.repeat(2), 'x'.repeat(101)])
      expect(DungeonLootPoolSchema.safeParse({ ...pool(), name }).success).toBe(false);
    expect(DungeonLootPoolSchema.safeParse({ ...pool(), name: 'x'.repeat(100) }).success).toBe(
      true,
    );
  });
  it('rejects duplicate table-level and pool-entry IDs, while scoping entries to their pool', () => {
    for (const invalid of [
      body({ guaranteed: [...entries(1), ...entries(1)] }),
      body({ guaranteed: entries(1), chances: [{ ...chances(1)[0]!, id: 'g-0' }] }),
      body({ guaranteed: entries(1), pools: [{ ...pool(), id: 'g-0' }] }),
      body({ pools: [pool(), pool()] }),
      body({ pools: [{ ...pool(), entries: [pool().entries[0]!, pool().entries[0]!] }] }),
    ])
      expect(DungeonLootTableBodySchema.safeParse(invalid).success).toBe(false);
    expect(
      DungeonLootTableBodySchema.safeParse(body({ pools: [pool(), { ...pool(), id: 'second' }] }))
        .success,
    ).toBe(true);
  });
});

describe('pure worst-case work validation', () => {
  it('counts maximum ranges, all independent hits and repeated table/pool draws', () => {
    const table = body({
      guaranteed: [{ id: 'shards', grant: currency('shards', 100) }],
      chances: [{ id: 'bux', chanceBasisPoints: 1, grant: currency('waifubux', 300) }],
      pools: [
        {
          ...pool(2),
          entries: [
            ...pool().entries,
            { id: 'affection', weight: 1, grant: affection(25) },
            { id: 'essence', weight: 1, grant: currency('essence', 10) },
          ],
        },
      ],
    });
    const authored = bundle({
      guaranteed: [{ id: 'bond', grant: affection(10) }],
      chances: [{ id: 'bux', chanceBasisPoints: 1, grant: currency('waifubux', 20) }],
      tables: [ref(3)],
    });
    const result = validateDungeonRewardBundleWork(authored, new Map([['boss_hoard', table]]));
    expect(result).toMatchObject({
      ok: true,
      complete: true,
      work: {
        resolvedDraws: 14,
        equipmentInstances: 6,
        affection: 160,
        currencies: { shards: 300, waifubux: 920, essence: 60 },
      },
    });
  });
  it('takes the largest contribution per metric, never sums competing entries within a pick', () => {
    const table = body({
      pools: [
        {
          ...pool(2),
          entries: [
            { id: 'small', weight: 100, grant: currency('shards', 3) },
            { id: 'large', weight: 1, grant: currency('shards', 7) },
            { id: 'gear-a', weight: 1, grant: gear },
            { id: 'gear-b', weight: 1, grant: gear },
          ],
        },
      ],
    });
    expect(calculateDungeonLootTableWork(table)).toMatchObject({
      resolvedDraws: 2,
      equipmentInstances: 2,
      currencies: { shards: 14 },
    });
  });
  it('counts all-Nothing picks as work without awarding anything', () => {
    expect(
      calculateDungeonLootTableWork(
        body({ pools: [{ ...pool(10), entries: [{ id: 'nothing', weight: 1, nothing: true }] }] }),
      ),
    ).toEqual({
      resolvedDraws: 10,
      equipmentInstances: 0,
      affection: 0,
      currencies: { shards: 0, waifubux: 0, essence: 0 },
    });
  });
  it('preserves inputs and is independent of authoring order; repeated references each contribute', () => {
    const authored = bundle({
      guaranteed: entries(2),
      chances: chances(2),
      tables: [ref(2), { ...ref(3), id: 'second' }],
    });
    const table = body({ pools: [pool()] });
    const tables = new Map([['boss_hoard', table]]);
    const before = structuredClone({ authored, table });
    const first = calculateDungeonRewardBundleWork(authored, tables);
    const second = calculateDungeonRewardBundleWork(
      {
        guaranteed: [...authored.guaranteed].reverse(),
        chances: [...authored.chances].reverse(),
        tables: [...authored.tables].reverse(),
      },
      tables,
    );
    expect(first).toEqual(second);
    expect(first.work).toMatchObject({ equipmentInstances: 5, resolvedDraws: 9 });
    expect({ authored, table }).toEqual(before);
  });
  it('reports missing bodies as unresolved, preserving the known subtotal', () => {
    const authored = bundle({
      guaranteed: entries(1, gear),
      tables: [ref(10), { ...ref(), id: 'second' }],
    });
    expect(validateDungeonRewardBundleWork(authored)).toMatchObject({
      complete: false,
      ok: false,
      unresolvedTables: ['boss_hoard'],
      work: { equipmentInstances: 1 },
      issues: [{ code: 'reward_table_unresolved' }],
    });
    expect(
      validateDungeonRewardWork({ rooms: [{ actions: [{ type: 'boss', rewards: authored }] }] })
        .complete,
    ).toBe(false);
  });
  it('enforces the inline equipment and affection activity limits at parse time', () => {
    expect(
      DungeonRewardBundleSchema.safeParse(bundle({ guaranteed: entries(10, gear) })).success,
    ).toBe(true);
    expect(
      DungeonRewardBundleSchema.safeParse(bundle({ guaranteed: entries(11, gear) })).success,
    ).toBe(false);
    expect(
      DungeonRewardBundleSchema.safeParse(bundle({ guaranteed: entries(2, affection(500)) }))
        .success,
    ).toBe(true);
    expect(
      DungeonRewardBundleSchema.safeParse(
        bundle({
          guaranteed: entries(2, affection(500)),
          chances: [{ id: 'extra', chanceBasisPoints: 1, grant: affection() }],
        }),
      ).success,
    ).toBe(false);
  });
  it('enforces equipment activity limits through referenced bodies', () => {
    const tables = new Map([['boss_hoard', body({ pools: [pool()] })]]);
    expect(validateDungeonRewardBundleWork(bundle({ tables: [ref(10)] }), tables).ok).toBe(true);
    expect(
      validateDungeonRewardBundleWork(
        bundle({ guaranteed: entries(1, gear), tables: [ref(10)] }),
        tables,
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'reward_too_many_equipment' }));
  });
  it('enforces affection activity limits through referenced bodies', () => {
    const tables = new Map([['boss_hoard', body({ guaranteed: entries(1, affection(100)) })]]);
    expect(validateDungeonRewardBundleWork(bundle({ tables: [ref(10)] }), tables).ok).toBe(true);
    expect(
      validateDungeonRewardBundleWork(
        bundle({ guaranteed: entries(1, affection()), tables: [ref(10)] }),
        tables,
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'reward_affection_too_large' }));
  });
  it('accepts 200 resolved draws and rejects 201 without truncation', () => {
    const tables = new Map([['boss_hoard', body({ chances: chances(20) })]]);
    const exact = bundle({ tables: [ref(10)] });
    expect(validateDungeonRewardBundleWork(exact, tables)).toMatchObject({
      ok: true,
      work: { resolvedDraws: 200 },
    });
    const result = validateDungeonRewardBundleWork({ ...exact, guaranteed: entries(1) }, tables);
    expect(result.work.resolvedDraws).toBe(201);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'reward_too_many_draws' }),
    );
  });
  it('limits at-risk totals per dungeon and per currency, rather than their combined sum', () => {
    const tables = new Map([
      [
        'boss_hoard',
        body({
          guaranteed: [
            { id: 'shards', grant: currency('shards', 1_000_000) },
            { id: 'bux', grant: currency('waifubux', 1_000_000) },
          ],
        }),
      ],
    ]);
    const activity = {
      type: 'boss',
      rewards: bundle({
        tables: Array.from({ length: 4 }, (_, i) => ({ ...ref(10), id: `table-${i}` })),
      }),
    };
    const definition = { rooms: [{ actions: Array.from({ length: 50 }, () => activity) }] };
    expect(validateDungeonRewardWork(definition, tables)).toMatchObject({
      ok: true,
      work: { currencies: { shards: 2_000_000_000, waifubux: 2_000_000_000 } },
    });
    for (const key of ['shards', 'waifubux'] as const) {
      const extra = {
        type: 'combat',
        rewards: bundle({ guaranteed: [{ id: 'extra', grant: currency(key) }] }),
      };
      const result = validateDungeonRewardWork(
        { rooms: [{ actions: [...definition.rooms[0]!.actions, extra] }] },
        tables,
      );
      expect(result.issues).toEqual([
        {
          code: 'reward_currency_too_large',
          path: `currencies.${key}`,
          message: expect.any(String),
        },
      ]);
      expect(result.work.currencies[key]).toBe(2_000_000_001);
    }
  });
  it('includes legacy Shards in totals and scopes activity issues to their definition path', () => {
    const result = validateDungeonRewardWork(
      {
        rooms: [
          {
            actions: [
              { type: 'reward', reward: { currency: { max: 9 } } },
              { type: 'boss', rewards: bundle({ tables: [ref(10)] }) },
            ],
          },
        ],
      },
      new Map([['boss_hoard', body({ guaranteed: entries(2, gear) })]]),
    );
    expect(result.work.currencies.shards).toBe(9);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'reward_too_many_equipment',
        path: 'rooms[0].actions[1].rewards',
      }),
    );
  });
});

describe('activity integration and legacy package compatibility', () => {
  it.each(['combat', 'boss'] as const)('adds optional rewards to %s without a default', (type) => {
    const legacy = { id: 'fight', type, waves: [{ enemy: { key: 'grunt' } }] };
    expect(DungeonActionSchema.parse(legacy)).not.toHaveProperty('rewards');
    expect(DungeonActionSchema.parse({ ...legacy, rewards: bundle() })).toHaveProperty(
      'rewards',
      bundle(),
    );
  });
  it('allows exactly one treasure format, preserving legacy reward defaults', () => {
    expect(DungeonActionSchema.parse({ id: 'chest', type: 'reward', reward: {} })).toMatchObject({
      reward: { rewardTable: null, equipmentRewardTable: null, currency: { min: 0, max: 0 } },
    });
    expect(
      DungeonActionSchema.parse({ id: 'chest', type: 'reward', rewards: bundle() }),
    ).not.toHaveProperty('reward');
    for (const fields of [
      {},
      { reward: {}, rewards: bundle() },
      { reward: null },
      { rewards: null },
    ])
      expect(
        DungeonActionSchema.safeParse({ id: 'chest', type: 'reward', ...fields }).success,
      ).toBe(false);
  });
  it.each([
    { type: 'rest' },
    { type: 'gate', requires: { type: 'room_completed', roomId: 'gate' } },
    { type: 'set_flag', flag: 'open' },
    { type: 'leave' },
  ])('keeps unsupported activity types strict: %j', (action) => {
    expect(
      DungeonActionSchema.safeParse({ id: 'action', ...action, rewards: bundle() }).success,
    ).toBe(false);
  });
  it('preserves retention defaults and keeps abandonment optional, with valid basis-point bounds', () => {
    expect(DungeonSettingsSchema.parse({})).toEqual({
      progressionCurrency: null,
      defeatCurrencyRetentionBasisPoints: 0,
    });
    expect(
      DungeonSettingsSchema.parse({ defeatCurrencyRetentionBasisPoints: 5000 }),
    ).not.toHaveProperty('abandonCurrencyRetentionBasisPoints');
    for (const rate of [0, 10000])
      expect(
        DungeonSettingsSchema.parse({ abandonCurrencyRetentionBasisPoints: rate })
          .abandonCurrencyRetentionBasisPoints,
      ).toBe(rate);
    for (const rate of [-1, 10001, 0.5])
      expect(
        DungeonSettingsSchema.safeParse({ abandonCurrencyRetentionBasisPoints: rate }).success,
      ).toBe(false);
  });
  it('collects sorted direct Phase 2 dependencies and deduplicates equivalent selectors', () => {
    const definition = testDungeon(undefined, (d) => {
      d.rooms[0]!.actions = [
        {
          id: 'loot',
          type: 'reward',
          rewards: bundle({
            guaranteed: [
              { id: 'salvage', grant: { ...item(), item: 'bent_gear' } },
              { id: 'gear', grant: gear },
              { id: 'shards', grant: currency('shards') },
            ],
            chances: [{ id: 'charm', chanceBasisPoints: 5000, grant: item() }],
            tables: [ref()],
          }),
        },
        {
          id: 'fight',
          type: 'combat',
          waves: [{ enemy: { key: 'grunt' } }],
          rewards: bundle({
            guaranteed: [
              { id: 'gear', grant: gear },
              { id: 'essence', grant: currency('essence') },
              { id: 'bux', grant: currency('waifubux') },
            ],
            tables: [ref()],
          }),
        },
      ];
    });
    expect(dungeonDependencies(definition)).toMatchObject({
      lootTables: ['boss_hoard'],
      items: ['bent_gear', 'velvet_charm'],
      equipmentSelectors: [gear.type === 'equipment' ? gear.selector : {}],
      currencies: ['ascension_currency', 'essence', 'waifubux'],
      rewardTables: [],
    });
    const reordered = structuredClone(definition);
    reordered.rooms[0]!.actions.reverse();
    expect(dungeonDependencies(reordered)).toEqual(dungeonDependencies(definition));
    expect(validateDungeonRewardWork(definition).unresolvedTables).toEqual(['boss_hoard']);
  });
  it('parses legacy definitions without materializing any Phase 2 field', () => {
    const definition = DungeonDefinitionSchema.parse(testDungeon());
    expect(definition.settings).not.toHaveProperty('abandonCurrencyRetentionBasisPoints');
    for (const action of definition.rooms.flatMap((r) => r.actions))
      expect(action).not.toHaveProperty('rewards');
    expect(dungeonDependencies(definition)).toMatchObject({
      lootTables: [],
      items: [],
      equipmentSelectors: [],
    });
  });
  it('preserves the golden canonical definition, content hash and existing package v1 verification', () => {
    const text = fs.readFileSync(
      path.resolve(__dirname, '../../../content/dungeons/examples/service_tunnels.dungeon.json'),
      'utf8',
    );
    const raw = JSON.parse(text);
    const parsed = DungeonDefinitionSchema.parse(raw.dungeon);
    const goldenHash = 'sha256:1c6fa06bc5ef51e612f4ed334e67fe2411183a72b55e0832859286241d02d955';
    // At the pre-T1 baseline, the shipped dungeon is already fully parsed.
    expect(canonicalJson(parsed)).toBe(canonicalJson(raw.dungeon));
    expect(dungeonContentHash(parsed)).toBe(goldenHash);
    expect(raw.contentHash).toBe(goldenHash);
    expect(parsed.settings).not.toHaveProperty('abandonCurrencyRetentionBasisPoints');
    for (const action of parsed.rooms.flatMap((r) => r.actions))
      expect(action).not.toHaveProperty('rewards');
    const read = readDungeonPackage(text);
    expect(read).toMatchObject({
      ok: true,
      issues: [],
      package: { schemaVersion: 1, contentHash: goldenHash },
    });
    const reexported = buildDungeonPackage({
      definition: parsed,
      layout: read.package!.editor.layout,
      source: raw.source,
      enemies: new Map(read.package!.bundled.enemies.map((e) => [e.key, e])),
      packageId: raw.packageId,
      exportedAt: new Date(raw.exportedAt),
    });
    expect(reexported).toEqual(read.package);
    expect(readDungeonPackage(serializeDungeonPackage(reexported))).toMatchObject({
      ok: true,
      issues: [],
      package: reexported,
    });
  });
});
