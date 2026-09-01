/**
 * Thirstlands — the third released destination, end to end.
 *
 * Written against **shipped content** rather than a minted fixture, for the
 * same reason `flaccidFoothills.test.ts` is: the thing under test is that the
 * pack on disk is wired correctly. What is specific to Thirstlands is the
 * shape of its gate — it is the first destination that is stamped onto a pass
 * the player must *already* hold at a level well above the pass's own, so
 * "owns the Caravan Pass" and "is level 25" are two separate refusals rather
 * than one combined purchase.
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

const REGION = 'thirstlands';
const CHANNEL = 'chan-thirstlands';
/** Straight from `tables.json` — asserted, not assumed, in the first test. */
const ROUTE_PRICE = 2000;
const ROUTE_LEVEL = 25;

/** Every species the pack ships, read from content rather than hard-coded. */
let packSlugs: string[];
/** Every other pack's exclusives — what must never surface in a Thirstlands hunt. */
let foreignExclusives: string[];

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-thirstlands', 'u-thirstlands'));
  packSlugs = app.content.species
    .filter((s) => app.content.speciesOrigin[s.slug] === 'thirstlands')
    .map((s) => s.slug);
  expect(packSlugs.length).toBeGreaterThan(0);
  foreignExclusives = app.content.species
    .filter(
      (s) =>
        s.tags.includes('region_exclusive') &&
        app.content.speciesOrigin[s.slug] !== 'thirstlands',
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
    .set({ level: opts.level ?? 30, lastHuntAt: null })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 5000, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, opts.region ?? 'waifu-valley');
  if (opts.withPass) await app.travel.grantPass(playerId, 'caravan_pass');
}

beforeEach(() => resetPlayer());

describe('released destination', () => {
  it('appears in the Locations list, priced and gated', async () => {
    await resetPlayer({ withPass: true });
    const status = await app.travel.getStatus(playerId);
    const thirstlands = status.destinations.find((d) => d.regionId === REGION);
    expect(thirstlands).toBeDefined();
    expect(thirstlands!.name).toBe('Thirstlands');
    // Pass in hand and the level met: the only thing left is paying for the road.
    expect(thirstlands!.state).toBe('purchasable');
    expect(thirstlands!.price).toBe(ROUTE_PRICE);
    expect(thirstlands!.currency).toBe('waifubux');
    expect(thirstlands!.requiredLevel).toBe(ROUTE_LEVEL);
    expect(thirstlands!.passName).toBe('Caravan Pass');
    // The Caravan Pass covers Twin Peeks only; this route is stamped on
    // afterwards, so buying it is never a pass purchase in disguise.
    expect(thirstlands!.purchaseGrantsPass).toBe(false);
    expect(thirstlands!.passOwned).toBe(true);
    expect(thirstlands!.bannerImagePath).toBe('locations/thirstlands/banner.png');
  });

  it('is seeded with its own encounter pool, covering every resident', async () => {
    const rows = await t.db
      .select({ speciesId: regionEncounterPools.speciesId })
      .from(regionEncounterPools)
      .where(eq(regionEncounterPools.regionId, REGION));
    expect(rows).toHaveLength(packSlugs.length);
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
});

describe('the gate', () => {
  it('cannot be bought before the pass it stamps onto', async () => {
    // No pass: the destination is visible and priced, and refuses to sell.
    const view = await app.travel.getDestination(playerId, REGION);
    expect(view!.state).toBe('ineligible');
    expect(view!.requirements.join(' ')).toContain('Caravan Pass');
    await expect(app.travel.purchaseDestination(playerId, REGION)).rejects.toBeInstanceOf(
      TravelPassRequiredError,
    );
  });

  it('refuses the purchase below level 25, even with the pass', async () => {
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
  it('buys the route for exactly 2,000 WaifuBux, then walks there', async () => {
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

describe('its residents live there and nowhere else', () => {
  /**
   * Species slugs drawn across `count` hunts in the player's current region,
   * at a fixed rarity roll. Thirstlands ships an N and two Rs, so the rarity
   * has to be pinned: `hunt.rarityTable` also rolls SR and above, which no
   * Thirstlands entry covers and which therefore falls back to Waifu Valley's
   * pool by design.
   */
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

  it('draws only Thirstlands species at the rarities its pool covers', async () => {
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.every((slug) => packSlugs.includes(slug))).toBe(true);
    // Both buckets were reached, so this is not one species twelve times.
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it('never lets another region’s exclusives in', async () => {
    await resetPlayer({ region: REGION, withPass: true });
    const drawn = [...(await sample(6, N_ROLL)), ...(await sample(6, R_ROLL))];
    expect(drawn.some((slug) => foreignExclusives.includes(slug))).toBe(false);
  });

  it('never draws them from Waifu Valley, Twin Peeks or the Foothills', async () => {
    for (const region of ['waifu-valley', 'twin-peeks', 'flaccid-foothills'] as const) {
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
