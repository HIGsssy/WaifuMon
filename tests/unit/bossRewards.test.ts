/**
 * Deterministic draws and the payout roll.
 *
 * The property that matters most is stated first and tested hardest: the same
 * `(encounterId, participationId)` must produce the same numbers forever,
 * because that is what makes a crashed resolution safe to retry.
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
import type { BossRewardTable } from '../../src/modules/content/schemas';
import { loadShippedContent } from '../helpers/fixtures';

const TABLE: BossRewardTable = {
  version: 'test-v1',
  buddyXp: 15,
  minorItems: [
    { slug: 'basic_charm', quantity: 2, weight: 4500 },
    { slug: 'silk_charm', quantity: 1, weight: 2500 },
    { slug: 'basic_charm', quantity: 3, weight: 2000 },
    { slug: 'velvet_charm', quantity: 1, weight: 900 },
    { slug: 'energy_drink', quantity: 1, weight: 100 },
  ],
  jackpot: { slug: 'mythic_contract', quantity: 1, chance: 0.0025 },
};

const roll = (encounterId: number, participationId: number, buddyLevel = 20) =>
  rollBossRewards({ table: TABLE, encounterId, participationId, buddyLevel, maxLevel: 50 });

describe('deterministic draws', () => {
  it('produces the same hash for the same key, every time', () => {
    const first = bossDrawHash(42, 7, 'performance');
    for (let i = 0; i < 50; i++) {
      expect(bossDrawHash(42, 7, 'performance')).toBe(first);
    }
  });

  it('separates the three purposes so they are independent', () => {
    const perf = bossDrawHash(42, 7, 'performance');
    const minor = bossDrawHash(42, 7, 'minor-item');
    const mythic = bossDrawHash(42, 7, 'mythic');
    expect(new Set([perf, minor, mythic]).size).toBe(3);
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
      const value = bossDrawFraction(2, i, 'mythic');
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

  it('always grants exactly one minor drop', () => {
    for (let participationId = 1; participationId <= 300; participationId++) {
      const result = roll(1, participationId);
      const minorCount = result.items.length - (result.jackpotHit ? 1 : 0);
      expect(minorCount).toBe(1);
    }
  });

  it('draws minor items in proportion to their weights', () => {
    const counts = new Map<string, number>();
    const samples = 20_000;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const minor = roll(5, participationId).items[0]!;
      const key = `${minor.slug}x${minor.quantity}`;
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

  it('fires the jackpot at roughly the configured rate, on top of the minor drop', () => {
    let hits = 0;
    const samples = 60_000;
    for (let participationId = 1; participationId <= samples; participationId++) {
      const result = roll(11, participationId);
      if (result.jackpotHit) {
        hits += 1;
        // A jackpot never *displaces* the ordinary reward.
        expect(result.items).toHaveLength(2);
        expect(result.items[1]!.slug).toBe('mythic_contract');
      }
    }
    const rate = hits / samples;
    expect(rate).toBeGreaterThan(0.0012);
    expect(rate).toBeLessThan(0.0045);
  });

  it('never fires the jackpot when the chance is zero', () => {
    const noJackpot: BossRewardTable = { ...TABLE, jackpot: null };
    for (let participationId = 1; participationId <= 2000; participationId++) {
      const result = rollBossRewards({
        table: noJackpot,
        encounterId: 1,
        participationId,
        buddyLevel: 10,
        maxLevel: 50,
      });
      expect(result.jackpotHit).toBe(false);
      expect(result.items).toHaveLength(1);
    }
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
    expect(capped.jackpotHit).toBe(below.jackpotHit);
    expect(capped.buddyXp).toBe(0);
  });

  it('exposes the XP rule on its own', () => {
    expect(applicableBuddyXp(15, 49, 50)).toBe(15);
    expect(applicableBuddyXp(15, 50, 50)).toBe(0);
    // Defensive: a copy somehow above the cap still gets nothing.
    expect(applicableBuddyXp(15, 51, 50)).toBe(0);
  });

  it('pins the reward-logic version', () => {
    expect(BOSS_REWARD_LOGIC_VERSION).toBe(1);
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
  it('rolls a valid drop for every participation using shipped content', () => {
    const table = loadShippedContent().tables.bossEncounters.rewardTables[
      'standard-scouting-v1'
    ]!;
    const validSlugs = new Set([...table.minorItems.map((e) => e.slug), table.jackpot!.slug]);
    for (let participationId = 1; participationId <= 500; participationId++) {
      const result = rollBossRewards({
        table,
        encounterId: 1,
        participationId,
        buddyLevel: 5,
        maxLevel: 50,
      });
      expect(result.buddyXp).toBe(15);
      for (const item of result.items) expect(validSlugs).toContain(item.slug);
    }
  });
});
