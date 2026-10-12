import { describe, expect, it } from 'vitest';
import {
  DungeonDefinitionSchema,
  type DungeonDefinitionInput,
} from '../../../src/modules/dungeons/content/dungeonDefinition';
import {
  DungeonRewardBundleSchema,
  type DungeonRewardGrant,
  type DungeonLootTableBody,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  eligibleRewardDefinitions,
  equipmentSelectorKey,
} from '../../../src/modules/equipment/rewardSelector';
import {
  validateDungeonDefinition,
  type DungeonValidationContext,
} from '../../../src/modules/dungeons/validation/dungeonValidation';
import {
  validateDungeonLootTableBody,
  validateDungeonRewards,
} from '../../../src/modules/dungeons/validation/dungeonRewardValidation';
import { CURRENCY, TEST_ENEMIES, testDungeonInput } from '../../helpers/dungeonFixtures';
import legacy from './fixtures/legacyValidation.v1.json';

const item: DungeonRewardGrant = { type: 'item', item: 'charm', quantity: { min: 1, max: 2 } };
const gear: DungeonRewardGrant = { type: 'equipment', selector: { slot: 'attack', rarity: 'R' } };
const shards: DungeonRewardGrant = {
  type: 'currency',
  currency: 'shards',
  amount: { min: 1, max: 2 },
};
const definitions = [
  { key: 'eligible', name: 'Eligible gear', slot: 'attack', rarity: 'R', enabled: true },
  { key: 'disabled', name: 'Disabled gear', slot: 'attack', rarity: 'R', enabled: false },
  { key: 'wrong_slot', name: 'Other gear', slot: 'defense', rarity: 'R', enabled: true },
  { key: 'too_rare', name: 'Too rare', slot: 'attack', rarity: 'SSR', enabled: true },
];
const table = (grant: DungeonRewardGrant = item): DungeonLootTableBody => ({
  guaranteed: [{ id: 'gift', grant }],
  chances: [],
  pools: [],
});
const context = (over: Partial<DungeonValidationContext> = {}): DungeonValidationContext => ({
  enemies: new Map(TEST_ENEMIES.map((e) => [e.key, { enabled: true }])),
  rewardTables: new Map([['loot', { enabled: true }]]),
  regions: new Map([['waifu-valley', { enabled: true }]]),
  currencies: new Map([[CURRENCY, { enabled: true }]]),
  lootTables: new Map([['hoard', { name: 'Boss Hoard', archivedAt: null, body: table() }]]),
  items: new Map([
    ['charm', { name: 'Velvet Charm', category: 'charm', enabled: true, maxOwned: null }],
    ['salvage', { name: 'Bent Gear', category: 'salvage', enabled: true, maxOwned: null }],
  ]),
  resolveEquipmentSelector: (selector) => eligibleRewardDefinitions(selector, definitions),
  ...over,
});
function dungeon(
  grants: DungeonRewardGrant[] = [],
  refs: Array<{ id: string; table: string; draws: number }> = [],
) {
  const d = testDungeonInput();
  d.rooms[0]!.actions![0] = {
    id: 'battle',
    label: 'Boss fight',
    type: 'combat',
    waves: [{ enemy: { key: 'grunt' } }],
    rewards: {
      guaranteed: grants.map((grant, i) => ({ id: `gift_${i}`, grant })),
      chances: [],
      tables: refs,
    },
  };
  return d;
}
const rewards = (d: DungeonDefinitionInput, ctx = context()) =>
  validateDungeonDefinition(d, ctx).issues.filter((i) => i.code.startsWith('reward_'));
const ref = (draws = 1) => [{ id: 'table', table: 'hoard', draws }];

describe('T5 reward dependency and work validation', () => {
  it('accepts inline and transitive items, salvage, gear and configured shards without mutation', () => {
    const d = dungeon([item, gear, shards, { ...item, item: 'salvage' }], ref());
    const original = JSON.stringify(d);
    expect(rewards(d)).toEqual([]);
    const result = validateDungeonRewards(DungeonDefinitionSchema.parse(d), context());
    expect(result.equipmentPools[equipmentSelectorKey(gear.selector)]).toEqual([definitions[0]]);
    expect(JSON.stringify(d)).toBe(original);
  });
  it.each(['combat', 'boss', 'reward'] as const)('validates %s activity dependencies', (type) => {
    const d = dungeon([item]);
    const action = d.rooms[0]!.actions![0]!;
    d.rooms[0]!.actions![0] =
      type === 'reward'
        ? { id: action.id, type, rewards: 'rewards' in action ? action.rewards : undefined }
        : ({ ...action, type } as never);
    expect(rewards(d, context({ items: new Map() })).map((i) => i.code)).toContain(
      'reward_item_missing',
    );
  });
  it('keeps dungeon tables distinct from legacy expedition tables', () => {
    const issues = rewards(
      dungeon([], ref()),
      context({ lootTables: new Map(), rewardTables: new Map([['hoard', { enabled: true }]]) }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'reward_table_missing',
        severity: 'error',
        path: 'rooms[0].actions[0].rewards.tables[0]',
      }),
    );
    expect(issues[0]!.message).toContain('Boss fight');
  });
  it('reports archived and unreadable table bodies', () => {
    const ctx = context({
      lootTables: new Map([['hoard', { name: 'Boss Hoard', archivedAt: '2026-10-11', body: {} }]]),
    });
    expect(rewards(dungeon([], ref()), ctx).map((i) => i.code)).toEqual([
      'reward_table_archived',
      'reward_table_invalid',
    ]);
  });
  it.each([
    ['missing', 'reward_item_missing'],
    ['disabled', 'reward_item_disabled'],
    ['capped', 'reward_item_capped'],
  ] as const)('rejects %s inline and nested items', (state, code) => {
    const ctx = context({
      items:
        state === 'missing'
          ? new Map()
          : new Map([
              [
                'charm',
                {
                  name: 'Velvet Charm',
                  category: 'charm',
                  enabled: state !== 'disabled',
                  maxOwned: state === 'capped' ? 1 : null,
                },
              ],
            ]),
    });
    const issues = rewards(dungeon([item], ref()), ctx);
    expect(issues.filter((i) => i.code === code)).toHaveLength(2);
    expect(issues.every((i) => i.severity === 'error')).toBe(true);
    expect(issues[1]!.message).toContain('Boss Hoard');
    expect(issues[1]!.path).toContain('.body.guaranteed[0]');
  });
  it.each([
    { slot: 'health' },
    { definitionKeys: ['disabled'] },
    { definitionKeys: ['too_rare'] },
    { slot: 'attack', definitionKeys: ['wrong_slot'] },
    { definitionKeys: ['missing'] },
  ])('uses shared selector eligibility for %j', (selector) => {
    expect(
      rewards(dungeon([{ type: 'equipment', selector: selector as never }])).map((i) => i.code),
    ).toContain('reward_equipment_empty');
  });
  it('reports a nested empty selector and rejects a malformed selector shape', () => {
    expect(
      rewards(
        dungeon([], ref()),
        context({
          lootTables: new Map([
            [
              'hoard',
              {
                name: 'Hoard',
                archivedAt: null,
                body: table({ type: 'equipment', selector: { slot: 'health' } }),
              },
            ],
          ]),
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'reward_equipment_empty' }));
    expect(
      validateDungeonLootTableBody(
        table({ type: 'equipment', selector: { rarity: 'SSR' } as never }),
        context(),
      ).body,
    ).toBeNull();
  });
  it.each(['unset', 'missing', 'disabled'])(
    'rejects %s configured Shards currency for inline and table grants',
    (state) => {
      const d = dungeon([shards], ref());
      if (state === 'unset') d.settings = { ...d.settings, progressionCurrency: null };
      const ctx = context({
        currencies:
          state === 'missing'
            ? new Map()
            : new Map([[CURRENCY, { enabled: state !== 'disabled' }]]),
        lootTables: new Map([['hoard', { name: 'Hoard', archivedAt: null, body: table(shards) }]]),
      });
      expect(rewards(d, ctx).filter((i) => i.code === 'reward_shards_unset')).toHaveLength(2);
    },
  );
  it('counts repeated whole-table draws and every pool pick for equipment', () => {
    const ctx = context({
      lootTables: new Map([['hoard', { name: 'Hoard', archivedAt: null, body: table(gear) }]]),
    });
    expect(rewards(dungeon([], ref(10)), ctx)).toEqual([]);
    expect(rewards(dungeon([gear], ref(10)), ctx)).toContainEqual(
      expect.objectContaining({
        code: 'reward_too_much_gear',
        severity: 'error',
        message: expect.stringContaining('11 gear pieces'),
      }),
    );
  });
  it('checks direct T1 work refinements with approved friendly codes', () => {
    expect(rewards(dungeon(Array.from({ length: 11 }, () => gear))).map((i) => i.code)).toContain(
      'reward_too_much_gear',
    );
    expect(
      rewards(
        dungeon(
          Array.from({ length: 3 }, () => ({ type: 'affection', amount: { min: 500, max: 500 } })),
        ),
      ).map((i) => i.code),
    ).toContain('reward_affection_too_large');
  });
  it('catches total draws and repeated Affection using metric-wise pool maxima', () => {
    const many: DungeonLootTableBody = {
      guaranteed: [],
      chances: [],
      pools: Array.from({ length: 6 }, (_, i) => ({
        id: `pool_${i}`,
        name: `Pool ${i}`,
        draws: 10,
        entries: [
          {
            id: 'affection',
            weight: 1,
            grant: { type: 'affection', amount: { min: 1, max: 500 } },
          },
          { id: 'none', weight: 1, nothing: true },
        ],
      })),
    };
    const ctx = context({
      lootTables: new Map([['hoard', { name: 'Hoard', archivedAt: null, body: many }]]),
    });
    expect(rewards(dungeon([], ref(4)), ctx).map((i) => i.code)).toEqual(
      expect.arrayContaining(['reward_too_many_draws', 'reward_affection_too_large']),
    );
  });
  it.each(['shards', 'waifubux'] as const)(
    'enforces per-dungeon at-risk %s totals without truncation',
    (currency) => {
      const grant: DungeonRewardGrant = {
        type: 'currency',
        currency,
        amount: { min: 1000000, max: 1000000 },
      };
      const large: DungeonLootTableBody = {
        guaranteed: Array.from({ length: 12 }, (_, i) => ({ id: `g_${i}`, grant })),
        chances: Array.from({ length: 8 }, (_, i) => ({
          id: `c_${i}`,
          chanceBasisPoints: 9999,
          grant,
        })),
        pools: [],
      };
      const d = dungeon([], ref(10));
      for (let i = 1; i <= 10; i++)
        d.rooms[0]!.actions!.push({
          id: `cache_${i}`,
          type: 'reward',
          rewards: { guaranteed: [], chances: [], tables: ref(10) },
        });
      const ctx = context({
        lootTables: new Map([['hoard', { name: 'Hoard', archivedAt: null, body: large }]]),
      });
      expect(rewards(d, ctx)).toContainEqual(
        expect.objectContaining({
          code: 'reward_currency_too_large',
          severity: 'error',
          message: expect.stringContaining(currency === 'shards' ? '2200000024' : '2200000000'),
        }),
      );
    },
  );
  it('reports empty bundles and all-Nothing pools as warnings', () => {
    expect(rewards(dungeon())).toContainEqual(
      expect.objectContaining({ code: 'reward_empty', severity: 'warning' }),
    );
    const nothing = {
      guaranteed: [],
      chances: [],
      pools: [
        {
          id: 'gear',
          name: 'Boss gear',
          draws: 1,
          entries: [{ id: 'none', weight: 1, nothing: true }],
        },
      ],
    };
    expect(validateDungeonLootTableBody(nothing, context()).issues).toEqual([
      expect.objectContaining({
        code: 'reward_pool_all_nothing',
        severity: 'warning',
        message: expect.stringContaining('Boss gear'),
      }),
    ]);
  });
  it('warns when explicit abandon retention exceeds defeat, without changing defaults', () => {
    const d = testDungeonInput();
    expect(rewards(d)).toEqual([]);
    d.settings = { ...d.settings, abandonCurrencyRetentionBasisPoints: 3000 };
    expect(rewards(d)).toEqual([
      expect.objectContaining({ code: 'reward_abandon_more_than_defeat', severity: 'warning' }),
    ]);
  });
  it('returns the dedicated mixed-legacy code while T1 rejects the shape', () => {
    const d = dungeon();
    d.rooms[0]!.actions![0] = {
      id: 'mixed',
      type: 'reward',
      reward: { currency: { min: 0, max: 1 } },
      rewards: DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [] }),
    };
    expect(validateDungeonDefinition(d).issues).toContainEqual(
      expect.objectContaining({ code: 'reward_legacy_mixed', severity: 'error' }),
    );
  });
  it('preserves exact pre-T5 legacy issues across eight captured cases, including a populated v2 context', () => {
    for (const fixture of legacy) {
      const ctx = context();
      const definition = testDungeonInput();
      if (fixture.name === 'empty_reward')
        definition.rooms[0]!.actions![1] = {
          id: 'cache',
          type: 'reward',
          reward: { currency: { min: 0, max: 0 } },
        };
      if (fixture.name === 'unset_currency')
        definition.settings = { ...definition.settings, progressionCurrency: null };
      if (fixture.name === 'missing_tables') ctx.rewardTables = new Map();
      if (fixture.name === 'disabled_tables')
        ctx.rewardTables = new Map([['loot', { enabled: false }]]);
      if (fixture.name === 'missing_currency') ctx.currencies = new Map();
      if (fixture.name === 'disabled_currency')
        ctx.currencies = new Map([[CURRENCY, { enabled: false }]]);
      expect(
        validateDungeonDefinition(definition, fixture.name === 'no_context' ? undefined : ctx)
          .issues,
        fixture.name,
      ).toEqual(fixture.issues);
    }
  });
});
