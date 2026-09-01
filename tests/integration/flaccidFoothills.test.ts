/**
 * Flaccid Foothills — the released-destination pass, end to end.
 *
 * Unlike `regionalHunt.test.ts`, which mints its own species so a distribution
 * can be reasoned about exactly, this file runs against **shipped content**:
 * the point of the exercise is that the pack on disk is wired correctly, not
 * that the framework works in the abstract. What it asserts is the whole shape
 * of a paid destination — hidden behind a gate, bought once, walked to, and
 * carrying residents who exist nowhere else.
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
} from '../../src/db/schema';
import { seedContent } from '../../src/modules/content/seeder';
import { createHuntService, type HuntService } from '../../src/modules/hunt/huntService';
import {
  InsufficientFundsError,
  RegionLockedError,
  TravelLevelRequiredError,
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

const REGION = 'flaccid-foothills';
const CHANNEL = 'chan-foothills';
/** Straight from `tables.json` — asserted, not assumed, in the first test. */
const ROUTE_PRICE = 1500;
const ROUTE_LEVEL = 20;

/** Every species the pack ships, read from content rather than hard-coded. */
let packSlugs: string[];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-foothills', 'u-foothills'));
  packSlugs = app.content.species
    .filter((s) => app.content.speciesOrigin[s.slug] === 'flaccid_foothills')
    .map((s) => s.slug);
  expect(packSlugs.length).toBeGreaterThan(0);
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
    .set({ level: opts.level ?? 30, lastHuntAt: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 5000, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, opts.region ?? 'waifu-valley');
  // The Foothills route stamps onto a pass the player must already hold, so
  // most cases start from "owns the Caravan Pass, has not bought this road".
  if (opts.withPass) await app.travel.grantPass(playerId, 'caravan_pass');
}

beforeEach(() => resetPlayer());

describe('released destination', () => {
  it('appears in the Locations list, priced and gated', async () => {
    await resetPlayer({ withPass: true });
    const status = await app.travel.getStatus(playerId);
    const foothills = status.destinations.find((d) => d.regionId === REGION);
    expect(foothills).toBeDefined();
    expect(foothills!.name).toBe('Flaccid Foothills');
    // Pass in hand and the level met: the only thing left is paying for the road.
    expect(foothills!.state).toBe('purchasable');
    expect(foothills!.price).toBe(ROUTE_PRICE);
    expect(foothills!.currency).toBe('waifubux');
    expect(foothills!.requiredLevel).toBe(ROUTE_LEVEL);
    expect(foothills!.passName).toBe('Caravan Pass');
    // The Caravan Pass covers Twin Peeks; this route is stamped on afterwards,
    // so buying it is never a pass purchase in disguise.
    expect(foothills!.purchaseGrantsPass).toBe(false);
    expect(foothills!.passOwned).toBe(true);
    expect(foothills!.bannerImagePath).toBe('locations/flaccid-foothills/banner.png');
  });

  it('cannot be bought before the pass it stamps onto', async () => {
    // No pass: the destination is visible and priced, and refuses to sell.
    const view = await app.travel.getDestination(playerId, REGION);
    expect(view!.state).toBe('ineligible');
    expect(view!.requirements.join(' ')).toContain('Caravan Pass');
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toThrow();
  });

  it('is seeded with its own encounter pool', async () => {
    const rows = await t.db
      .select({ speciesId: regionEncounterPools.speciesId })
      .from(regionEncounterPools)
      .where(eq(regionEncounterPools.regionId, REGION));
    expect(rows).toHaveLength(packSlugs.length);
  });
});

describe('the gate', () => {
  it('refuses the purchase below the required level', async () => {
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
  it('buys the route once, then walks there', async () => {
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
  });
});

describe('its residents live there and nowhere else', () => {
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

  /** Species slugs drawn across `count` hunts in the player's current region. */
  async function sample(count: number): Promise<string[]> {
    const slugs: string[] = [];
    for (let i = 0; i < count; i++) {
      await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
      await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));
      await t.db
        .update(playerCurrencies)
        .set({ huntEnergy: 50 })
        .where(eq(playerCurrencies.playerId, playerId));
      // 0 → 'encounter', 0 → the commonest rarity, then walk the species pick.
      const result = await huntWith([0, 0, (i + 0.5) / count]).hunt(playerId, CHANNEL);
      expect(result.kind).toBe('encounter');
      slugs.push((result as { species: { slug: string } }).species.slug);
    }
    return slugs;
  }

  it('draws only Foothills species while standing in the Foothills', async () => {
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = await sample(12);
    expect(drawn.every((slug) => packSlugs.includes(slug))).toBe(true);
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it('never draws them from Waifu Valley or Twin Peeks', async () => {
    for (const region of ['waifu-valley', 'twin-peeks'] as const) {
      await resetPlayer({ region });
      const drawn = await sample(12);
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
      const drawn = await sample(12);
      expect(drawn.some((slug) => packSlugs.includes(slug))).toBe(false);
    } finally {
      // Restored by the real seeder rather than by a hand-rolled copy of it:
      // it rebuilds both region tables from content on every run, so this puts
      // back exactly what bootstrapping wrote.
      await seedContent(t.db, app.content, t.logger);
    }
  });
});
