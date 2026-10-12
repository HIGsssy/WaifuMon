/** T15B: legacy treasure conversion maths, against the roller that pays legacy treasure. */
import { describe, expect, it } from 'vitest';
import { ExpeditionRewardTableSchema, type ExpeditionRewardTable } from '../../../src/modules/content/schemas';
import { equipmentSelectorKey } from '../../../src/modules/equipment/rewardSelector';
import { rollExpeditionTable } from '../../../src/modules/expeditions/expeditionRewards';
import { DUNGEON_REWARD_LIMITS, DungeonLootTableBodySchema, type DungeonLootTableBody } from '../../../src/modules/dungeons/content/dungeonRewards';
import {
  convertExpeditionRewardTable,
  convertLegacyTreasure,
  convertedTableKey,
  scaleGatedWeights,
  type ExistingLootTable,
  type LegacyTableSource,
} from '../../../src/modules/dungeons/dungeonTreasureConversion';

const table = (input: Record<string, unknown>): ExpeditionRewardTable => ExpeditionRewardTableSchema.parse({ id: 'legacy-loot', ...input });
const item = (itemId: string, weight: number, quantity = 1, enabled = true) => ({ itemId, weight, quantity, enabled });
const converted = (input: Record<string, unknown>) => {
  const result = convertExpeditionRewardTable(table(input));
  expect(result.blockers).toEqual([]);
  return result as typeof result & { body: DungeonLootTableBody };
};

describe('gated weights as pool shares', () => {
  it.each([
    [[60, 15, 25], 3000],
    [[1], 25],
    [[7, 11, 13], 9999],
    [[3, 3], 5000],
    [[5, 10], 10_000],
    [[999, 1], 1],
  ])('keeps P(entry) = chance × weight / total exactly for %j at %i bp', (weights, chance) => {
    const { shares, nothing } = scaleGatedWeights(weights, chance);
    const total = shares.reduce((sum, s) => sum + s, nothing);
    const weightTotal = BigInt(weights.reduce((sum, w) => sum + w, 0));
    weights.forEach((w, i) => {
      // share_i / total === (chance / 10000) × (w_i / Σw), cross-multiplied in integers.
      expect(shares[i]! * 10_000n * weightTotal).toBe(BigInt(chance) * BigInt(w) * total);
    });
    expect(nothing * 10_000n).toBe(BigInt(10_000 - chance) * total);
    // Reduced: no common factor is left.
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    expect([...shares, nothing].reduce(gcd, 0n)).toBe(1n);
  });
});

describe('converting an expedition reward table', () => {
  it('carries WaifuBux, items and gear, and leaves out what a dungeon never paid', () => {
    const { body, omitted } = converted({
      waifubux: { min: 20, max: 40 },
      essence: { min: 5, max: 10 },
      playerXp: 30,
      waifuXp: 12,
      groups: [
        { id: 'salvage', entries: [item('bent_gear', 3, 2), item('velvet_charm', 1)] },
        { id: 'rare', chanceBasisPoints: 2500, rolls: 2, entries: [item('old_map', 1)], equipment: [{ slot: 'attack', rarity: 'R', weight: 3 }] },
      ],
    });
    expect(body.guaranteed).toEqual([{ id: 'waifubux', grant: { type: 'currency', currency: 'waifubux', amount: { min: 20, max: 40 } } }]);
    expect(body.chances).toEqual([]);
    expect(body.pools).toEqual([
      {
        id: 'g1', name: 'salvage', draws: 1,
        entries: [
          { id: 'i1', weight: 3, grant: { type: 'item', item: 'bent_gear', quantity: { min: 2, max: 2 } } },
          { id: 'i2', weight: 1, grant: { type: 'item', item: 'velvet_charm', quantity: { min: 1, max: 1 } } },
        ],
      },
      {
        // 25% of (1 : 3) → 1 : 3 with Nothing holding the other 75% = 12 shares.
        id: 'g2', name: 'rare', draws: 2,
        entries: [
          { id: 'i1', weight: 1, grant: { type: 'item', item: 'old_map', quantity: { min: 1, max: 1 } } },
          { id: 'e1', weight: 3, grant: { type: 'equipment', selector: { slot: 'attack', rarity: 'R' } } },
          { id: 'none', weight: 12, nothing: true },
        ],
      },
    ]);
    expect(omitted.map((o) => [o.reason, o.text])).toEqual([
      ['never_paid', '5–10 Essence'],
      ['never_paid', '30 player XP'],
      ['never_paid', '12 WaifuMon XP'],
    ]);
    expect(DungeonLootTableBodySchema.safeParse(body).success).toBe(true);
  });

  it('drops disabled groups and entries and groups that can never drop, keeping the remaining weights', () => {
    const { body, omitted } = converted({
      groups: [
        { id: 'off', enabled: false, entries: [item('bent_gear', 1)] },
        { id: 'mixed', entries: [item('bent_gear', 2), item('old_map', 5, 1, false)], equipment: [{ rarity: 'N', weight: 1, enabled: false }, { rarity: 'SR', weight: 2 }] },
        { id: 'empty', entries: [item('old_map', 1, 1, false)] },
        { id: 'never', chanceBasisPoints: 0, entries: [item('bent_gear', 1)] },
      ],
    });
    expect(body.pools).toHaveLength(1);
    // The disabled entries' weight is not redistributed by hand: the survivors keep 2 : 2 → 1 : 1.
    expect(body.pools[0]!.entries.map((e) => [e.id, e.weight])).toEqual([['i1', 1], ['e1', 1]]);
    expect(omitted.map((o) => o.reason)).toEqual(['disabled', 'disabled', 'disabled', 'disabled', 'cannot_drop', 'cannot_drop']);
  });

  it('turns a WaifuBux range that starts at 0 into an exact pool, and a 0 maximum into nothing', () => {
    const { body } = converted({ waifubux: { min: 0, max: 9 }, groups: [] });
    expect(body.guaranteed).toEqual([]);
    // Uniform over 0..9: one time in ten nothing, otherwise uniform over 1..9.
    expect(body.pools).toEqual([{
      id: 'waifubux', name: 'WaifuBux', draws: 1,
      entries: [
        { id: 'amount', weight: 9, grant: { type: 'currency', currency: 'waifubux', amount: { min: 1, max: 9 } } },
        { id: 'none', weight: 1, nothing: true },
      ],
    }]);
    expect(converted({ waifubux: { min: 0, max: 0 }, groups: [] }).body).toEqual({ guaranteed: [], chances: [], pools: [] });
  });

  it('splits more rolls than one group may hold into groups with the same shares', () => {
    const { body } = converted({ groups: [{ id: 'many', rolls: 23, chanceBasisPoints: 5000, entries: [item('bent_gear', 1)] }] });
    expect(body.pools.map((p) => [p.id, p.draws, p.name])).toEqual([
      ['g1-1', 10, 'many (part 1 of 3)'],
      ['g1-2', 10, 'many (part 2 of 3)'],
      ['g1-3', 3, 'many (part 3 of 3)'],
    ]);
    for (const pool of body.pools) expect(pool.entries.map((e) => e.weight)).toEqual([1, 1]);
  });

  it('refuses rather than approximating', () => {
    const blocked = (input: Record<string, unknown>) => convertExpeditionRewardTable(table(input));
    // Two large coprime weights behind a 33.33% gate cannot be reduced below the share limit.
    const share = blocked({ groups: [{ id: 'odd', chanceBasisPoints: 3333, entries: [item('bent_gear', 999_983), item('old_map', 999_979)] }] });
    expect(share.body).toBeNull();
    expect(share.blockers.map((b) => b.code)).toEqual(['conversion_share_too_large']);
    expect(blocked({ groups: [{ id: 'bulk', entries: [item('bent_gear', 1, 1000)] }] }).blockers.map((b) => b.code)).toEqual(['conversion_quantity_too_large']);
    expect(blocked({ waifubux: { min: 1, max: DUNGEON_REWARD_LIMITS.atRiskCurrencyAmount + 1 }, groups: [] }).blockers.map((b) => b.code)).toEqual(['conversion_amount_too_large']);
    const groups = Array.from({ length: 7 }, (_, n) => ({ id: `g${n}`, entries: [item('bent_gear', 1)] }));
    expect(blocked({ groups }).blockers.map((b) => b.code)).toEqual(['conversion_too_many_groups']);
    const wide = Array.from({ length: 41 }, (_, n) => item(`item_${n}`, 1));
    expect(blocked({ groups: [{ id: 'wide', entries: wide }] }).blockers.map((b) => b.code)).toEqual(['conversion_too_many_entries']);
  });
});

describe('the converted table against the legacy roller', () => {
  const legacy = table({
    waifubux: { min: 0, max: 4 },
    essence: { min: 100, max: 100 },
    groups: [
      { id: 'salvage', rolls: 2, chanceBasisPoints: 6000, entries: [item('bent_gear', 5, 2), item('velvet_charm', 3), item('old_map', 2, 1, false)], equipment: [{ slot: 'attack', rarity: 'N', weight: 2 }] },
      { id: 'sure', entries: [item('scrap', 1), item('bolt', 3)] },
    ],
  });
  const selector = equipmentSelectorKey({ slot: 'attack', rarity: 'N' });
  const equipmentPools = { [selector]: [{ key: 'iron_blade', name: 'Iron Blade', slot: 'attack' as const, rarity: 'N' }, { key: 'tin_blade', name: 'Tin Blade', slot: 'attack' as const, rarity: 'N' }] };

  it('gives every drop the probability the legacy roller gives it', () => {
    const { body } = converted(legacy as unknown as Record<string, unknown>);
    const RUNS = 40_000;
    const seen = new Map<string, number>();
    const count = (key: string, n = 1) => seen.set(key, (seen.get(key) ?? 0) + n);
    let bux = 0;
    let buxZero = 0;
    for (let run = 1; run <= RUNS; run++) {
      const roll = rollExpeditionTable({ table: legacy, expeditionId: run, kind: 'success', equipmentPools });
      bux += roll.waifubux;
      if (roll.waifubux === 0) buxZero++;
      for (const drop of roll.items) count(`${drop.slug}x${drop.quantity}`);
      for (const gear of roll.equipment) count(gear.drawKey.split(':')[1] === 'salvage' ? 'gear' : 'other');
    }
    // Expected drops per run from the converted pools: draws × share / total.
    const expected = new Map<string, number>();
    for (const pool of body.pools) {
      const total = pool.entries.reduce((sum, e) => sum + e.weight, 0);
      for (const entry of pool.entries) {
        if (!('grant' in entry)) continue;
        const key = entry.grant.type === 'item' ? `${entry.grant.item}x${entry.grant.quantity.min}` : entry.grant.type === 'equipment' ? 'gear' : 'waifubux';
        expected.set(key, (expected.get(key) ?? 0) + (pool.draws * entry.weight) / total);
      }
    }
    // The disabled entry and the Essence never appear on either side.
    expect([...expected.keys()].sort()).toEqual(['bent_gearx2', 'boltx1', 'gear', 'scrapx1', 'velvet_charmx1', 'waifubux']);
    for (const [key, perRun] of expected) {
      if (key === 'waifubux') continue;
      // `mergeGrants` is not applied by the roller, so every drop is one line.
      expect((seen.get(key) ?? 0) / RUNS, key).toBeCloseTo(perRun, 1.7);
    }
    // Exactly: 2 rolls × 60% × weight / 10.
    expect(expected.get('bent_gearx2')).toBeCloseTo(2 * 0.6 * 0.5, 12);
    expect(expected.get('gear')).toBeCloseTo(2 * 0.6 * 0.2, 12);
    expect(expected.get('boltx1')).toBeCloseTo(0.75, 12);
    // WaifuBux 0..4: none one time in five, 2 on average.
    expect(expected.get('waifubux')).toBeCloseTo(0.8, 12);
    expect(buxZero / RUNS).toBeCloseTo(0.2, 1.7);
    expect(bux / RUNS).toBeCloseTo(2, 1);
  });
});

describe('converting a legacy treasure', () => {
  const hashBody = (body: DungeonLootTableBody) => `h:${JSON.stringify(body).length}:${JSON.stringify(body)}`;
  const source = (definition: Record<string, unknown>, enabled = true): LegacyTableSource => ({ enabled, definition, contentHash: `src:${definition.id as string}` });
  const LOOT = { id: 'cave-loot', waifubux: { min: 5, max: 9 }, groups: [{ id: 'g', entries: [item('bent_gear', 1)] }] };
  const GEAR = { id: 'Cave Gear!', groups: [{ id: 'g', entries: [], equipment: [{ rarity: 'R', weight: 1 }] }] };
  const run = (reward: { rewardTable: string | null; equipmentRewardTable: string | null; currency: { min: number; max: number } }, sources: Record<string, LegacyTableSource | null>, lootTables: Record<string, ExistingLootTable> = {}) =>
    convertLegacyTreasure({ reward, sources: new Map(Object.entries(sources)), lootTables: new Map(Object.entries(lootTables)), hashBody });

  it('converts the currency range and both legacy table fields', () => {
    const result = run(
      { rewardTable: 'cave-loot', equipmentRewardTable: 'Cave Gear!', currency: { min: 3, max: 8 } },
      { 'cave-loot': source(LOOT), 'Cave Gear!': source(GEAR) },
    );
    expect(result.blockers).toEqual([]);
    expect(result.rewards).toEqual({
      guaranteed: [{ id: 'g_shards', grant: { type: 'currency', currency: 'shards', amount: { min: 3, max: 8 } } }],
      chances: [],
      tables: [
        { id: 't_1', table: 'converted_cave_loot', draws: 1 },
        { id: 't_2', table: 'converted_cave_gear', draws: 1 },
      ],
    });
    expect(result.tables.map((t) => [t.sourceTable, t.action, t.key, t.name])).toEqual([
      ['cave-loot', 'create', 'converted_cave_loot', 'cave-loot (converted)'],
      ['Cave Gear!', 'create', 'converted_cave_gear', 'Cave Gear! (converted)'],
    ]);
    // The gear table pays its own WaifuBux and items too, as it does today; here it has none.
    expect(result.tables[1]!.body.guaranteed).toEqual([]);
  });

  it('rolls one table twice when both fields name it, as the legacy treasure does', () => {
    const result = run({ rewardTable: 'cave-loot', equipmentRewardTable: 'cave-loot', currency: { min: 0, max: 0 } }, { 'cave-loot': source(LOOT) });
    expect(result.rewards).toEqual({ guaranteed: [], chances: [], tables: [{ id: 't_1', table: 'converted_cave_loot', draws: 2 }] });
    expect(result.tables).toHaveLength(1);
  });

  it('reuses an identical converted table and never takes a key something else holds', () => {
    const first = run({ rewardTable: 'cave-loot', equipmentRewardTable: null, currency: { min: 0, max: 0 } }, { 'cave-loot': source(LOOT) });
    const contentHash = first.tables[0]!.contentHash;
    const reward = { rewardTable: 'cave-loot', equipmentRewardTable: null, currency: { min: 0, max: 0 } };
    const again = (existing: Record<string, ExistingLootTable>) => run(reward, { 'cave-loot': source(LOOT) }, existing).tables.map((t) => [t.action, t.key]);
    expect(again({ converted_cave_loot: { origin: 'converted', contentHash, archived: false } })).toEqual([['reuse', 'converted_cave_loot']]);
    // Same key, but edited since, hand-made, or archived: left alone.
    expect(again({ converted_cave_loot: { origin: 'converted', contentHash: 'other', archived: false } })).toEqual([['create', 'converted_cave_loot_2']]);
    expect(again({ converted_cave_loot: { origin: 'portal', contentHash, archived: false } })).toEqual([['create', 'converted_cave_loot_2']]);
    expect(again({ converted_cave_loot: { origin: 'converted', contentHash, archived: true } })).toEqual([['create', 'converted_cave_loot_2']]);
    expect(again({
      converted_cave_loot: { origin: 'portal', contentHash: 'x', archived: false },
      converted_cave_loot_2: { origin: 'converted', contentHash, archived: false },
    })).toEqual([['reuse', 'converted_cave_loot_2']]);
  });

  it('blocks on what it cannot represent and leaves out a table that is switched off', () => {
    const zero = run({ rewardTable: null, equipmentRewardTable: null, currency: { min: 0, max: 6 } }, {});
    expect(zero.rewards).toBeNull();
    expect(zero.blockers).toEqual([expect.objectContaining({ code: 'conversion_currency_min_zero', table: null })]);
    const gone = run({ rewardTable: 'gone', equipmentRewardTable: null, currency: { min: 0, max: 0 } }, { gone: null });
    expect(gone.blockers.map((b) => [b.code, b.table])).toEqual([['conversion_table_missing', 'gone']]);
    const unreadable = run({ rewardTable: 'bad', equipmentRewardTable: null, currency: { min: 0, max: 0 } }, { bad: source({ id: 'bad', groups: 'nope' }) });
    expect(unreadable.blockers.map((b) => b.code)).toEqual(['conversion_table_unreadable']);
    const off = run({ rewardTable: 'cave-loot', equipmentRewardTable: null, currency: { min: 2, max: 2 } }, { 'cave-loot': source(LOOT, false) });
    expect(off.blockers).toEqual([]);
    expect(off.tables).toEqual([]);
    expect(off.rewards!.tables).toEqual([]);
    expect(off.omitted).toEqual([expect.objectContaining({ table: 'cave-loot', reason: 'disabled' })]);
  });

  it('derives keys that fit the catalogue', () => {
    expect(convertedTableKey('Cave Gear!', 0)).toBe('converted_cave_gear');
    expect(convertedTableKey('x'.repeat(80), 0)).toHaveLength(64);
    expect(convertedTableKey('x'.repeat(80), 11)).toMatch(/^converted_x+_12$/);
    expect(convertedTableKey('x'.repeat(80), 11)).toHaveLength(64);
    expect(convertedTableKey('!!!', 0)).toBe('converted_table');
  });
});
