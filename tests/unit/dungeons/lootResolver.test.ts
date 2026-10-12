import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DungeonRewardBundleSchema,
  DungeonLootTableBodySchema,
  DUNGEON_REWARD_LIMITS,
  type DungeonRewardBundle,
  type DungeonRewardGrant,
  type DungeonLootTableBody,
} from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  analyseRewardBundle,
  resolveRewardBundle,
  DungeonLootResolverError,
  type DungeonRewardResolverSnapshot,
  type DungeonRewardPlanV2,
  type DungeonAnalysedReward,
  type DungeonRewardAnalysis,
} from '../../../src/modules/dungeons/engine/lootResolver';
import { DUNGEON_SEED_SALT, dungeonRngSource } from '../../../src/modules/dungeons/engine/seeds';
import { equipmentSelectorKey } from '../../../src/modules/equipment/rewardSelector';
import type { EquipmentRewardCandidate } from '../../../src/modules/rewardTables/rewardTableCore';
import vectors from './fixtures/lootResolver.v1.json';

const PLACE = { roomId: 'boss_room', actionId: 'foreman' };
const SELECTOR = { slot: 'attack' as const, rarity: 'R' as const };
const CANDIDATES: EquipmentRewardCandidate[] = [
  { key: 'rusty_pipe', name: 'Rusty Pipe', slot: 'attack', rarity: 'R' },
  { key: 'steel_bat', name: 'Steel Bat', slot: 'attack', rarity: 'R' },
];
const item = (
  slug = 'velvet_charm',
  min = 1,
  max = min,
): Extract<DungeonRewardGrant, { type: 'item' }> => ({
  type: 'item',
  item: slug,
  quantity: { min, max },
});
const currency = (
  key: 'shards' | 'waifubux' | 'essence',
  min = 1,
  max = min,
): Extract<DungeonRewardGrant, { type: 'currency' }> => ({
  type: 'currency',
  currency: key,
  amount: { min, max },
});
const affection = (min = 1, max = min): Extract<DungeonRewardGrant, { type: 'affection' }> => ({
  type: 'affection',
  amount: { min, max },
});
const gear: Extract<DungeonRewardGrant, { type: 'equipment' }> = {
  type: 'equipment',
  selector: SELECTOR,
};
const bundle = (over: Partial<DungeonRewardBundle> = {}) =>
  DungeonRewardBundleSchema.parse({ guaranteed: [], chances: [], tables: [], ...over });
const body = (over: Partial<DungeonLootTableBody> = {}) =>
  DungeonLootTableBodySchema.parse({ guaranteed: [], chances: [], pools: [], ...over });
const snapshot = (
  tables: Record<string, DungeonLootTableBody> = {},
): DungeonRewardResolverSnapshot => ({
  hash: 't2-frozen-input-v1',
  tables: new Map(Object.entries(tables)),
  equipmentPools: { [equipmentSelectorKey(SELECTOR)]: CANDIDATES },
});
const tableRef = (id = 'hoard', draws = 1) => ({ id, table: 'boss_hoard', draws });
const pool = (draws = 1) => ({
  id: 'gear_pool',
  name: 'Gear or Nothing',
  draws,
  entries: [
    { id: 'gear', weight: 1, grant: gear },
    { id: 'nothing', weight: 3, nothing: true as const },
  ],
});
const resolve = (b: DungeonRewardBundle, s = snapshot(), seed = 42) =>
  resolveRewardBundle(b, s, seed, PLACE);
const analyse = (b: DungeonRewardBundle, s = snapshot()) => analyseRewardBundle(b, s);
const odds = (a: DungeonRewardAnalysis, reward: DungeonAnalysedReward) =>
  a.rewards.find((e) => JSON.stringify(e.reward) === JSON.stringify(reward))!;
const lines = (plan: DungeonRewardPlanV2, ids: readonly string[]) =>
  plan.lines.filter((line) => ids.includes(line.dropId));

describe('loot resolver mechanics and complete receipts', () => {
  it('resolves every grant into the correct risk aggregate and detailed lines', () => {
    const b = bundle({
      guaranteed: [
        { id: 'shards', grant: currency('shards', 45) },
        { id: 'bux', grant: currency('waifubux', 501) },
        { id: 'essence', grant: currency('essence', 7) },
        { id: 'bond', grant: affection(3) },
        { id: 'charm', grant: item('velvet_charm', 2) },
        { id: 'salvage', grant: item('bent_gear', 4) },
        { id: 'gear', grant: gear },
      ],
    });
    const result = resolve(b);
    expect(result).toMatchObject({
      v: 2,
      resolverVersion: 1,
      snapshotHash: 't2-frozen-input-v1',
      atRisk: { shards: 45, waifubux: 501 },
      secured: {
        essence: 7,
        affection: 3,
        items: [
          { item: 'bent_gear', quantity: 4 },
          { item: 'velvet_charm', quantity: 2 },
        ],
        equipment: [
          { dropId: 'g:gear', definitionKey: expect.any(String), rollSeed: expect.any(Number) },
        ],
      },
    });
    expect(result.lines).toHaveLength(7);
    for (const line of result.lines)
      expect(line).toMatchObject({
        source: 'guaranteed',
        mode: 'guaranteed',
        hit: true,
        grant: { type: expect.any(String) },
      });
    expect(result.lines.find((l) => l.dropId === 'g:bond')).toMatchObject({
      entryId: 'bond',
      rolls: { quantity: { min: 3, max: 3, value: 3 } },
      grant: { type: 'affection', amount: 3 },
    });
  });
  it('uses inclusive quantity ranges, including both endpoints', () => {
    const b = bundle({ guaranteed: [{ id: 'range', grant: item('charm', 1, 3) }] });
    const values = new Set(
      Array.from(
        { length: 100 },
        (_, seed) => resolve(b, snapshot(), seed).secured.items[0]!.quantity,
      ),
    );
    expect([...values].sort()).toEqual([1, 2, 3]);
  });
  it('rolls chance entries independently and records both hits and misses', () => {
    const b = bundle({
      chances: ['one', 'two'].map((id) => ({ id, chanceBasisPoints: 5000, grant: item() })),
    });
    const outcomes = new Set(
      Array.from({ length: 100 }, (_, seed) =>
        resolve(b, snapshot(), seed)
          .lines.map((l) => Number(l.hit))
          .join(''),
      ),
    );
    expect([...outcomes].sort()).toEqual(['00', '01', '10', '11']);
    const sample = resolve(b);
    for (const line of sample.lines) {
      expect(line.rolls.chance?.value).toBeGreaterThanOrEqual(0);
      expect(line.rolls.chance?.value).toBeLessThan(10000);
      expect(line.hit).toBe(line.rolls.chance!.value < 5000);
      if (!line.hit) {
        expect(line.missReason).toBe('chance_missed');
        expect(line).not.toHaveProperty('grant');
        expect(line.rolls).not.toHaveProperty('quantity');
      }
    }
  });
  it('draws weighted pools with replacement, retaining Nothing and selected-entry records', () => {
    const b = bundle({ tables: [tableRef()] });
    const s = snapshot({ boss_hoard: body({ pools: [pool(3)] }) });
    let repeatedGear = false;
    let nothing = false;
    for (let seed = 0; seed < 100; seed++) {
      const result = resolve(b, s, seed);
      expect(result.lines.map((l) => l.dropId)).toEqual([
        't:hoard:0:p:gear_pool:0',
        't:hoard:0:p:gear_pool:1',
        't:hoard:0:p:gear_pool:2',
      ]);
      repeatedGear ||= result.secured.equipment.length >= 2;
      for (const line of result.lines) {
        expect(line).toMatchObject({
          source: 'table',
          mode: 'pool',
          tableKey: 'boss_hoard',
          tableReferenceId: 'hoard',
          tableDraw: 0,
          poolId: 'gear_pool',
          poolName: 'Gear or Nothing',
          rolls: { pool: { totalWeight: 4, value: expect.any(Number) } },
        });
        if (!line.hit) {
          nothing = true;
          expect(line).toMatchObject({
            entryId: 'nothing',
            missReason: 'nothing',
            rolls: { pool: { weight: 3 } },
          });
          expect(line).not.toHaveProperty('grant');
        }
      }
    }
    expect(repeatedGear).toBe(true);
    expect(nothing).toBe(true);
  });
  it('pays table guarantees on every draw and repeats every chance and pool', () => {
    const b = bundle({ tables: [tableRef('one', 2), tableRef('two', 3)] });
    const s = snapshot({
      boss_hoard: body({
        guaranteed: [{ id: 'fixed', grant: item('bent_gear', 2) }],
        chances: [{ id: 'maybe', chanceBasisPoints: 5000, grant: affection() }],
        pools: [pool()],
      }),
    });
    const result = resolve(b, s);
    expect(result.lines).toHaveLength(15);
    expect(result.secured.items).toEqual([{ item: 'bent_gear', quantity: 10 }]);
    expect(result.lines.filter((l) => l.mode === 'guaranteed')).toHaveLength(5);
    expect(result.lines.filter((l) => l.mode === 'chance')).toHaveLength(5);
    expect(result.lines.filter((l) => l.mode === 'pool')).toHaveLength(5);
    expect(new Set(result.lines.map((l) => l.dropId)).size).toBe(15);
  });
  it('merges item quantities across sources while preserving each drop identity', () => {
    const b = bundle({
      guaranteed: [
        { id: 'a', grant: item('charm', 2) },
        { id: 'b', grant: item('charm', 3) },
      ],
      tables: [tableRef('one', 2)],
    });
    const result = resolve(
      b,
      snapshot({ boss_hoard: body({ guaranteed: [{ id: 'a', grant: item('charm', 4) }] }) }),
    );
    expect(result.secured.items).toEqual([{ item: 'charm', quantity: 13 }]);
    expect(result.lines.map((l) => l.dropId)).toEqual(['g:a', 'g:b', 't:one:0:g:a', 't:one:1:g:a']);
  });
  it('returns empty aggregates for an empty bundle, all misses and all Nothing', () => {
    const empty = {
      atRisk: { shards: 0, waifubux: 0 },
      secured: { essence: 0, affection: 0, items: [], equipment: [] },
    };
    expect(resolve(bundle())).toMatchObject({ ...empty, lines: [] });
    const b = bundle({
      chances: [{ id: 'rare', chanceBasisPoints: 1, grant: item() }],
      tables: [tableRef()],
    });
    const s = snapshot({
      boss_hoard: body({
        pools: [{ ...pool(2), entries: [{ id: 'none', weight: 1, nothing: true }] }],
      }),
    });
    const result = resolve(b, s);
    expect(result).toMatchObject(empty);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((l) => !l.hit && !l.grant)).toBe(true);
    expect(analyse(bundle()).noRewardChance).toBe(1);
    expect(analyse(bundle({ tables: [tableRef()] }), s).noRewardChance).toBe(1);
  });
});

describe('deterministic streams and stable identities', () => {
  const b = bundle({
    guaranteed: [
      { id: 'fixed', grant: currency('shards', 1, 100) },
      { id: 'gear', grant: gear },
    ],
    chances: [{ id: 'maybe', chanceBasisPoints: 5000, grant: item('charm', 1, 10) }],
    tables: [tableRef('one', 2), tableRef('two', 2)],
  });
  const s = snapshot({
    boss_hoard: body({
      guaranteed: [
        { id: 'currency', grant: currency('waifubux', 1, 100) },
        { id: 'shards', grant: currency('shards', 1, 100) },
      ],
      chances: [
        { id: 'chance', chanceBasisPoints: 5000, grant: affection() },
        { id: 'charm', chanceBasisPoints: 7500, grant: item() },
      ],
      pools: [
        pool(),
        {
          id: 'item_pool',
          name: 'Items',
          draws: 1,
          entries: [
            { id: 'item', weight: 1, grant: item() },
            { id: 'none', weight: 1, nothing: true },
          ],
        },
      ],
    }),
  });
  it('returns identical plans and analysis for the same inputs without using global RNG', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('global RNG forbidden');
    });
    try {
      expect(resolve(b, s)).toEqual(resolve(b, s));
      expect(analyse(b, s)).toEqual(analyse(b, s));
    } finally {
      random.mockRestore();
    }
  });
  it('preserves the complete plan when bundles, table lists, weighted rows and candidates reorder', () => {
    const reversedBody = structuredClone(s.tables.get('boss_hoard')!);
    reversedBody.guaranteed.reverse();
    reversedBody.chances.reverse();
    reversedBody.pools.reverse();
    for (const p of reversedBody.pools) p.entries.reverse();
    const reversedBundle = {
      guaranteed: [...b.guaranteed].reverse(),
      chances: [...b.chances].reverse(),
      tables: [...b.tables].reverse(),
    };
    const reversedSnapshot = {
      ...s,
      tables: new Map([['boss_hoard', reversedBody]]),
      equipmentPools: { [equipmentSelectorKey(SELECTOR)]: [...CANDIDATES].reverse() },
    };
    expect(resolve(reversedBundle, reversedSnapshot)).toEqual(resolve(b, s));
    expect(analyse(reversedBundle, reversedSnapshot)).toEqual(analyse(b, s));
  });
  it('adding unrelated guarantees, chances, references and table entries leaves existing drops untouched', () => {
    const first = resolve(b, s);
    const expanded = bundle({
      ...b,
      guaranteed: [...b.guaranteed, { id: 'extra', grant: item('salvage') }],
      chances: [
        ...b.chances,
        { id: 'extra-chance', chanceBasisPoints: 9999, grant: currency('essence') },
      ],
      tables: [tableRef('one', 3), tableRef('two', 2), tableRef('third')],
    });
    const expandedBody = body({
      ...s.tables.get('boss_hoard')!,
      guaranteed: [
        { id: 'extra', grant: currency('shards') },
        ...s.tables.get('boss_hoard')!.guaranteed,
      ],
      chances: [
        ...s.tables.get('boss_hoard')!.chances,
        { id: 'extra-chance', chanceBasisPoints: 1, grant: item('scrap') },
      ],
      pools: [
        ...s.tables.get('boss_hoard')!.pools,
        {
          id: 'extra-pool',
          name: 'Extra pool',
          draws: 1,
          entries: [{ id: 'scrap', weight: 1, grant: item('scrap') }],
        },
      ],
    });
    const expandedSnapshot = { ...s, tables: new Map([['boss_hoard', expandedBody]]) };
    expect(
      lines(
        resolve(expanded, expandedSnapshot),
        first.lines.map((l) => l.dropId),
      ),
    ).toEqual(first.lines);
  });
  it('misses never consume another entry’s random values', () => {
    const changing = bundle({
      guaranteed: [{ id: 'quantity', grant: item('scrap', 1, 999) }],
      chances: [{ id: 'maybe', chanceBasisPoints: 1, grant: item('charm', 1, 999) }],
    });
    const changed = {
      ...changing,
      chances: [{ ...changing.chances[0]!, chanceBasisPoints: 9999 }],
    };
    expect(lines(resolve(changing), ['g:quantity'])).toEqual(
      lines(resolve(changed), ['g:quantity']),
    );
  });
  it('keys references by their stable reference ID, not table key, and separates draws', () => {
    const result = resolve(b, s);
    const samples = [
      't:one:0:g:currency',
      't:one:1:g:currency',
      't:two:0:g:currency',
      't:two:1:g:currency',
    ];
    const quantities = lines(result, samples).map((l) => l.rolls.quantity!.value);
    expect(new Set(quantities).size).toBeGreaterThan(1);
    const sameBodyDifferentKey = {
      ...s,
      tables: new Map([['renamed_table', s.tables.get('boss_hoard')!]]),
    };
    const renamed = resolve(
      { ...b, tables: b.tables.map((t) => ({ ...t, table: 'renamed_table' })) },
      sameBodyDifferentKey,
    );
    expect(renamed.lines.map(({ tableKey, ...line }) => line)).toEqual(
      result.lines.map(({ tableKey, ...line }) => line),
    );
  });
  it('follows the exact 5.3 hit/pick then quantity or candidate sequence and 8.2 roll seed', () => {
    const result = resolve(b, s);
    const rngSource = dungeonRngSource(42);
    for (const line of result.lines) {
      const rng = rngSource.stream('loot', PLACE.roomId, PLACE.actionId, ...line.dropId.split(':'));
      if (line.rolls.chance) expect(line.rolls.chance.value).toBe(rng.intInclusive(0, 9999));
      if (line.rolls.pool) expect(line.rolls.pool.value).toBe(rng.next());
      if (line.rolls.quantity)
        expect(line.rolls.quantity.value).toBe(
          rng.intInclusive(line.rolls.quantity.min, line.rolls.quantity.max),
        );
      if (line.rolls.equipment) {
        const index = rng.intInclusive(0, CANDIDATES.length - 1);
        expect(line.rolls.equipment.index).toBe(index);
        expect(line.grant).toEqual({
          type: 'equipment',
          definitionKey: [...CANDIDATES].sort((a, b) => (a.key < b.key ? -1 : 1))[index]!.key,
          rollSeed: rngSource.seedOf('loot', PLACE.roomId, PLACE.actionId, 'gear', line.dropId),
        });
      }
    }
    // Pin the existing salt independently of the new resolver.
    expect(DUNGEON_SEED_SALT).toBe('waifumon.dungeon.engine.v1');
    const digest = createHash('md5')
      .update(`42:combat:boss_room:foreman:0:${DUNGEON_SEED_SALT}`)
      .digest('hex');
    expect(rngSource.seedOf('combat', PLACE.roomId, PLACE.actionId, 0)).toBe(
      Number.parseInt(digest.slice(0, 8), 16),
    );
  });
  it('changes streams with seed or activity identity while equipment retries remain identical', () => {
    const first = resolve(b, s);
    expect(resolve(b, s)).toEqual(first);
    expect(resolve(b, s, 43)).not.toEqual(first);
    expect(resolveRewardBundle(b, s, 42, { ...PLACE, actionId: 'different' })).not.toEqual(first);
    expect(resolveRewardBundle(b, s, 42, { ...PLACE, roomId: 'different' })).not.toEqual(first);
    expect(
      first.secured.equipment.every(
        (e) => Number.isInteger(e.rollSeed) && e.rollSeed >= 0 && e.rollSeed <= 0xffff_ffff,
      ),
    ).toBe(true);
  });
  it('does not mutate frozen authored content, table bodies or candidate lists', () => {
    const localBundle = structuredClone(b);
    const localSnapshot = snapshot({ boss_hoard: structuredClone(s.tables.get('boss_hoard')!) });
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(localBundle);
    freeze(localSnapshot.tables.get('boss_hoard'));
    freeze(CANDIDATES);
    freeze(localSnapshot.equipmentPools);
    const before = JSON.stringify({
      localBundle,
      table: localSnapshot.tables.get('boss_hoard'),
      candidates: CANDIDATES,
    });
    resolve(localBundle, localSnapshot);
    analyse(localBundle, localSnapshot);
    expect(
      JSON.stringify({
        localBundle,
        table: localSnapshot.tables.get('boss_hoard'),
        candidates: CANDIDATES,
      }),
    ).toBe(before);
  });
});

describe('resolver v1 fixed vectors', () => {
  it.each(vectors.vectors)('pins the full plan for seed $seed', ({ seed, plan }) => {
    const input = vectors.input;
    const s: DungeonRewardResolverSnapshot = {
      hash: input.snapshot.hash,
      tables: new Map(
        Object.entries(input.snapshot.tables).map(([key, value]) => [
          key,
          DungeonLootTableBodySchema.parse(value),
        ]),
      ),
      equipmentPools: input.snapshot
        .equipmentPools as DungeonRewardResolverSnapshot['equipmentPools'],
    };
    const actual = resolveRewardBundle(
      DungeonRewardBundleSchema.parse(input.bundle),
      s,
      seed,
      input.activity,
    );
    expect(actual).toEqual(plan);
    expect(actual.resolverVersion).toBe(vectors.resolverVersion);
  });
});

describe('analytical results versus 10,000 fixed seeds per configuration', () => {
  const guaranteed = bundle({
    guaranteed: [
      { id: 'charm', grant: item('charm', 1, 3) },
      { id: 'shards', grant: currency('shards', 2, 6) },
      { id: 'gear', grant: gear },
      { id: 'essence', grant: currency('essence', 2) },
      { id: 'affection', grant: affection() },
    ],
  });
  const chance = bundle({
    chances: [
      { id: 'charm', chanceBasisPoints: 2500, grant: item('charm', 1, 3) },
      { id: 'shards', chanceBasisPoints: 7500, grant: currency('shards', 2, 4) },
      { id: 'gear', chanceBasisPoints: 3000, grant: gear },
      { id: 'essence', chanceBasisPoints: 1500, grant: currency('essence', 2) },
      { id: 'affection', chanceBasisPoints: 2000, grant: affection(1, 3) },
    ],
  });
  const repeated = bundle({ tables: [tableRef('one', 2), tableRef('two', 1)] });
  const repeatedSnapshot = snapshot({
    boss_hoard: body({
      chances: [{ id: 'charm', chanceBasisPoints: 3000, grant: item('charm', 1, 2) }],
      pools: [
        {
          id: 'pool',
          name: 'Mixed',
          draws: 2,
          entries: [
            { id: 'charm-range', weight: 2, grant: item('charm', 1, 3) },
            { id: 'charm-fixed', weight: 1, grant: item('charm') },
            { id: 'gear', weight: 1, grant: gear },
            { id: 'nothing', weight: 6, nothing: true },
          ],
        },
      ],
    }),
  });
  const configurations = [
    {
      name: 'guaranteed ranges and uniform equipment',
      bundle: guaranteed,
      snapshot: snapshot(),
      variances: {
        charm: 2 / 3,
        shards: 2,
        rusty_pipe: 0.25,
        steel_bat: 0.25,
        essence: 0,
        affection: 0,
      },
      equipmentVariance: 0,
    },
    {
      name: 'independent chance hits and ranges',
      bundle: chance,
      snapshot: snapshot(),
      variances: {
        charm: 0.25 * (14 / 3) - 0.5 ** 2,
        shards: 0.75 * (29 / 3) - 2.25 ** 2,
        rusty_pipe: 0.15 * 0.85,
        steel_bat: 0.15 * 0.85,
        essence: 0.15 * 4 - 0.3 ** 2,
        affection: 0.2 * (14 / 3) - 0.4 ** 2,
      },
      equipmentVariance: 0.3 * 0.7,
    },
    {
      name: 'repeated table draws and mixed weighted pools',
      bundle: repeated,
      snapshot: repeatedSnapshot,
      variances: {
        charm: 3 * (0.3 * 2.5 - 0.45 ** 2) + 6 * (0.2 * (14 / 3) + 0.1 - 0.5 ** 2),
        rusty_pipe: 6 * 0.05 * 0.95,
        steel_bat: 6 * 0.05 * 0.95,
      },
      equipmentVariance: 6 * 0.1 * 0.9,
    },
  ];
  const rewardName = (reward: DungeonAnalysedReward) =>
    reward.type === 'item'
      ? reward.item
      : reward.type === 'currency'
        ? reward.currency
        : reward.type === 'equipment'
          ? reward.definitionKey
          : 'affection';
  const quantity = (plan: DungeonRewardPlanV2, reward: DungeonAnalysedReward) => {
    if (reward.type === 'item')
      return plan.secured.items.find((i) => i.item === reward.item)?.quantity ?? 0;
    if (reward.type === 'equipment')
      return plan.secured.equipment.filter((e) => e.definitionKey === reward.definitionKey).length;
    if (reward.type === 'affection') return plan.secured.affection;
    return reward.currency === 'essence' ? plan.secured.essence : plan.atRisk[reward.currency];
  };
  it.each(configurations)('$name', (configuration) => {
    const count = 10_000;
    const a = analyse(configuration.bundle, configuration.snapshot);
    const samples = a.rewards.map((entry) => ({ entry, sum: 0, hits: 0 }));
    let nothing = 0;
    let equipmentSum = 0;
    let equipmentHits = 0;
    let bothCharmAndShards = 0;
    for (let seed = 0; seed < count; seed++) {
      const plan = resolve(configuration.bundle, configuration.snapshot, seed);
      if (plan.lines.every((l) => !l.hit)) nothing++;
      equipmentSum += plan.secured.equipment.length;
      if (plan.secured.equipment.length) equipmentHits++;
      if (plan.secured.items.some((i) => i.item === 'charm') && plan.atRisk.shards > 0)
        bothCharmAndShards++;
      for (const sample of samples) {
        const value = quantity(plan, sample.entry.reward);
        sample.sum += value;
        if (value > 0) sample.hits++;
      }
    }
    // Six standard errors allow a reproducible distribution check across many comparisons.
    // Bernoulli variance is p(1-p); quantity variances above use E[X²] - E[X]²,
    // with uniform integer second moments and independent slot variances summed.
    const frequencyTolerance = (p: number) => 6 * Math.sqrt((p * (1 - p)) / count) + 1 / count;
    for (const sample of samples) {
      const key = rewardName(sample.entry.reward);
      const variance = (configuration.variances as Record<string, number>)[key]!;
      expect(
        Math.abs(sample.sum / count - sample.entry.expectedQuantity),
        `${key} expected quantity`,
      ).toBeLessThanOrEqual(6 * Math.sqrt(variance / count) + 1 / count);
      expect(
        Math.abs(sample.hits / count - sample.entry.chanceAtLeastOnce),
        `${key} at-least-one probability`,
      ).toBeLessThanOrEqual(frequencyTolerance(sample.entry.chanceAtLeastOnce));
    }
    expect(Math.abs(nothing / count - a.noRewardChance)).toBeLessThanOrEqual(
      frequencyTolerance(a.noRewardChance),
    );
    expect(Math.abs(equipmentHits / count - a.chanceAnyEquipment)).toBeLessThanOrEqual(
      frequencyTolerance(a.chanceAnyEquipment),
    );
    expect(Math.abs(equipmentSum / count - a.expectedEquipmentPieces)).toBeLessThanOrEqual(
      6 * Math.sqrt(configuration.equipmentVariance / count) + 1 / count,
    );
    if (configuration.bundle === chance)
      expect(Math.abs(bothCharmAndShards / count - 0.25 * 0.75)).toBeLessThanOrEqual(
        frequencyTolerance(0.25 * 0.75),
      );
    console.info(
      JSON.stringify({
        configuration: configuration.name,
        seeds: count,
        noReward: { expected: a.noRewardChance, observed: nothing / count },
        equipmentPieces: { expected: a.expectedEquipmentPieces, observed: equipmentSum / count },
        maxRewardFrequencyError: Math.max(
          ...samples.map((s) => Math.abs(s.hits / count - s.entry.chanceAtLeastOnce)),
        ),
      }),
    );
  });
});

describe('exact analytical probabilities', () => {
  it('reports expectations for every reward, base bonuses, and equipment candidate probabilities', () => {
    const b = bundle({
      guaranteed: [
        { id: 'shards', grant: currency('shards', 2, 6) },
        { id: 'bux', grant: currency('waifubux', 5, 9) },
        { id: 'essence', grant: currency('essence', 3, 7) },
        { id: 'charm', grant: item('charm', 1, 3) },
        { id: 'affection', grant: affection(1, 3) },
        { id: 'gear', grant: gear },
      ],
    });
    const a = analyse(b);
    for (const [reward, expected] of [
      [{ type: 'currency', currency: 'shards' }, 4],
      [{ type: 'currency', currency: 'waifubux' }, 7],
      [{ type: 'currency', currency: 'essence' }, 5],
      [{ type: 'item', item: 'charm' }, 2],
      [{ type: 'affection' }, 2],
    ] as const) {
      expect(odds(a, reward)).toMatchObject({ expectedQuantity: expected, chanceAtLeastOnce: 1 });
    }
    expect(odds(a, { type: 'currency', currency: 'shards' }).riskClass).toBe('at_risk');
    expect(odds(a, { type: 'currency', currency: 'essence' }).riskClass).toBe('secured');
    for (const candidate of CANDIDATES)
      expect(odds(a, { type: 'equipment', definitionKey: candidate.key })).toMatchObject({
        expectedQuantity: 0.5,
        chanceAtLeastOnce: 0.5,
      });
    expect(a).toMatchObject({
      expectedEquipmentPieces: 1,
      chanceAnyEquipment: 1,
      equipmentCandidateCount: 2,
      noRewardChance: 0,
    });
  });
  it('combines independent drops of the same item by adding averages and multiplying misses', () => {
    const b = bundle({
      chances: [
        { id: 'one', chanceBasisPoints: 2500, grant: item('charm', 1, 3) },
        { id: 'two', chanceBasisPoints: 5000, grant: item('charm', 2) },
      ],
    });
    const a = analyse(b);
    expect(odds(a, { type: 'item', item: 'charm' })).toMatchObject({
      expectedQuantity: 1.5,
      chanceAtLeastOnce: 0.625,
      contributions: [
        { dropId: 'c:one', probability: 0.25, expectedQuantity: 0.5 },
        { dropId: 'c:two', probability: 0.5, expectedQuantity: 1 },
      ],
    });
    expect(a.noRewardChance).toBeCloseTo(0.375, 15);
  });
  it('sums same-item weighted alternatives before multiplying independent pick misses', () => {
    const table = body({
      pools: [
        {
          id: 'choices',
          name: 'Choices',
          draws: 2,
          entries: [
            { id: 'one', weight: 1, grant: item('charm', 1) },
            { id: 'two', weight: 2, grant: item('charm', 2) },
            { id: 'none', weight: 1, nothing: true },
          ],
        },
      ],
    });
    const a = analyse(
      bundle({ tables: [tableRef('one', 2), tableRef('two')] }),
      snapshot({ boss_hoard: table }),
    );
    // Three table draws × two pool picks. Each pick gives this item with probability 3/4, average 5/4.
    expect(odds(a, { type: 'item', item: 'charm' }).expectedQuantity).toBe(7.5);
    expect(odds(a, { type: 'item', item: 'charm' }).chanceAtLeastOnce).toBeCloseTo(
      1 - 0.25 ** 6,
      15,
    );
    expect(a.noRewardChance).toBeCloseTo(0.25 ** 6, 15);
    expect(a.sources).toHaveLength(6);
    expect(a.sources[0]!.rewards).toEqual([
      { reward: { type: 'item', item: 'charm' }, probability: 0.75, expectedQuantity: 1.25 },
    ]);
  });
  it('combines overlapping equipment selector alternatives according to candidate probabilities', () => {
    const onlyPipe = { ...SELECTOR, definitionKeys: ['rusty_pipe'] };
    const table = body({
      pools: [
        {
          ...pool(2),
          entries: [
            { id: 'either', weight: 1, grant: gear },
            { id: 'pipe', weight: 1, grant: { type: 'equipment', selector: onlyPipe } },
            { id: 'none', weight: 2, nothing: true },
          ],
        },
      ],
    });
    const s = snapshot({ boss_hoard: table });
    s.equipmentPools = { ...s.equipmentPools, [equipmentSelectorKey(onlyPipe)]: [CANDIDATES[0]!] };
    const a = analyse(bundle({ tables: [tableRef()] }), s);
    expect(a.expectedEquipmentPieces).toBe(1);
    expect(a.chanceAnyEquipment).toBe(0.75);
    expect(a.equipmentCandidateCount).toBe(2);
    expect(odds(a, { type: 'equipment', definitionKey: 'rusty_pipe' }).expectedQuantity).toBe(0.75);
    expect(
      odds(a, { type: 'equipment', definitionKey: 'rusty_pipe' }).chanceAtLeastOnce,
    ).toBeCloseTo(1 - 0.625 ** 2, 15);
    expect(
      odds(a, { type: 'equipment', definitionKey: 'steel_bat' }).chanceAtLeastOnce,
    ).toBeCloseTo(1 - 0.875 ** 2, 15);
  });
  it('returns exactly zero no-reward odds for all-grant pools and retains very small positive odds', () => {
    const all = body({
      pools: [
        {
          ...pool(),
          entries: [
            { id: 'a', weight: 123456, grant: item() },
            { id: 'b', weight: 765432, grant: item() },
            { id: 'c', weight: 234567, grant: item() },
          ],
        },
      ],
    });
    const a = analyse(bundle({ tables: [tableRef()] }), snapshot({ boss_hoard: all }));
    expect(a.noRewardChance).toBe(0);
    expect(a.rewards[0]!.chanceAtLeastOnce).toBe(1);
    const tiny = body({
      pools: [
        {
          ...pool(),
          entries: [
            { id: 'a', weight: 1, grant: item() },
            ...Array.from({ length: 39 }, (_, i) => ({
              id: `none-${i}`,
              weight: 1_000_000,
              nothing: true as const,
            })),
          ],
        },
      ],
    });
    const rare = analyse(bundle({ tables: [tableRef()] }), snapshot({ boss_hoard: tiny }));
    expect(rare.rewards[0]!.chanceAtLeastOnce).toBeGreaterThan(0);
    expect(rare.rewards[0]!.chanceAtLeastOnce).toBeCloseTo(1 / 39_000_001, 20);
  });
});

describe('input boundaries, incomplete dependencies and T1 work ceilings', () => {
  it.each([0, 0xffff_ffff])('accepts unsigned 32-bit seed boundary %i', (seed) => {
    expect(resolve(bundle(), snapshot(), seed).v).toBe(2);
  });
  it.each([-1, 0x1_0000_0000, 1.5, NaN, Infinity])(
    'refuses seed %i instead of silently wrapping it',
    (seed) => {
      expect(() => resolve(bundle(), snapshot(), seed)).toThrow(DungeonLootResolverError);
    },
  );
  it('refuses ambiguous activity IDs and empty snapshot provenance', () => {
    expect(() =>
      resolveRewardBundle(bundle(), snapshot(), 0, { roomId: 'has:colon', actionId: 'ok' }),
    ).toThrow(DungeonLootResolverError);
    expect(() => resolve(bundle(), { ...snapshot(), hash: '' })).toThrow(DungeonLootResolverError);
  });
  it('refuses missing bodies and candidates even if a chance might miss', () => {
    const tableBundle = bundle({ tables: [tableRef()] });
    for (const call of [() => resolve(tableBundle), () => analyse(tableBundle)])
      expect(call).toThrow(/no supplied body/);
    const chanceBundle = bundle({ chances: [{ id: 'gear', chanceBasisPoints: 1, grant: gear }] });
    const emptyCandidates = { ...snapshot(), equipmentPools: {} };
    for (const call of [
      () => resolve(chanceBundle, emptyCandidates),
      () => analyse(chanceBundle, emptyCandidates),
    ])
      expect(call).toThrow(/no frozen candidates/);
  });
  it('rejects duplicate or incompatible frozen candidates without silently filtering them', () => {
    const b = bundle({ guaranteed: [{ id: 'gear', grant: gear }] });
    for (const candidates of [
      [CANDIDATES[0]!, CANDIDATES[0]!],
      [{ ...CANDIDATES[0]!, slot: 'health' as const }],
      [{ ...CANDIDATES[0]!, rarity: 'SSR' }],
      [{ ...CANDIDATES[0]!, key: 'Bad-Key' }],
    ]) {
      const s = { ...snapshot(), equipmentPools: { [equipmentSelectorKey(SELECTOR)]: candidates } };
      expect(() => resolve(b, s)).toThrow(DungeonLootResolverError);
      expect(() => analyse(b, s)).toThrow(DungeonLootResolverError);
    }
  });
  it('validates raw shapes at both API boundaries, including duplicate IDs and non-integer quantities', () => {
    const valid = bundle({ guaranteed: [{ id: 'one', grant: item() }] });
    for (const b of [
      { ...valid, guaranteed: [...valid.guaranteed, ...valid.guaranteed] },
      { ...valid, guaranteed: [{ id: 'one', grant: item('charm', 0, 1) }] },
      { ...valid, guaranteed: [{ id: 'one', grant: item('charm', 2, 1) }] },
      {
        ...valid,
        guaranteed: [{ id: 'one', grant: currency('shards', 1, Number.MAX_SAFE_INTEGER) }],
      },
      { ...valid, chances: [{ id: 'chance', chanceBasisPoints: 10000, grant: item() }] },
    ]) {
      expect(() => resolve(b)).toThrow(DungeonLootResolverError);
      expect(() => analyse(b)).toThrow(DungeonLootResolverError);
    }
    const b = bundle({ tables: [tableRef()] });
    const invalidTable = {
      ...body(),
      pools: [{ ...pool(), entries: [{ id: 'entry', weight: 0, grant: item() }] }],
    };
    expect(() => resolve(b, snapshot({ boss_hoard: invalidTable }))).toThrow(
      DungeonLootResolverError,
    );
  });
  it('accepts maximum legal grant values without applying bonuses or truncating totals', () => {
    const b = bundle({
      guaranteed: [
        { id: 'shards', grant: currency('shards', 1_000_000) },
        { id: 'bux', grant: currency('waifubux', 1_000_000) },
        { id: 'essence', grant: currency('essence', 100_000) },
        { id: 'charm', grant: item('charm', 999) },
        { id: 'affection-one', grant: affection(500) },
        { id: 'affection-two', grant: affection(500) },
      ],
    });
    expect(resolve(b)).toMatchObject({
      atRisk: { shards: 1_000_000, waifubux: 1_000_000 },
      secured: { essence: 100_000, affection: 1000, items: [{ item: 'charm', quantity: 999 }] },
    });
  });
  it('accepts exactly 10 equipment instances and rejects 11 before resolving', () => {
    const s = snapshot({ boss_hoard: body({ guaranteed: [{ id: 'gear', grant: gear }] }) });
    const b = bundle({ tables: [tableRef('one', 10)] });
    expect(resolve(b, s).secured.equipment).toHaveLength(10);
    expect(() => resolve({ ...b, guaranteed: [{ id: 'extra', grant: gear }] }, s)).toThrow(
      /equipment instances 11/,
    );
    expect(() => analyse({ ...b, guaranteed: [{ id: 'extra', grant: gear }] }, s)).toThrow(
      /equipment instances 11/,
    );
  });
  it('accepts exactly 1000 affection and rejects 1001 through table bodies', () => {
    const s = snapshot({
      boss_hoard: body({ guaranteed: [{ id: 'bond', grant: affection(100) }] }),
    });
    const b = bundle({ tables: [tableRef('one', 10)] });
    expect(resolve(b, s).secured.affection).toBe(1000);
    expect(() => resolve({ ...b, guaranteed: [{ id: 'extra', grant: affection() }] }, s)).toThrow(
      /affection 1001/,
    );
    expect(() => analyse({ ...b, guaranteed: [{ id: 'extra', grant: affection() }] }, s)).toThrow(
      /affection 1001/,
    );
  });
  it('accepts 200 resolved draws and refuses 201, even when all are likely misses', () => {
    const s = snapshot({
      boss_hoard: body({
        chances: Array.from({ length: 20 }, (_, i) => ({
          id: `chance-${i}`,
          chanceBasisPoints: 1,
          grant: item(),
        })),
      }),
    });
    const b = bundle({ tables: [tableRef('one', 10)] });
    expect(resolve(b, s).lines).toHaveLength(DUNGEON_REWARD_LIMITS.resolvedDrawsPerActivity);
    expect(analyse(b, s).sources).toHaveLength(200);
    expect(() => resolve({ ...b, guaranteed: [{ id: 'extra', grant: item() }] }, s)).toThrow(
      /resolved draws 201/,
    );
    expect(() => analyse({ ...b, guaranteed: [{ id: 'extra', grant: item() }] }, s)).toThrow(
      /resolved draws 201/,
    );
  });
});
