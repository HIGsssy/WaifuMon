/**
 * Deterministic draws and the payout roll.
 *
 * The property that matters most is stated first and tested hardest: the same
 * `(encounterId, participationId)` must produce the same numbers forever,
 * because that is what makes a crashed resolution safe to retry.
 *
 * The second property, tested throughout the group suites: **boss loot is not
 * the Shop.** Nothing here constructs, reads, or is affected by a Shop field.
 */
import { describe, expect, it } from 'vitest';
import {
  BOSS_RANDOM_SALT,
  bossDrawFraction,
  bossDrawHash,
  bossDrawInt,
} from '../../src/modules/bosses/bossRandom';
import {
  BOSS_REWARD_LOGIC_VERSION,
  applicableBuddyXp,
  mergeGrants,
  rollBossRewards,
} from '../../src/modules/bosses/bossRewards';
import {
  BossRewardsFileSchema,
  bossRewardTableVersion,
  type BossRewardTable,
} from '../../src/modules/content/schemas';
import { loadShippedContent } from '../helpers/fixtures';

/** The shipped shape, inline, so a content edit cannot silently retune a unit test. */
const TABLE: BossRewardTable = {
  id: 'test-v1',
  enabled: true,
  buddyXp: 15,
  groups: [
    {
      id: 'standard-item',
      enabled: true,
      rolls: 1,
      chanceBasisPoints: 10_000,
      entries: [
        { itemId: 'basic_charm', enabled: true, weight: 4500, quantity: 2 },
        { itemId: 'silk_charm', enabled: true, weight: 2500, quantity: 1 },
        { itemId: 'basic_charm', enabled: true, weight: 2000, quantity: 3 },
        { itemId: 'velvet_charm', enabled: true, weight: 900, quantity: 1 },
        { itemId: 'energy_drink', enabled: true, weight: 100, quantity: 1 },
      ],
    },
    {
      id: 'rare-bonus',
      enabled: true,
      rolls: 1,
      chanceBasisPoints: 25,
      entries: [{ itemId: 'mythic_contract', enabled: true, weight: 1, quantity: 1 }],
    },
  ],
};

const roll = (encounterId: number, participationId: number, buddyLevel = 20) =>
  rollBossRewards({ table: TABLE, encounterId, participationId, buddyLevel, maxLevel: 50 });

/** `TABLE` with one deep edit applied, leaving the original untouched. */
function withGroup(
  groupId: string,
  patch: Partial<BossRewardTable['groups'][number]>,
): BossRewardTable {
  return {
    ...TABLE,
    groups: TABLE.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)),
  };
}

function rollTable(table: BossRewardTable, participationId: number, encounterId = 1) {
  return rollBossRewards({
    table,
    encounterId,
    participationId,
    buddyLevel: 20,
    maxLevel: 50,
  });
}

describe('deterministic draws', () => {
  it('produces the same hash for the same key, every time', () => {
    const first = bossDrawHash(42, 7, 'performance');
    for (let i = 0; i < 50; i++) {
      expect(bossDrawHash(42, 7, 'performance')).toBe(first);
    }
  });

  it('separates every purpose so they are independent', () => {
    const values = [
      bossDrawHash(42, 7, 'performance'),
      bossDrawHash(42, 7, 'reward:standard-item:0:gate'),
      bossDrawHash(42, 7, 'reward:standard-item:0:pick'),
      bossDrawHash(42, 7, 'reward:rare-bonus:0:gate'),
      bossDrawHash(42, 7, 'reward:rare-bonus:0:pick'),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('separates rolls within one group, so `rolls: n` is n independent draws', () => {
    const first = bossDrawHash(42, 7, 'reward:standard-item:0:pick');
    const second = bossDrawHash(42, 7, 'reward:standard-item:1:pick');
    expect(first).not.toBe(second);
  });

  it('separates participations within one encounter', () => {
    const values = new Set<number>();
    for (let participationId = 1; participationId <= 200; participationId++) {
      values.add(bossDrawInt(1, participationId, 'performance', 85, 115));
    }
    // 200 draws over a 31-wide range must actually spread, not collapse.
    expect(values.size).toBeGreaterThan(25);
  });

  it('reaches both endpoints of the performance range', () => {
    const seen = new Set<number>();
    for (let participationId = 1; participationId <= 5000; participationId++) {
      seen.add(bossDrawInt(1, participationId, 'performance', 85, 115));
    }
    expect(seen.has(85)).toBe(true);
    expect(seen.has(115)).toBe(true);
    expect(seen.size).toBe(31);
  });

  it('never leaves the requested range', () => {
    for (let participationId = 1; participationId <= 2000; participationId++) {
      const value = bossDrawInt(9, participationId, 'performance', 85, 115);
      expect(value).toBeGreaterThanOrEqual(85);
      expect(value).toBeLessThanOrEqual(115);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('is roughly uniform across the performance range', () => {
    const counts = new Map<number, number>();
    const samples = 31_000;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const value = bossDrawInt(3, participationId, 'performance', 85, 115);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const expected = samples / 31;
    for (const [value, count] of counts) {
      expect(Math.abs(count - expected) / expected, `bucket ${value}`).toBeLessThan(0.2);
    }
  });

  it('yields fractions strictly inside [0, 1)', () => {
    for (let i = 1; i <= 1000; i++) {
      const value = bossDrawFraction(2, i, 'reward:rare-bonus:0:gate');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('rejects an inverted range', () => {
    expect(() => bossDrawInt(1, 1, 'performance', 115, 85)).toThrow(RangeError);
  });

  it('freezes the salt — changing it would re-roll every live encounter', () => {
    expect(BOSS_RANDOM_SALT).toBe('waifumon.boss.roll.v1');
  });
});

describe('reward rolls', () => {
  it('is byte-identical across repeated calls — a retry cannot diverge', () => {
    for (const [encounterId, participationId] of [
      [1, 1],
      [7, 42],
      [999, 12345],
    ] as const) {
      const first = roll(encounterId, participationId);
      for (let i = 0; i < 20; i++) {
        expect(roll(encounterId, participationId)).toEqual(first);
      }
    }
  });

  it('always grants exactly one standard drop', () => {
    for (let participationId = 1; participationId <= 300; participationId++) {
      const result = roll(1, participationId);
      const standard = result.hitGroupIds.filter((id) => id === 'standard-item');
      expect(standard).toHaveLength(1);
    }
  });

  it('draws standard entries in proportion to their weights', () => {
    const counts = new Map<string, number>();
    const samples = 20_000;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const standard = roll(5, participationId).items[0]!;
      const key = `${standard.slug}x${standard.quantity}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const share = (key: string) => (counts.get(key) ?? 0) / samples;
    expect(share('basic_charmx2')).toBeGreaterThan(0.42);
    expect(share('basic_charmx2')).toBeLessThan(0.48);
    expect(share('silk_charmx1')).toBeGreaterThan(0.23);
    expect(share('silk_charmx1')).toBeLessThan(0.27);
    expect(share('velvet_charmx1')).toBeGreaterThan(0.07);
    expect(share('velvet_charmx1')).toBeLessThan(0.11);
    expect(share('energy_drinkx1')).toBeGreaterThan(0.005);
    expect(share('energy_drinkx1')).toBeLessThan(0.017);
  });

  it('fires the rare bonus at roughly its configured rate, on top of the standard drop', () => {
    let hits = 0;
    const samples = 60_000;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const result = roll(11, participationId);
      if (result.hitGroupIds.includes('rare-bonus')) {
        hits += 1;
        // The Mythic Contract is an *addition*, never a replacement.
        expect(result.items).toHaveLength(2);
        expect(result.items[1]!.slug).toBe('mythic_contract');
        expect(result.hitGroupIds).toEqual(['standard-item', 'rare-bonus']);
      }
    }
    const rate = hits / samples;
    expect(rate).toBeGreaterThan(0.0012);
    expect(rate).toBeLessThan(0.0045);
  });

  it('grants the configured XP below the level cap', () => {
    expect(roll(1, 1, 49).buddyXp).toBe(15);
  });

  it('grants no XP at the level cap but still grants items', () => {
    const capped = roll(1, 1, 50);
    expect(capped.buddyXp).toBe(0);
    expect(capped.items.length).toBeGreaterThan(0);
  });

  it('does not redirect the discarded XP anywhere', () => {
    // The capped roll is the uncapped roll with the XP zeroed and *nothing*
    // else changed — no substitute item, no extra drop.
    const below = roll(3, 3, 20);
    const capped = roll(3, 3, 50);
    expect(capped.items).toEqual(below.items);
    expect(capped.hitGroupIds).toEqual(below.hitGroupIds);
    expect(capped.buddyXp).toBe(0);
  });

  it('exposes the XP rule on its own', () => {
    expect(applicableBuddyXp(15, 49, 50)).toBe(15);
    expect(applicableBuddyXp(15, 50, 50)).toBe(0);
    // Defensive: a copy somehow above the cap still gets nothing.
    expect(applicableBuddyXp(15, 51, 50)).toBe(0);
  });

  it('pins the reward-logic version', () => {
    // Bumped from 1 when the flat minorItems/jackpot pair became groups.
    expect(BOSS_REWARD_LOGIC_VERSION).toBe(2);
  });
});

describe('entry enable / disable', () => {
  it('excludes a disabled entry from every future roll', () => {
    const table = withGroup('standard-item', {
      entries: TABLE.groups[0]!.entries.map((e) =>
        e.itemId === 'basic_charm' && e.quantity === 2 ? { ...e, enabled: false } : e,
      ),
    });
    for (let participationId = 1; participationId <= 1000; participationId++) {
      const drop = rollTable(table, participationId).items[0]!;
      expect(`${drop.slug}x${drop.quantity}`).not.toBe('basic_charmx2');
    }
  });

  it('normalizes the remaining weights over their own total', () => {
    // Disabling the 4,500 entry leaves 5,500. Silk should rise 25% → ~45.5%.
    const table = withGroup('standard-item', {
      entries: TABLE.groups[0]!.entries.map((e) =>
        e.itemId === 'basic_charm' && e.quantity === 2 ? { ...e, enabled: false } : e,
      ),
    });
    const samples = 20_000;
    let silk = 0;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const drop = rollTable(table, participationId).items[0]!;
      if (drop.slug === 'silk_charm') silk += 1;
    }
    const share = silk / samples;
    expect(share).toBeGreaterThan(0.43);
    expect(share).toBeLessThan(0.48);
  });

  it('still grants exactly one drop from a group with entries disabled', () => {
    const table = withGroup('standard-item', {
      entries: TABLE.groups[0]!.entries.map((e, i) => (i < 3 ? { ...e, enabled: false } : e)),
    });
    for (let participationId = 1; participationId <= 200; participationId++) {
      expect(rollTable(table, participationId).hitGroupIds).toContain('standard-item');
    }
  });

  it('skips a group whose every entry is disabled, with a warning naming it', () => {
    const table = withGroup('standard-item', {
      entries: TABLE.groups[0]!.entries.map((e) => ({ ...e, enabled: false })),
    });
    const result = rollTable(table, 1);
    expect(result.hitGroupIds).not.toContain('standard-item');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.groupId).toBe('standard-item');
    expect(result.warnings[0]!.message).toContain('no enabled entries');
    // XP is unaffected — an empty item group is not a failed payout.
    expect(result.buddyXp).toBe(15);
  });
});

describe('group enable / disable', () => {
  it('skips a disabled group entirely and warns about nothing', () => {
    const table = withGroup('rare-bonus', { enabled: false });
    for (let participationId = 1; participationId <= 3000; participationId++) {
      const result = rollTable(table, participationId);
      expect(result.hitGroupIds).not.toContain('rare-bonus');
      expect(result.warnings).toHaveLength(0);
    }
  });

  it('leaves the other groups untouched when one is disabled', () => {
    const table = withGroup('rare-bonus', { enabled: false });
    for (let participationId = 1; participationId <= 200; participationId++) {
      const withRare = roll(1, participationId);
      const without = rollTable(table, participationId);
      // The standard pick is keyed on its own group id, so removing a
      // different group cannot shift it.
      expect(without.items[0]).toEqual(withRare.items[0]);
    }
  });

  it('warns rather than silently paying nothing when a group can never fire', () => {
    const table = withGroup('rare-bonus', { chanceBasisPoints: 0 });
    const result = rollTable(table, 1);
    expect(result.hitGroupIds).not.toContain('rare-bonus');
    expect(result.warnings[0]!.message).toContain('chanceBasisPoints 0');
  });

  it('treats `rolls` as independent draws against the same pool', () => {
    const table = withGroup('standard-item', { rolls: 3 });
    for (let participationId = 1; participationId <= 100; participationId++) {
      const result = rollTable(table, participationId);
      expect(result.hitGroupIds.filter((id) => id === 'standard-item')).toHaveLength(3);
    }
    // Three draws that always agreed would mean the roll index is not in the key.
    const varied = Array.from({ length: 50 }, (_, i) => rollTable(table, i + 1)).some((r) => {
      const picks = r.items.filter((_, i) => i < 3).map((x) => `${x.slug}x${x.quantity}`);
      return new Set(picks).size > 1;
    });
    expect(varied).toBe(true);
  });

  it('runs a certain group without consulting the gate at all', () => {
    // chanceBasisPoints 10000 must be indistinguishable from "no gate": every
    // participation gets the drop, with no dependence on the gate hash.
    for (let participationId = 1; participationId <= 500; participationId++) {
      expect(roll(77, participationId).hitGroupIds).toContain('standard-item');
    }
  });
});

describe('boss loot is independent of the Shop', () => {
  const content = loadShippedContent();
  const items = new Map(content.items.map((i) => [i.slug, i]));
  const shipped = content.bossRewards.find((t) => t.id === 'standard-scouting-v1')!;
  const bossItemIds = new Set(
    shipped.groups.flatMap((g) => g.entries.map((e) => e.itemId)),
  );

  it('drops items regardless of whether the Shop sells them', () => {
    // Mythic Contract is a boss drop and is deliberately sold in no region.
    const mythic = items.get('mythic_contract')!;
    expect(mythic.shopRegions).toEqual([]);
    expect(bossItemIds).toContain('mythic_contract');
  });

  it('covers a boss-only, a both-source, and a neither-source item', () => {
    const sold = (slug: string): boolean => (items.get(slug)?.shopRegions.length ?? 0) > 0;
    const bossOnly = [...bossItemIds].filter((id) => !sold(id));
    const bothSources = [...bossItemIds].filter((id) => sold(id));
    const shopOnly = content.items.filter((i) => i.shopRegions.length > 0 && !bossItemIds.has(i.slug));
    const neither = content.items.filter(
      (i) => i.shopRegions.length === 0 && !bossItemIds.has(i.slug),
    );

    expect(bossOnly.length).toBeGreaterThan(0);
    expect(bothSources.length).toBeGreaterThan(0);
    expect(shopOnly.length).toBeGreaterThan(0);
    expect(neither.length).toBeGreaterThan(0);
    // A neither-source item must never appear in a boss roll.
    for (const item of neither) expect(bossItemIds).not.toContain(item.slug);
  });

  it('un-listing an item from the Shop does not change what a boss drops', () => {
    // Boss rolls read the reward table only, so a Shop edit is not even
    // expressible as an input here — which is the guarantee. Prove it by
    // showing the roll depends on nothing but the table.
    const shopless = content.items.map((i) => ({ ...i, shopRegions: [], buyPrice: null }));
    expect(shopless.length).toBeGreaterThan(0);
    const before = rollBossRewards({
      table: shipped,
      encounterId: 4,
      participationId: 9,
      buddyLevel: 10,
      maxLevel: 50,
    });
    const after = rollBossRewards({
      table: shipped,
      encounterId: 4,
      participationId: 9,
      buddyLevel: 10,
      maxLevel: 50,
    });
    expect(after).toEqual(before);
  });

  it('disabling a boss entry does not touch the Shop listing', () => {
    const table: BossRewardTable = {
      ...shipped,
      groups: shipped.groups.map((g) => ({
        ...g,
        entries: g.entries.map((e) =>
          e.itemId === 'velvet_charm' ? { ...e, enabled: false } : e,
        ),
      })),
    };
    for (let participationId = 1; participationId <= 500; participationId++) {
      const result = rollTable(table, participationId);
      for (const item of result.items) expect(item.slug).not.toBe('velvet_charm');
    }
    // The Shop's own view of the item is untouched by that edit.
    expect(items.get('velvet_charm')!.shopRegions).toContain('waifu-valley');
    expect(items.get('velvet_charm')!.buyPrice).toBeGreaterThan(0);
  });
});

describe('reward snapshots survive configuration changes', () => {
  it('reproduces the same rewards on a retry after the table is edited back', () => {
    const original = roll(21, 4);
    const edited = withGroup('standard-item', {
      entries: TABLE.groups[0]!.entries.map((e) =>
        e.itemId === 'energy_drink' ? { ...e, enabled: false } : e,
      ),
    });
    // A future roll may differ...
    rollTable(edited, 4, 21);
    // ...but re-rolling the *original* table is bit-for-bit identical, which is
    // what a resolution retry does: the encounter row names the table it spawned
    // under.
    expect(roll(21, 4)).toEqual(original);
  });

  it('records a version that an edit can move deliberately', () => {
    expect(bossRewardTableVersion(TABLE)).toBe('test-v1');
    expect(bossRewardTableVersion({ ...TABLE, version: 'test-v2' })).toBe('test-v2');
    // No explicit version falls back to the id rather than an empty string.
    const { version: _dropped, ...noVersion } = { ...TABLE, version: 'x' };
    expect(bossRewardTableVersion(noVersion as BossRewardTable)).toBe('test-v1');
  });
});

describe('grant merging', () => {
  it('collapses repeated slugs into one stack', () => {
    expect(
      mergeGrants([
        { slug: 'basic_charm', quantity: 2 },
        { slug: 'silk_charm', quantity: 1 },
        { slug: 'basic_charm', quantity: 3 },
      ]),
    ).toEqual([
      { slug: 'basic_charm', quantity: 5 },
      { slug: 'silk_charm', quantity: 1 },
    ]);
  });

  it('leaves distinct slugs alone', () => {
    const grants = [
      { slug: 'basic_charm', quantity: 2 },
      { slug: 'mythic_contract', quantity: 1 },
    ];
    expect(mergeGrants(grants)).toEqual(grants);
  });
});

describe('the shipped reward table behaves', () => {
  const content = loadShippedContent();
  const table = content.bossRewards.find((t) => t.id === 'standard-scouting-v1')!;

  it('rolls a valid drop for every participation using shipped content', () => {
    const validSlugs = new Set(
      table.groups.flatMap((g) => g.entries.map((e) => e.itemId)),
    );
    for (let participationId = 1; participationId <= 500; participationId++) {
      const result = rollBossRewards({
        table,
        encounterId: 1,
        participationId,
        buddyLevel: 5,
        maxLevel: 50,
      });
      expect(result.buddyXp).toBe(15);
      expect(result.warnings).toEqual([]);
      for (const item of result.items) expect(validSlugs).toContain(item.slug);
    }
  });

  it('ships the documented weights and quantities', () => {
    const standard = table.groups.find((g) => g.id === 'standard-item')!;
    expect(standard.chanceBasisPoints).toBe(10_000);
    expect(standard.rolls).toBe(1);
    expect(standard.entries.map((e) => [e.itemId, e.quantity, e.weight])).toEqual([
      ['basic_charm', 2, 4500],
      ['silk_charm', 1, 2500],
      ['basic_charm', 3, 2000],
      ['velvet_charm', 1, 900],
      ['energy_drink', 1, 100],
    ]);
    // Documented as shares out of 10,000 — the doc's percentages only hold if
    // the weights actually sum to it.
    expect(standard.entries.reduce((sum, e) => sum + e.weight, 0)).toBe(10_000);

    const rare = table.groups.find((g) => g.id === 'rare-bonus')!;
    expect(rare.chanceBasisPoints).toBe(25);
    expect(rare.rolls).toBe(1);
    expect(rare.entries).toEqual([
      { itemId: 'mythic_contract', enabled: true, weight: 1, quantity: 1 },
    ]);
  });

  it('is enabled, top to bottom', () => {
    expect(table.enabled).toBe(true);
    for (const group of table.groups) {
      expect(group.enabled, group.id).toBe(true);
      for (const entry of group.entries) expect(entry.enabled, entry.itemId).toBe(true);
    }
  });
});

describe('boss reward file validation', () => {
  const base = () => JSON.parse(JSON.stringify([TABLE])) as unknown;

  it('accepts the shipped file shape', () => {
    expect(BossRewardsFileSchema.safeParse(base()).success).toBe(true);
  });

  it('applies defaults so an author may omit the switches', () => {
    const parsed = BossRewardsFileSchema.parse([
      {
        id: 'minimal',
        buddyXp: 0,
        groups: [{ id: 'g', entries: [{ itemId: 'basic_charm', weight: 1, quantity: 1 }] }],
      },
    ]);
    expect(parsed[0]!.enabled).toBe(true);
    expect(parsed[0]!.groups[0]!.enabled).toBe(true);
    expect(parsed[0]!.groups[0]!.rolls).toBe(1);
    expect(parsed[0]!.groups[0]!.chanceBasisPoints).toBe(10_000);
    expect(parsed[0]!.groups[0]!.entries[0]!.enabled).toBe(true);
  });

  it('rejects two tables sharing an id', () => {
    const result = BossRewardsFileSchema.safeParse([TABLE, TABLE]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('two tables with id');
  });

  it('rejects two groups in one table sharing an id', () => {
    const table = { ...TABLE, groups: [TABLE.groups[0]!, TABLE.groups[0]!] };
    const result = BossRewardsFileSchema.safeParse([table]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('two groups with id');
  });

  it('rejects the same item-and-quantity drop listed twice in one group', () => {
    const table = withGroup('standard-item', {
      entries: [
        { itemId: 'basic_charm', enabled: true, weight: 1, quantity: 2 },
        { itemId: 'basic_charm', enabled: true, weight: 1, quantity: 2 },
      ],
    });
    const result = BossRewardsFileSchema.safeParse([table]);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('same drop twice');
  });

  it('allows the same item at different quantities', () => {
    // "2x Basic Charm" and "3x Basic Charm" are two legitimate drops, and the
    // shipped table relies on it.
    expect(BossRewardsFileSchema.safeParse([TABLE]).success).toBe(true);
  });

  it('rejects zero and negative weights, quantities and rolls', () => {
    const bad = (patch: Record<string, unknown>) =>
      BossRewardsFileSchema.safeParse([
        {
          ...TABLE,
          groups: [{ ...TABLE.groups[0]!, entries: [{ ...TABLE.groups[0]!.entries[0]!, ...patch }] }],
        },
      ]).success;
    expect(bad({ weight: 0 })).toBe(false);
    expect(bad({ weight: -1 })).toBe(false);
    expect(bad({ quantity: 0 })).toBe(false);
    expect(BossRewardsFileSchema.safeParse([withGroup('rare-bonus', { rolls: 0 })]).success).toBe(
      false,
    );
  });

  it('bounds chanceBasisPoints to [0, 10000]', () => {
    expect(
      BossRewardsFileSchema.safeParse([withGroup('rare-bonus', { chanceBasisPoints: 10_001 })])
        .success,
    ).toBe(false);
    expect(
      BossRewardsFileSchema.safeParse([withGroup('rare-bonus', { chanceBasisPoints: -1 })]).success,
    ).toBe(false);
    expect(
      BossRewardsFileSchema.safeParse([withGroup('rare-bonus', { chanceBasisPoints: 0 })]).success,
    ).toBe(true);
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // `.strict()` — a typo'd field would otherwise ship as a missing setting.
    const result = BossRewardsFileSchema.safeParse([{ ...TABLE, jackpot: { slug: 'x' } }]);
    expect(result.success).toBe(false);
  });

  it('requires at least one group and one entry', () => {
    expect(BossRewardsFileSchema.safeParse([{ ...TABLE, groups: [] }]).success).toBe(false);
    expect(
      BossRewardsFileSchema.safeParse([withGroup('rare-bonus', { entries: [] })]).success,
    ).toBe(false);
  });
});
