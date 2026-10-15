/**
 * The Region Pool analyser against the real runtime.
 *
 * Each case draws thousands of times through the production code path — the
 * full `hunt()` transaction with a real Buddy, `pickSpeciesForSpawn`, or the
 * filtered species picker — and compares the counts with
 * `RegionPoolService.analyse` by Pearson chi-square (p > 0.001). Seeds are
 * fixed, so every run is the same run. Buddy bonuses are amplified in the
 * test's content snapshot so a mis-modelled modifier is a large, detectable
 * shift rather than noise.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playerCurrencies, species } from '../../src/db/schema';
import { createFilteredSpeciesPicker, raceResolverFromContent, type SpeciesFilter } from '../../src/modules/encounters/speciesSelection';
import { contentRegionCatalogue } from '../../src/modules/regionPools/regionCatalogue';
import type { DistributionResult } from '../../src/modules/regionPools/regionPoolDistribution';
import {
  createRegionPoolService,
  type AnalysisRequest,
  type RegionPoolService,
  type ReviewResult,
} from '../../src/modules/regionPools/regionPoolService';
import { seededRng } from '../../src/shared/random';
import { bootstrapApp, insertOwnedWaifu, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

const NON_ENCOUNTER = '(no encounter)';

/** Wilson–Hilferty: chi-square → approximate standard-normal z. */
function chiSquareZ(stat: number, df: number): number {
  const k = 2 / (9 * df);
  return (Math.cbrt(stat / df) - (1 - k)) / Math.sqrt(k);
}

/** Pearson chi-square of observed counts against expected probabilities, pooling cells under 5. */
function expectFits(expected: Map<string, number>, counts: Map<string, number>, n: number, label: string) {
  const total = [...expected.values()].reduce((s, p) => s + p, 0);
  expect(total, `${label}: expected probabilities sum`).toBeCloseTo(1, 9);
  for (const key of counts.keys()) expect(expected.has(key), `${label}: drew unexpected ${key}`).toBe(true);
  let stat = 0;
  let df = -1;
  let smallObs = 0;
  let smallExp = 0;
  for (const [key, p] of expected) {
    const e = p * n;
    const o = counts.get(key) ?? 0;
    if (e < 5) {
      smallObs += o;
      smallExp += e;
      continue;
    }
    stat += (o - e) ** 2 / e;
    df += 1;
  }
  if (smallExp > 0) {
    stat += (smallObs - smallExp) ** 2 / smallExp;
    df += 1;
  }
  expect(df, `${label}: degrees of freedom`).toBeGreaterThan(2);
  expect(chiSquareZ(stat, df), `${label}: chi-square ${stat.toFixed(1)} on ${df} df`).toBeLessThan(3.09);
}

function perEncounter(result: DistributionResult): Map<string, number> {
  return new Map(result.species.map((s) => [s.slug, s.perEncounter]));
}

const tally = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

interface World {
  t: TestDb;
  app: App;
  pools: RegionPoolService;
}

async function world(seed: number): Promise<World> {
  const t = await createTestDb();
  const app = await bootstrapApp(t, { huntRng: seededRng(seed) });
  const pools = createRegionPoolService({
    db: t.db,
    getContent: () => app.content,
    catalogue: contentRegionCatalogue(() => app.content),
    huntTables: app.content.tables,
  });
  return { t, app, pools };
}

async function publishEntries(pools: RegionPoolService, regionId: string, keep: (e: { species: string; rarity: string | null }) => boolean) {
  const view = await pools.get(regionId);
  const entries = view.draft.entries.filter(keep).map((e) => ({ species: e.species, weight: e.weight }));
  await pools.saveDraft(regionId, { entries, expectedDraftRevision: view.draft.revision }, 'test');
  const r = (await pools.validate(regionId, {})) as ReviewResult;
  await pools.publish(
    regionId,
    { expectedDraftRevision: r.draftRevision, reviewHash: r.reviewHash, acknowledgedWarnings: r.requiredAcknowledgements },
    'test',
  );
}

const analyse = async (pools: RegionPoolService, regionId: string, request: Partial<AnalysisRequest>) =>
  (await pools.analyse(regionId, { source: 'published', mode: 'hunt', level: 1, ...request })).result;

// ── Scripted spawns: rarity tables, levels, weights, fallbacks ───────────────

describe('scripted spawns (pickSpeciesForSpawn)', () => {
  let w: World;
  let playerId: number;
  beforeAll(async () => {
    w = await world(0x0dd5);
    ({ playerId } = await provisionPlayer(w.app, 'g-odds', 'u-spawn'));
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  async function draws(regionId: string, level: number, n: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) tally(counts, (await w.app.hunt.pickSpeciesForSpawn(w.t.db, playerId, level, regionId))!.slug);
    return counts;
  }

  it.each([
    ['twin-peeks', 1],
    ['twin-peeks', 40],
    ['thirstlands', 1],
    ['waifu-valley', 40],
  ] as const)('%s at level %i: every rarity at region-local weights', async (regionId, level) => {
    const result = await analyse(w.pools, regionId, { mode: 'scripted_spawn', level });
    expect(new Set(result.rarities.map((r) => r.tier))).toEqual(new Set(['region']));
    const n = 8000;
    expectFits(perEncounter(result), await draws(regionId, level, n), n, `${regionId} L${level}`);
  }, 120_000);

  it('Waifu Valley fallback for an emptied rarity, then the global table', async () => {
    // Twin Peeks loses SSR and UR; Waifu Valley loses UR. SSR now comes from the
    // valley, UR from every non-exclusive UR species.
    await publishEntries(w.pools, 'twin-peeks', (e) => e.rarity !== 'SSR' && e.rarity !== 'UR');
    await publishEntries(w.pools, 'waifu-valley', (e) => e.rarity !== 'UR');
    const result = await analyse(w.pools, 'twin-peeks', { mode: 'scripted_spawn', level: 1 });
    const tier = (r: string) => result.rarities.find((x) => x.rarity === r)!.tier;
    expect([tier('SSR'), tier('UR'), tier('N')]).toEqual(['default_region', 'global', 'region']);
    // Condition on the fallback rarities so the small tiers get statistical weight.
    const n = 40_000;
    const counts = await draws('twin-peeks', 1, n);
    expectFits(perEncounter(result), counts, n, 'fallback tiers');
    const valleySsr = new Set(result.species.filter((s) => s.rarity === 'SSR').map((s) => s.slug));
    const ssrDraws = [...counts].filter(([slug]) => valleySsr.has(slug)).reduce((s, [, c]) => s + c, 0);
    expect(ssrDraws / n).toBeCloseTo(0.04, 1);
  }, 240_000);
});

describe('dead rarities and exhausted rerolls', () => {
  let w: World;
  let playerId: number;
  beforeAll(async () => {
    w = await world(0xdead);
    ({ playerId } = await provisionPlayer(w.app, 'g-odds', 'u-dead'));
    // No N species anywhere: N is dead in every tier (d = 0.6 at level 1).
    await w.t.db.update(species).set({ enabled: false }).where(eq(species.rarity, 'N'));
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it('rerolls up to six times, then takes the default pool’s arbitrary row', async () => {
    const result = await analyse(w.pools, 'twin-peeks', { mode: 'scripted_spawn', level: 1 });
    expect(result.rarities.find((r) => r.rarity === 'N')!.tier).toBe('dead');
    expect(result.exhausted!.probability).toBeCloseTo(0.6 ** 6, 12);
    expect(result.exhausted!.fallback).toBe('default_pool_arbitrary');
    // The runtime's exhausted path is `LIMIT 1` with no ORDER BY: ask the same query which row that is.
    const [arbitrary] = (
      await w.t.db.execute<{ slug: string }>(sql`
        select s.slug from region_encounter_pools p join species s on s.id = p.species_id
        where p.region_id = 'waifu-valley' and s.enabled and not (s.tags @> '["dungeon_exclusive"]'::jsonb)
        limit 1`)
    ).rows;
    const expected = perEncounter(result);
    expected.set(arbitrary!.slug, (expected.get(arbitrary!.slug) ?? 0) + result.exhausted!.probability);
    const n = 8000;
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) tally(counts, (await w.app.hunt.pickSpeciesForSpawn(w.t.db, playerId, 1, 'twin-peeks'))!.slug);
    expectFits(expected, counts, n, 'exhausted');
  }, 120_000);
});

// ── Full hunts with a real Buddy ─────────────────────────────────────────────

describe('hunt() with a Buddy', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(0xb0dd1e);
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  /** Equip `buddySlug` (bonus amplified to `value`), own `extraOwned`, then hunt `n` times. */
  async function huntWith(opts: {
    user: string;
    regionId: string;
    level: number;
    buddySlug: string;
    value: number;
    extraOwned?: string[];
    n: number;
  }) {
    const authored = w.app.content.species.find((s) => s.slug === opts.buddySlug)!;
    authored.buddyBonus = { ...authored.buddyBonus!, value: opts.value };
    const { playerId } = await provisionPlayer(w.app, 'g-odds', opts.user);
    const ownedSlugs = [opts.buddySlug, ...(opts.extraOwned ?? [])];
    let buddyWaifu = 0;
    for (const slug of ownedSlugs) {
      const [row] = await w.t.db.select({ id: species.id }).from(species).where(eq(species.slug, slug));
      const waifu = await insertOwnedWaifu(w.t.db, { playerId, speciesId: row!.id });
      if (slug === opts.buddySlug) buddyWaifu = waifu.id;
    }
    await w.app.collection.setBuddy(playerId, buddyWaifu);
    await w.t.db.execute(sql`update players set current_region = ${opts.regionId}, level = ${opts.level} where id = ${playerId}`);
    await w.t.db.update(playerCurrencies).set({ huntEnergy: 1_000_000 }).where(eq(playerCurrencies.playerId, playerId));

    const result = await analyse(w.pools, opts.regionId, {
      mode: 'hunt',
      level: opts.level,
      buddySpecies: opts.buddySlug,
      ownedSpecies: ownedSlugs,
    });
    const expected = new Map(result.species.map((s) => [s.slug, s.perHunt!]));
    expected.set(NON_ENCOUNTER, 1 - result.encounterShare!);

    const counts = new Map<string, number>();
    let now = Date.UTC(2026, 9, 15);
    for (let i = 0; i < opts.n; i++) {
      // Ten minutes apart: past the cooldown and the 120 s encounter expiry.
      now += 600_000;
      const hunt = await w.app.hunt.hunt(playerId, 'c-odds', new Date(now));
      tally(counts, hunt.kind === 'encounter' ? hunt.species.slug : NON_ENCOUNTER);
    }
    return { result, expected, counts };
  }

  it('a rarity-scoped bonus (+400% SR) at level 40', async () => {
    const { result, expected, counts } = await huntWith({
      user: 'u-rarity',
      regionId: 'twin-peeks',
      level: 40,
      buddySlug: 'bimbo_valkyrie',
      value: 400,
      n: 4000,
    });
    expect(result.rarities.find((r) => r.rarity === 'SR')!.effectiveWeight).toBe(50);
    expectFits(expected, counts, 4000, 'rarity buddy');
  }, 240_000);

  it('a race-scoped bonus (+400% human)', async () => {
    const { result, expected, counts } = await huntWith({
      user: 'u-race',
      regionId: 'waifu-valley',
      level: 1,
      buddySlug: 'rainy_day_idol',
      value: 400,
      n: 4000,
    });
    expect(result.species.some((s) => s.effectiveWeight !== s.weight)).toBe(true);
    expectFits(expected, counts, 4000, 'race buddy');
  }, 240_000);

  it('an affinity-scoped bonus (+400% dominant)', async () => {
    const { result, expected, counts } = await huntWith({
      user: 'u-affinity',
      regionId: 'flaccid-foothills',
      level: 1,
      buddySlug: 'demon_hall_monitor',
      value: 400,
      n: 4000,
    });
    expect(result.species.some((s) => s.effectiveWeight !== s.weight)).toBe(true);
    expectFits(expected, counts, 4000, 'affinity buddy');
  }, 240_000);

  it('an ownership bonus (+400% owned) with owned species in the pool', async () => {
    const view = await w.pools.get('thirstlands');
    const ownedN = view.published!.entries.filter((e) => e.rarity === 'N').slice(0, 4).map((e) => e.species);
    const { result, expected, counts } = await huntWith({
      user: 'u-owned',
      regionId: 'thirstlands',
      level: 1,
      buddySlug: 'android_secretary',
      value: 400,
      extraOwned: ownedN,
      n: 4000,
    });
    expect(result.species.filter((s) => ownedN.includes(s.slug)).every((s) => s.effectiveWeight === s.weight * 5)).toBe(true);
    expectFits(expected, counts, 4000, 'ownership buddy');
  }, 240_000);

  it('an item-find bonus (+400%) shrinks the encounter share per hunt', async () => {
    const { result, expected, counts } = await huntWith({
      user: 'u-items',
      regionId: 'base-80085',
      level: 1,
      buddySlug: 'alley_catgirl',
      value: 400,
      n: 4000,
    });
    expect(result.encounterShare).toBeCloseTo(74 / (74 + 8 * 5 + 8 + 5 + 3 * 5 + 2), 12);
    expectFits(expected, counts, 4000, 'item-find buddy');
  }, 240_000);
});

// ── Filtered World Encounter selectors ───────────────────────────────────────

describe('filtered selectors (pickFilteredCandidate)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(0xf11e);
  });
  afterAll(async () => {
    await w.t.cleanup();
  });

  it.each([
    ['twin-peeks', { poolScope: 'region', rarities: ['SR', 'LR'] }, 1],
    ['waifu-valley', { poolScope: 'region', affinities: ['dominant', 'primal'] }, 40],
    ['thirstlands', { poolScope: 'global', races: ['demon'] }, 1],
  ] as const)('%s %j at level %i', async (regionId, filter, level) => {
    const picker = createFilteredSpeciesPicker({
      resolveRace: raceResolverFromContent(() => w.app.content),
      rarityWeightsFor: (lvl) => w.app.hunt.spawnRarityWeights(lvl),
      rng: seededRng(0x5e1 + level),
    });
    const result = (
      await w.pools.analyse(regionId, { source: 'published', mode: 'filtered_selector', level, filter: filter as unknown as SpeciesFilter })
    ).result;
    expect(result.species.length).toBeGreaterThan(3);
    const n = 6000;
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const pick = await picker(w.t.db, filter as unknown as SpeciesFilter, { regionId, playerLevel: level });
      if (pick.status !== 'selected') throw new Error('no candidates');
      tally(counts, pick.species.slug);
    }
    expectFits(perEncounter(result), counts, n, `${regionId} selector`);
  }, 120_000);

  it('differs from the hunt where the algorithms differ: no fallback tier', async () => {
    await publishEntries(w.pools, 'twin-peeks', (e) => e.rarity !== 'LR');
    const selector = (
      await w.pools.analyse('twin-peeks', {
        source: 'published',
        mode: 'filtered_selector',
        level: 1,
        filter: { poolScope: 'region', rarities: ['LR'] },
      })
    ).result;
    expect(selector.species).toEqual([]);
    expect(selector.issues.map((i) => i.code)).toEqual(['no_matching_species']);
    const hunt = await analyse(w.pools, 'twin-peeks', { mode: 'scripted_spawn' });
    expect(hunt.rarities.find((r) => r.rarity === 'LR')!.tier).toBe('default_region');
  });
});
