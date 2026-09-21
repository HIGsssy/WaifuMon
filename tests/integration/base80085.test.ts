/**
 * Base 80085 — the fourth released destination, end to end.
 *
 * Written against **shipped content** rather than a minted fixture, for the
 * same reason `thirstlands.test.ts` is: the thing under test is that the pack
 * on disk is wired correctly, not that a hand-built region would work.
 *
 * What is specific to Base 80085 is the shape of its **pool**. Every released
 * region before it pooled only its own exclusives; this one stocks its fifteen
 * exclusives *and* fifteen non-exclusive Waifu Valley residents, which is how
 * it fills the rarity buckets its own roster does not reach. So the rule under
 * test here is not "only pack species may be drawn" — it is the pair that
 * actually defines exclusivity:
 *
 *   - a hunt in Base 80085 draws only from the Base 80085 pool;
 *   - a Base 80085 exclusive is drawn **nowhere else**, pools or no pools.
 *
 * A non-exclusive species appearing in two regions is not a leak. A tagged one
 * appearing in two is the bug this file exists to catch.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  playerCurrencies,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  regionEncounterPools,
  species as speciesTable,
} from '../../src/db/schema';
import { seedContent } from '../../src/modules/content/seeder';
import { createHuntService, type HuntService } from '../../src/modules/hunt/huntService';
import { REGIONS, isRegion } from '../../src/modules/locations/regions';
import {
  InsufficientFundsError,
  RegionLockedError,
  TravelBlockedByEncounterError,
  TravelLevelRequiredError,
  TravelPassRequiredError,
} from '../../src/shared/errors';
import {
  bootstrapApp,
  forceRegion,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

const REGION = 'base-80085';
const EXPANSION = 'base_80085';
const CHANNEL = 'chan-base-80085';
/** Straight from `tables.json` — asserted, not assumed, in the first test. */
const ROUTE_PRICE = 2500;
const ROUTE_LEVEL = 30;

/** The exclusives the pack ships, read from content rather than hard-coded. */
let packSlugs: string[];
/** Every slug the region's pool stocks — exclusives and borrowed core alike. */
let pooledSlugs: string[];
/** Every other pack's exclusives — what must never surface in a Base 80085 hunt. */
let foreignExclusives: string[];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-base-80085', 'u-base-80085'));
  packSlugs = app.content.species
    .filter((s) => app.content.speciesOrigin[s.slug] === EXPANSION)
    .map((s) => s.slug);
  expect(packSlugs.length).toBeGreaterThan(0);
  const region = app.content.regions.find((r) => r.id === REGION);
  expect(region).toBeDefined();
  pooledSlugs = region!.encounterPool.map((e) => e.species);
  // The premise of this file: the pool is genuinely wider than the pack.
  expect(pooledSlugs.length).toBeGreaterThan(packSlugs.length);
  foreignExclusives = app.content.species
    .filter(
      (s) =>
        s.tags.includes('region_exclusive') && app.content.speciesOrigin[s.slug] !== EXPANSION,
    )
    .map((s) => s.slug);
  expect(foreignExclusives.length).toBeGreaterThan(0);
});

afterAll(async () => {
  await t.cleanup();
});

/**
 * Back to nothing owned: no pass, no routes, a level and a balance the caller
 * chooses. Entitlements are reset too, so no test can be carried by what an
 * earlier one bought.
 */
async function resetPlayer(
  opts: { level?: number; waifubux?: number; region?: string; withPass?: boolean } = {},
): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, playerId));
  await t.db
    .update(players)
    .set({ level: opts.level ?? 35, lastHuntAt: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 6000, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, opts.region ?? 'waifu-valley');
  if (opts.withPass) await app.travel.grantPass(playerId, 'caravan_pass');
}

beforeEach(() => resetPlayer());

describe('released destination', () => {
  it('is a storable region, not merely a content one', () => {
    // Enabling the region file is only half a release: every column holding a
    // region carries a CHECK against REGIONS, so a region content names but
    // the database refuses would fail on the first trip rather than at boot.
    expect(REGIONS).toContain(REGION);
    expect(isRegion(REGION)).toBe(true);
  });

  it('appears in the Locations list, priced and gated', async () => {
    await resetPlayer({ withPass: true });
    const status = await app.travel.getStatus(playerId);
    const base = status.destinations.find((d) => d.regionId === REGION);
    expect(base).toBeDefined();
    expect(base!.name).toBe('Base 80085');
    // Pass in hand and the level met: the only thing left is paying for the road.
    expect(base!.state).toBe('purchasable');
    expect(base!.price).toBe(ROUTE_PRICE);
    expect(base!.currency).toBe('waifubux');
    expect(base!.requiredLevel).toBe(ROUTE_LEVEL);
    expect(base!.passName).toBe('Caravan Pass');
    // The Caravan Pass covers Twin Peeks only; this route is stamped on
    // afterwards, so buying it is never a pass purchase in disguise.
    expect(base!.purchaseGrantsPass).toBe(false);
    expect(base!.passOwned).toBe(true);
    expect(base!.bannerImagePath).toBe('locations/base-80085/banner.png');
  });

  it('lists last, after every destination released before it', async () => {
    await resetPlayer({ withPass: true });
    const status = await app.travel.getStatus(playerId);
    const ids = status.destinations.map((d) => d.regionId);
    expect(ids.at(-1)).toBe(REGION);
    expect(ids).toContain('thirstlands');
  });

  it('is seeded with its own encounter pool, covering every entry', async () => {
    const rows = await t.db
      .select({ speciesId: regionEncounterPools.speciesId })
      .from(regionEncounterPools)
      .where(eq(regionEncounterPools.regionId, REGION));
    // Seeding is what turns the region file into a huntable place; a pool that
    // seeded short is a region that quietly falls back to the valley.
    expect(rows).toHaveLength(pooledSlugs.length);
  });

  it('ships its residents enabled, on canonical artwork paths', async () => {
    // The Portal and the card renderer both resolve artwork from this column,
    // so an `expansions/…` path here would render nowhere despite validating.
    for (const slug of packSlugs) {
      const [row] = await t.db
        .select({ enabled: speciesTable.enabled, imagePath: speciesTable.imagePath })
        .from(speciesTable)
        .where(eq(speciesTable.slug, slug));
      expect(row).toBeDefined();
      expect(row!.enabled).toBe(true);
      expect(row!.imagePath).toBe(`waifumon/${slug}/standard.png`);
    }
  });

  it('tags every resident with the zone the Portal filters on', () => {
    // The Portal's region filter reads species tags, not the pack directory.
    // Without this tag the pack is huntable but unfindable in the collection.
    for (const slug of packSlugs) {
      const s = app.content.species.find((x) => x.slug === slug)!;
      expect(s.tags).toContain('expansion');
      expect(s.tags).toContain('region_exclusive');
      expect(s.tags).toContain(EXPANSION);
    }
  });
});

describe('the gate', () => {
  it('cannot be bought before the pass it stamps onto', async () => {
    const view = await app.travel.getDestination(playerId, REGION);
    expect(view!.state).toBe('ineligible');
    expect(view!.requirements.join(' ')).toContain('Caravan Pass');
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toBeInstanceOf(
      TravelPassRequiredError,
    );
  });

  it('refuses the purchase below level 30, even with the pass', async () => {
    await resetPlayer({ level: ROUTE_LEVEL - 1, withPass: true });
    const view = await app.travel.getDestination(playerId, REGION);
    expect(view!.state).toBe('ineligible');
    expect(view!.requirements.join(' ')).toContain(String(ROUTE_LEVEL));
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toBeInstanceOf(
      TravelLevelRequiredError,
    );
  });

  it('refuses the purchase without the price, and charges nothing', async () => {
    await resetPlayer({ waifubux: ROUTE_PRICE - 1, withPass: true });
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(ROUTE_PRICE - 1);
  });

  it('refuses travel while the route is locked', async () => {
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(RegionLockedError);
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });
});

describe('unlock and travel', () => {
  it('buys the route for exactly 2,500 WaifuBux, then walks there and back', async () => {
    await resetPlayer({ withPass: true });
    const before = (await app.currency.getBalances(playerId)).waifubux;
    const outcome = await app.travel.purchaseDestination(playerId, REGION);
    // The route's own fee, not the pass price — the pass was already held.
    expect(outcome.amount).toBe(ROUTE_PRICE);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(before - ROUTE_PRICE);

    const routes = await t.db
      .select({ regionId: playerUnlockedRoutes.regionId })
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes.map((r) => r.regionId)).toContain(REGION);

    // Buying a road is not walking down it — the move is its own action.
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
    await app.travel.travel(playerId, REGION);
    expect(await app.travel.getCurrentRegion(playerId)).toBe(REGION);
    const status = await app.travel.getStatus(playerId);
    expect(status.destinations.find((d) => d.regionId === REGION)!.state).toBe('current');

    // The way home is always open: the starting region needs no route.
    await app.travel.travel(playerId, 'waifu-valley');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('still refuses to move mid-encounter, route or no route', async () => {
    // Releasing a region must not open a side door out of an unresolved hunt.
    await resetPlayer({ withPass: true });
    await app.travel.purchaseDestination(playerId, REGION);
    const result = await huntWith([0, 0, 0.5]).hunt(playerId, CHANNEL);
    expect(result.kind).toBe('encounter');
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(
      TravelBlockedByEncounterError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });
});

/**
 * A hunt whose RNG is scripted `[resultKind, rarity, speciesPick]`. No
 * `energy_save_chance` buddy is equipped, so no proc draw is taken and the
 * script starts at the result-table roll.
 */
function huntWith(nexts: number[]): HuntService {
  return createHuntService({
    db: t.db,
    currency: app.currency,
    inventory: app.inventory,
    progression: app.progression,
    collection: app.collection,
    care: app.care,
    quests: app.quests,
    tables: app.content.tables,
    buddyBonus: app.buddyBonus,
    logger: t.logger,
    rng: scriptedRng(nexts),
  });
}

describe('hunting the region', () => {
  /** Species slugs drawn across `count` hunts in the player's current region. */
  async function sample(count: number, rarityRoll: number): Promise<string[]> {
    const slugs: string[] = [];
    for (let i = 0; i < count; i++) {
      await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
      await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
      await t.db
        .update(playerCurrencies)
        .set({ huntEnergy: 50 })
        .where(eq(playerCurrencies.playerId, playerId));
      // 0 → 'encounter', then the pinned rarity, then walk the species pick.
      const result = await huntWith([0, rarityRoll, (i + 0.5) / count]).hunt(playerId, CHANNEL);
      expect(result.kind).toBe('encounter');
      slugs.push((result as { species: { slug: string } }).species.slug);
    }
    return slugs;
  }

  /** 0 → the N bucket; 0.7 → the R bucket, given the shipped rarity weights. */
  const N_ROLL = 0;
  const R_ROLL = 0.7;

  it('draws only from the Base 80085 pool', async () => {
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.every((slug) => pooledSlugs.includes(slug))).toBe(true);
    // Both buckets were reached, so this is not one species twelve times.
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it('reaches the pack’s own exclusives, not just its borrowed valley stock', async () => {
    // A pool that stocks core species could in principle drown the exclusives.
    // If the pack is unreachable in practice, the region ships as decoration.
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = [...(await sample(12, N_ROLL)), ...(await sample(12, R_ROLL))];
    expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(true);
  });

  it('never lets another region’s exclusives in', async () => {
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.some((slug) => foreignExclusives.includes(slug))).toBe(false);
  });

  it('never draws its exclusives from any region released before it', async () => {
    for (const region of ['waifu-valley', 'twin-peeks', 'flaccid-foothills', 'thirstlands'] as const) {
      await resetPlayer({ region });
      const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
      expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(false);
    }
  });

  it('is unreachable through the global fallback, even with every pool gone', async () => {
    // The belt-and-braces half of exclusivity: `region_exclusive` makes the
    // region-blind fallback refuse her, so an empty pool table degrades into
    // "the old game" rather than into handing out paid content for free.
    await t.db.delete(regionEncounterPools);
    try {
      await resetPlayer({ region: 'waifu-valley' });
      const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
      expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(false);
    } finally {
      // Restored by the real seeder rather than by a hand-rolled copy of it:
      // it rebuilds both region tables from content on every run, so this puts
      // back exactly what bootstrapping wrote.
      await seedContent(t.db, app.content, t.logger);
    }
  });
});
