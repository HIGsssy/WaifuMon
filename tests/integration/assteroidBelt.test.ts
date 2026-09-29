/**
 * Assteroid Belt — the sixth paid destination, released after Base 80085, end
 * to end.
 *
 * Written against **shipped content**, like `base80085.test.ts`, whose shape
 * this file follows because the Belt's pool has the same structure: its fifteen
 * exclusives plus a tail of non-exclusive Waifu Valley residents. That tail
 * deliberately overlaps Base 80085's — the first pool overlap in the game — so
 * the rules under test are the pair that define exclusivity:
 *
 *   - a hunt in the Belt draws only from the Belt pool;
 *   - a Belt exclusive is drawn **nowhere else**, pools or no pools.
 *
 * A shared starter appearing in both space zones is not a leak. A tagged
 * species appearing in two pools is the bug this file exists to catch.
 *
 * Access is a Transporter Beacon key item rather than a Caravan Pass route;
 * the gate is exercised here only as far as the region needs it, and in full
 * (recipe, construction, concurrency) in `transporterBeacon.test.ts`.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  items,
  playerCurrencies,
  playerInventory,
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
  InsufficientEnergyError,
  KeyItemRequiredError,
  TravelBlockedByCareModeError,
  TravelBlockedByEncounterError,
  TravelLevelRequiredError,
} from '../../src/shared/errors';
import { TRAVEL_ENERGY_COST } from '../../src/modules/travel/travelService';
import {
  bootstrapApp,
  forceRegion,
  insertOwnedWaifu,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

const REGION = 'assteroid-belt';
const EXPANSION = 'assteroid_belt';
const CHANNEL = 'chan-assteroid-belt';
/** Straight from `tables.json` — asserted, not assumed, in the first test. */
const BEACON_COST = 1500;
const ROUTE_LEVEL = 35;
const BEACON = 'transporter_beacon';

/** The exclusives the pack ships, read from content rather than hard-coded. */
let packSlugs: string[];
/** Every slug the region's pool stocks — exclusives and borrowed core alike. */
let pooledSlugs: string[];
/** Every other pack's exclusives — what must never surface in a Belt hunt. */
let foreignExclusives: string[];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-assteroid-belt', 'u-assteroid-belt'));
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
 * Back to nothing owned: no pass, no routes, no items, a level and a balance
 * the caller chooses. Entitlements are reset too, so no test can be carried by
 * what an earlier one bought.
 */
async function resetPlayer(
  opts: { level?: number; waifubux?: number; region?: string; withBeacon?: boolean } = {},
): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db
    .update(players)
    .set({
      level: opts.level ?? ROUTE_LEVEL,
      lastHuntAt: null,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 6000, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, opts.region ?? 'waifu-valley');
  // The admin grant of a key-item destination hands over the key itself.
  if (opts.withBeacon) await app.travel.grantRoute(playerId, REGION);
}

async function beaconCount(): Promise<number> {
  const [row] = await t.db
    .select({ quantity: playerInventory.quantity })
    .from(playerInventory)
    .innerJoin(items, eq(items.id, playerInventory.itemId))
    .where(and(eq(playerInventory.playerId, playerId), eq(items.slug, BEACON)));
  return row?.quantity ?? 0;
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

  it('appears in the Locations list, gated on the Transporter Beacon', async () => {
    const status = await app.travel.getStatus(playerId);
    const belt = status.destinations.find((d) => d.regionId === REGION);
    expect(belt).toBeDefined();
    expect(belt!.name).toBe('Assteroid Belt');
    // Level met, beacon missing: the key is the only thing in the way.
    expect(belt!.state).toBe('key_required');
    expect(belt!.price).toBe(BEACON_COST);
    expect(belt!.currency).toBe('waifubux');
    expect(belt!.requiredLevel).toBe(ROUTE_LEVEL);
    // Not a Caravan Pass route any more, so nothing pass-shaped is offered.
    expect(belt!.passName).toBeNull();
    expect(belt!.purchaseGrantsPass).toBe(false);
    expect(belt!.keyItem!.name).toBe('Transporter Beacon');
    expect(belt!.keyItem!.owned).toBe(false);
    // Authored ahead of the file itself: a missing banner renders text-only.
    expect(belt!.bannerImagePath).toBe('locations/assteroid-belt/banner.png');
  });

  it('lists last, after every destination released before it', async () => {
    const status = await app.travel.getStatus(playerId);
    const ids = status.destinations.map((d) => d.regionId);
    expect(ids.at(-1)).toBe(REGION);
    // Released after Base 80085, so it must list after it too.
    expect(ids.indexOf('base-80085')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(REGION)).toBeGreaterThan(ids.indexOf('base-80085'));
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
  it('is built, never bought — the purchase path refuses and writes nothing', async () => {
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toBeInstanceOf(
      KeyItemRequiredError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(6000);
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes).toEqual([]);
  });

  it('refuses travel without the beacon', async () => {
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(KeyItemRequiredError);
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('ignores a leftover route row — the beacon is the only key', async () => {
    // Every pre-beacon purchase left a route row behind. Migration turned those
    // into beacons; a bare row on its own must not open the road.
    await t.db.insert(playerUnlockedRoutes).values({ playerId, regionId: REGION });
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(KeyItemRequiredError);
    expect((await app.travel.getDestination(playerId, REGION))!.state).toBe('key_required');
  });

  it('refuses travel below level 35, even with the beacon', async () => {
    await resetPlayer({ level: ROUTE_LEVEL - 1, withBeacon: true });
    const view = await app.travel.getDestination(playerId, REGION);
    expect(view!.state).toBe('ineligible');
    expect(view!.requirements.join(' ')).toContain(String(ROUTE_LEVEL));
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(
      TravelLevelRequiredError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });
});

describe('unlock and travel', () => {
  it('walks there and back with the beacon, which is never used up', async () => {
    await resetPlayer({ withBeacon: true });
    expect(await beaconCount()).toBe(1);
    expect((await app.travel.getDestination(playerId, REGION))!.state).toBe('unlocked');

    await app.travel.travel(playerId, REGION);
    expect(await app.travel.getCurrentRegion(playerId)).toBe(REGION);
    const status = await app.travel.getStatus(playerId);
    expect(status.destinations.find((d) => d.regionId === REGION)!.state).toBe('current');

    // The way home is always open: the starting region needs no route.
    await app.travel.travel(playerId, 'waifu-valley');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
    await app.travel.travel(playerId, REGION);
    expect(await beaconCount()).toBe(1);
  });

  it('charges the normal Energy for the trip, and nothing in WaifuBux', async () => {
    await resetPlayer({ withBeacon: true });
    const bux = (await app.currency.getBalances(playerId)).waifubux;
    const outcome = await app.travel.travel(playerId, REGION);
    expect(outcome.energySpent).toBe(TRAVEL_ENERGY_COST);
    expect(outcome.energyRemaining).toBe(50 - TRAVEL_ENERGY_COST);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(bux);
  });

  it('refuses the trip at 0 Energy, beacon or no beacon', async () => {
    await resetPlayer({ withBeacon: true });
    await t.db
      .update(playerCurrencies)
      .set({ huntEnergy: 0 })
      .where(eq(playerCurrencies.playerId, playerId));
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(
      InsufficientEnergyError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('refuses the trip in Care Mode, even with Energy in the tank', async () => {
    await resetPlayer({ withBeacon: true });
    const [anySpecies] = await t.db.select().from(speciesTable).limit(1);
    const waifu = await insertOwnedWaifu(t.db, { playerId, speciesId: anySpecies!.id });
    await app.care.start(playerId, waifu.id);
    await expect(app.travel.travel(playerId, REGION)).rejects.toBeInstanceOf(
      TravelBlockedByCareModeError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('still refuses to move mid-encounter, beacon or no beacon', async () => {
    // Releasing a region must not open a side door out of an unresolved hunt.
    await resetPlayer({ withBeacon: true });
    const result = await huntWith([0, 0, 0.5]).hunt(playerId, CHANNEL);
    expect(result.kind).toBe('encounter');
    // The hunt's XP grant re-derives `level` from this fixture's zero XP.
    // Restore it: the Belt checks its level gate on the trip, and this test is
    // about the encounter block, not the level one.
    await t.db.update(players).set({ level: ROUTE_LEVEL }).where(eq(players.id, playerId));
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

  it('draws only from the Belt pool', async () => {
    await resetPlayer({ region: REGION, withBeacon: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.every((slug) => pooledSlugs.includes(slug))).toBe(true);
    // Both buckets were reached, so this is not one species twelve times.
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it('reaches the pack’s own exclusives, not just its borrowed valley stock', async () => {
    // A pool that stocks core species could in principle drown the exclusives.
    // If the pack is unreachable in practice, the region ships as decoration.
    await resetPlayer({ region: REGION, withBeacon: true });
    const drawn = [...(await sample(12, N_ROLL)), ...(await sample(12, R_ROLL))];
    expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(true);
  });

  it('never lets another region’s exclusives in', async () => {
    await resetPlayer({ region: REGION, withBeacon: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.some((slug) => foreignExclusives.includes(slug))).toBe(false);
  });

  it('never draws its exclusives from any region released before it', async () => {
    for (const region of [
      'waifu-valley',
      'twin-peeks',
      'flaccid-foothills',
      'thirstlands',
      'base-80085',
    ] as const) {
      await resetPlayer({ region });
      const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
      expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(false);
    }
  });

  it('shares only non-exclusive species with Base 80085', () => {
    // The overlap is intentional: both space zones borrow the newest valley
    // starters. It stays legal only while none of them is region-exclusive.
    const base = app.content.regions.find((r) => r.id === 'base-80085')!;
    const shared = base.encounterPool
      .map((e) => e.species)
      .filter((slug) => pooledSlugs.includes(slug));
    expect(shared.length).toBeGreaterThan(0);
    for (const slug of shared) {
      const s = app.content.species.find((x) => x.slug === slug)!;
      expect(s.tags, slug).not.toContain('region_exclusive');
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
