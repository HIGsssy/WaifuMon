/**
 * `describeRegionDistribution` on hand-built fixtures, where every expected
 * probability can be written down. Its agreement with the real hunt, spawner
 * and selector is proved separately against PostgreSQL
 * (`tests/integration/regionPoolOdds.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { BuddyBonus } from '../../../src/modules/buddyBonus/buddyBonusEffects';
import {
  describeRegionDistribution,
  diffDistributions,
  type DistributionInput,
  type DistributionSpecies,
} from '../../../src/modules/regionPools/regionPoolDistribution';

const RARITY_TABLE = [
  { rarity: 'N', weight: 60 },
  { rarity: 'R', weight: 25 },
  { rarity: 'SR', weight: 10 },
  { rarity: 'SSR', weight: 4 },
  { rarity: 'UR', weight: 0.9 },
  { rarity: 'LR', weight: 0.1 },
] as const;
const RESULT_TABLE = [
  { kind: 'encounter', weight: 74 },
  { kind: 'item_find', weight: 8 },
  { kind: 'waifubux_find', weight: 8 },
  { kind: 'essence_find', weight: 5 },
  { kind: 'rare_item_find', weight: 3 },
  { kind: 'flavor', weight: 2 },
] as const;
const TABLES = {
  hunt: { rarityTable: [...RARITY_TABLE], resultTable: [...RESULT_TABLE] },
  progression: { rareEncounterShift: { atLevel: 40, fromRarity: 'N', toRarity: 'R', weightUnits: 1 } },
} as unknown as DistributionInput['tables'];

function sp(slug: string, rarity: string, over: Partial<DistributionSpecies> = {}): DistributionSpecies {
  return { slug, name: slug, rarity, enabled: true, tags: [], race: 'human', affinity: 'switch', perSpeciesWeight: 1, ...over };
}

const SPECIES = [
  sp('n_a', 'N'),
  sp('n_b', 'N', { race: 'demon' }),
  sp('r_a', 'R'),
  sp('sr_a', 'SR', { affinity: 'dominant' }),
  sp('ssr_a', 'SSR'),
  sp('ur_a', 'UR'),
  sp('lr_a', 'LR'),
  // Valley-only and global-only extras.
  sp('v_ssr', 'SSR'),
  sp('g_ur', 'UR'),
  sp('excl_ur', 'UR', { tags: ['region_exclusive'] }),
  sp('dung_lr', 'LR', { tags: ['dungeon_exclusive'] }),
  sp('off_n', 'N', { enabled: false }),
  sp('ex_a', 'EX'),
];
const SPECIES_MAP = new Map(SPECIES.map((s) => [s.slug, s]));

const FULL_POOL = [
  { species: 'n_a', weight: 3 },
  { species: 'n_b', weight: 1 },
  { species: 'r_a', weight: 1 },
  { species: 'sr_a', weight: 1 },
  { species: 'ssr_a', weight: 1 },
  { species: 'ur_a', weight: 1 },
  { species: 'lr_a', weight: 1 },
];

function input(over: Partial<DistributionInput> = {}): DistributionInput {
  return {
    mode: 'scripted_spawn',
    level: 1,
    regionId: 'twin-peeks',
    defaultRegionId: 'waifu-valley',
    pool: FULL_POOL,
    defaultPool: [{ species: 'v_ssr', weight: 1 }],
    species: SPECIES_MAP,
    tables: TABLES,
    ...over,
  };
}

const odds = (r: ReturnType<typeof describeRegionDistribution>, slug: string) =>
  r.species.find((s) => s.slug === slug)?.perEncounter ?? 0;
const total = (r: ReturnType<typeof describeRegionDistribution>) => r.species.reduce((s, x) => s + x.perEncounter, 0);

describe('rarity first, then region-local weight', () => {
  it('splits each rarity by pool weight and sums to one', () => {
    const r = describeRegionDistribution(input());
    expect(odds(r, 'n_a')).toBeCloseTo(0.6 * 0.75, 12);
    expect(odds(r, 'n_b')).toBeCloseTo(0.6 * 0.25, 12);
    expect(odds(r, 'lr_a')).toBeCloseTo(0.001, 12);
    expect(r.species.find((s) => s.slug === 'n_a')!.shareOfRarity).toBeCloseTo(0.75, 12);
    expect(total(r)).toBeCloseTo(1, 12);
    expect(r.exhausted).toEqual({ probability: 0, fallback: 'default_pool_arbitrary' });
    expect(r.errorProbability).toBe(0);
  });

  it('a 50% share of a 0.1% rarity is 0.05% overall', () => {
    const r = describeRegionDistribution(
      input({ pool: [...FULL_POOL.filter((e) => e.species !== 'lr_a'), { species: 'lr_a', weight: 1 }, { species: 'dung_lr', weight: 1 }] }),
    );
    // dung_lr is never pooled-eligible, so lr_a keeps all of LR.
    expect(odds(r, 'lr_a')).toBeCloseTo(0.001, 12);
    const two = describeRegionDistribution(
      input({ species: new Map([...SPECIES_MAP, ['lr_b', sp('lr_b', 'LR')]]), pool: [...FULL_POOL, { species: 'lr_b', weight: 1 }] }),
    );
    expect(two.species.find((s) => s.slug === 'lr_a')!.shareOfRarity).toBeCloseTo(0.5, 12);
    expect(odds(two, 'lr_a')).toBeCloseTo(0.0005, 12);
  });

  it('applies the level-40 shift of one unit from N to R', () => {
    const r = describeRegionDistribution(input({ level: 40 }));
    expect(r.rarities.find((x) => x.rarity === 'N')!.rollProbability).toBeCloseTo(0.59, 12);
    expect(r.rarities.find((x) => x.rarity === 'R')!.rollProbability).toBeCloseTo(0.26, 12);
    const below = describeRegionDistribution(input({ level: 39 }));
    expect(below.rarities.find((x) => x.rarity === 'N')!.rollProbability).toBeCloseTo(0.6, 12);
  });

  it('excludes disabled, dungeon-exclusive and never-hunted (EX) members with reasons', () => {
    const r = describeRegionDistribution(
      input({ pool: [...FULL_POOL, { species: 'off_n', weight: 50 }, { species: 'dung_lr', weight: 1 }, { species: 'ex_a', weight: 1 }, { species: 'nobody', weight: 1 }] }),
    );
    expect(r.excluded).toEqual([
      { slug: 'off_n', reason: 'disabled' },
      { slug: 'dung_lr', reason: 'dungeon_exclusive' },
      { slug: 'ex_a', reason: 'rarity_not_hunted' },
      { slug: 'nobody', reason: 'unknown_species' },
    ]);
    expect(odds(r, 'n_a')).toBeCloseTo(0.6 * 0.75, 12);
  });
});

describe('fallback tiers, dead rarities and exhausted rerolls', () => {
  it('draws an empty rarity from the default pool, then the global table without exclusives', () => {
    const r = describeRegionDistribution(input({ pool: FULL_POOL.filter((e) => !['ssr_a', 'ur_a'].includes(e.species)) }));
    expect(r.rarities.find((x) => x.rarity === 'SSR')!.tier).toBe('default_region');
    expect(odds(r, 'v_ssr')).toBeCloseTo(0.04, 12);
    expect(r.species.find((s) => s.slug === 'v_ssr')!.inPool).toBe(false);
    const ur = r.rarities.find((x) => x.rarity === 'UR')!;
    expect(ur.tier).toBe('global');
    // Global UR: ur_a and g_ur (excl_ur is region-exclusive), per-species weight 1 each.
    expect(odds(r, 'g_ur')).toBeCloseTo(0.009 / 2, 12);
    expect(odds(r, 'ur_a')).toBeCloseTo(0.009 / 2, 12);
    expect(odds(r, 'excl_ur')).toBe(0);
    expect(r.issues.map((i) => i.code)).toEqual(['rarity_falls_back', 'rarity_falls_back']);
  });

  it('the default region never falls back to itself', () => {
    const r = describeRegionDistribution(input({ regionId: 'waifu-valley', pool: FULL_POOL.filter((e) => e.species !== 'ssr_a') }));
    const ssr = r.rarities.find((x) => x.rarity === 'SSR')!;
    expect(ssr.tier).toBe('global');
    expect(odds(r, 'v_ssr') + odds(r, 'ssr_a')).toBeCloseTo(0.04, 12);
  });

  it('rerolls dead rarities with the same table and reports the exhausted mass', () => {
    // No enabled N anywhere: N is dead (d = 0.6).
    const species = new Map([...SPECIES_MAP].map(([k, v]) => [k, v.rarity === 'N' ? { ...v, enabled: false } : v]));
    const r = describeRegionDistribution(input({ species }));
    const d = 0.6;
    const reach = (1 - d ** 6) / (1 - d);
    expect(r.rarities.find((x) => x.rarity === 'N')!.tier).toBe('dead');
    expect(odds(r, 'r_a')).toBeCloseTo(0.25 * reach, 12);
    expect(r.exhausted!.probability).toBeCloseTo(d ** 6, 12);
    expect(r.exhausted!.fallback).toBe('default_pool_arbitrary');
    expect(total(r) + r.exhausted!.probability).toBeCloseTo(1, 12);
    expect(r.issues.map((i) => i.code)).toContain('rerolls_exhausted');
  });

  it('names the exhausted fallback the runtime would take', () => {
    const allDead = new Map([...SPECIES_MAP].map(([k, v]) => [k, { ...v, enabled: v.slug === 'excl_ur' ? true : false }]));
    // Only a region-exclusive species is enabled and nothing pools her. The global
    // tier refuses exclusives, so every rarity is dead and the emergency path takes her.
    const r = describeRegionDistribution(input({ species: allDead, pool: [], defaultPool: [] }));
    expect(r.exhausted).toEqual({ probability: 1, fallback: 'emergency_region_exclusive' });
    expect(r.species).toEqual([]);
  });
});

describe('Buddy bonuses (hunt mode)', () => {
  const bonus = (b: Partial<BuddyBonus>): BuddyBonus => ({ name: 'x', flavorText: 'x', effectId: 'encounter_weight', value: 100, ...b }) as BuddyBonus;

  it('a rarity-scoped bonus moves the rarity table before the level shift', () => {
    const r = describeRegionDistribution(
      input({ mode: 'hunt', level: 40, buddyBonus: bonus({ target: { type: 'rarity', value: 'SR' } }) }),
    );
    // SR 10 → 20; N 60 → 59, R 25 → 26 (shift); total 110.
    expect(r.rarities.find((x) => x.rarity === 'SR')!.rollProbability).toBeCloseTo(20 / 110, 12);
    expect(r.rarities.find((x) => x.rarity === 'N')!.rollProbability).toBeCloseTo(59 / 110, 12);
  });

  it('race, affinity and ownership bonuses scale matching candidates inside their rarity', () => {
    const race = describeRegionDistribution(input({ mode: 'hunt', buddyBonus: bonus({ target: { type: 'race', value: 'demon' } }) }));
    // n_a 3, n_b 1 → n_b doubled to 2: shares 3/5 and 2/5.
    expect(race.species.find((s) => s.slug === 'n_b')!.shareOfRarity).toBeCloseTo(2 / 5, 12);
    const affinity = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ target: { type: 'affinity', value: 'dominant' } }) }),
    );
    // sr_a is alone in SR: a species bonus cannot change a single-member bucket.
    expect(affinity.species.find((s) => s.slug === 'sr_a')!.shareOfRarity).toBe(1);
    const owned = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ target: { type: 'ownership', value: 'owned' } }), ownedSpecies: new Set(['n_b']) }),
    );
    expect(owned.species.find((s) => s.slug === 'n_b')!.shareOfRarity).toBeCloseTo(2 / 5, 12);
    const unowned = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ target: { type: 'ownership', value: 'unowned' } }), ownedSpecies: new Set(['n_b']) }),
    );
    expect(unowned.species.find((s) => s.slug === 'n_a')!.shareOfRarity).toBeCloseTo(6 / 7, 12);
  });

  it('an item-find bonus shrinks the encounter share of a hunt', () => {
    const plain = describeRegionDistribution(input({ mode: 'hunt' }));
    expect(plain.encounterShare).toBeCloseTo(0.74, 12);
    const finder = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ effectId: 'hunt_item_find_chance', value: 100, target: undefined }) }),
    );
    expect(finder.encounterShare).toBeCloseTo(74 / 111, 12);
    expect(finder.species.find((s) => s.slug === 'n_a')!.perHunt).toBeCloseTo(0.45 * (74 / 111), 12);
  });

  it('scripted spawns ignore the Buddy', () => {
    const r = describeRegionDistribution(input({ buddyBonus: bonus({ target: { type: 'race', value: 'demon' } }) }));
    expect(r.species.find((s) => s.slug === 'n_b')!.shareOfRarity).toBeCloseTo(0.25, 12);
    expect(r.issues.map((i) => i.code)).toContain('buddy_ignored');
    expect(r.encounterShare).toBeNull();
  });

  it('reports a hunt that would throw instead of inventing odds', () => {
    const zeroing = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ value: -100, target: { type: 'rarity', value: 'SR' } }) }),
    );
    // A rarity weight of 0 is legal: SR is simply never rolled.
    expect(zeroing.errorProbability).toBe(0);
    expect(zeroing.rarities.find((x) => x.rarity === 'SR')!.rollProbability).toBe(0);
    const negative = describeRegionDistribution(
      input({ mode: 'hunt', buddyBonus: bonus({ value: -150, target: { type: 'race', value: 'demon' } }) }),
    );
    expect(negative.rarities.find((x) => x.rarity === 'N')!.unsafe).toBe(true);
    expect(negative.errorProbability).toBeCloseTo(0.6 * 0.74, 12);
    expect(negative.issues.map((i) => i.code)).toContain('unsafe_species_weights');
    expect(negative.species.some((s) => s.rarity === 'N')).toBe(false);
  });
});

describe('filtered World Encounter selectors', () => {
  it('conditions the rarity table on the matching rarities, with no fallback tier', () => {
    const r = describeRegionDistribution(
      input({ mode: 'filtered_selector', filter: { poolScope: 'region', rarities: ['SSR', 'LR'] } }),
    );
    expect(odds(r, 'ssr_a')).toBeCloseTo(4 / 4.1, 12);
    expect(odds(r, 'lr_a')).toBeCloseTo(0.1 / 4.1, 12);
    const none = describeRegionDistribution(
      input({ mode: 'filtered_selector', pool: [{ species: 'n_a', weight: 1 }], filter: { poolScope: 'region', rarities: ['SSR'] } }),
    );
    expect(none.species).toEqual([]);
    expect(none.issues.map((i) => i.code)).toEqual(['no_matching_species']);
  });

  it('global scope uses per-species weight for everyone, region exclusives only from the pool', () => {
    const r = describeRegionDistribution(input({ mode: 'filtered_selector', filter: { poolScope: 'global', rarities: ['N'] } }));
    // n_a has pool weight 3 but the global scope reads per_species_weight (1).
    expect(odds(r, 'n_a')).toBeCloseTo(0.5, 12);
    const ur = describeRegionDistribution(input({ mode: 'filtered_selector', filter: { poolScope: 'global', rarities: ['UR'] } }));
    expect(ur.species.map((s) => s.slug).sort()).toEqual(['g_ur', 'ur_a']);
  });

  it('falls back to uniform rarities when none of the present rarities has table weight', () => {
    const r = describeRegionDistribution(
      input({ mode: 'filtered_selector', pool: [{ species: 'ex_a', weight: 1 }], filter: { poolScope: 'region' } }),
    );
    expect(odds(r, 'ex_a')).toBe(1);
  });
});

describe('draft vs published', () => {
  it('reports per-species deltas and changed tiers', () => {
    const before = describeRegionDistribution(input());
    const after = describeRegionDistribution(input({ pool: FULL_POOL.filter((e) => e.species !== 'ssr_a') }));
    const diff = diffDistributions(before, after);
    expect(diff.rarities).toEqual([{ rarity: 'SSR', tierBefore: 'region', tierAfter: 'default_region' }]);
    expect(diff.species.find((d) => d.slug === 'ssr_a')!.delta).toBeCloseTo(-0.04, 12);
    expect(diff.species.find((d) => d.slug === 'v_ssr')!.delta).toBeCloseTo(0.04, 12);
  });
});
