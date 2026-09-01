/**
 * Locations & Travel integration — real Postgres, real transactions.
 *
 * The money and grant paths are the point: every assertion here is about
 * atomicity (a refusal costs nothing) or about the database being the last
 * word on uniqueness (a double-click cannot double-charge). Eligibility logic
 * itself is unit-tested in `travelEligibility.test.ts`; this file checks that
 * the rules survive contact with concurrency.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encounters,
  items,
  playerCurrencies,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
  regionEncounterPools,
  regionShopItems,
  species,
  travelTransactions,
} from '../../src/db/schema';
import {
  AlreadyInRegionError,
  InsufficientFundsError,
  RegionLockedError,
  RegionNotFoundError,
  ItemNotSoldHereError,
  RouteAlreadyUnlockedError,
  TravelBlockedByEncounterError,
  TravelLevelRequiredError,
} from '../../src/shared/errors';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

const PASS_PRICE = 1000;
const PASS_LEVEL = 15;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

/** A player at a known level, balance, region, and with nothing unlocked. */
async function resetPlayer(
  playerId: number,
  opts: { level?: number; waifubux?: number; region?: string } = {},
): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(travelTransactions).where(eq(travelTransactions.playerId, playerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, playerId));
  await t.db
    .update(players)
    .set({ level: opts.level ?? 20, currentRegion: opts.region ?? 'waifu-valley' })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 5000, huntEnergy: 25 })
    .where(eq(playerCurrencies.playerId, playerId));
}

const balanceOf = async (playerId: number): Promise<number> =>
  (await app.currency.getBalances(playerId)).waifubux;

describe('shipped travel content', () => {
  it('prices the Caravan Pass at 1,000 WaifuBux behind Trainer Level 15', () => {
    // The product requirements, asserted against what actually ships rather
    // than against a fixture — these two numbers are the feature's whole gate.
    const twinPeeks = app.travel.catalog().get('twin-peeks')!;
    expect(twinPeeks.price).toBe(PASS_PRICE);
    expect(twinPeeks.requiredLevel).toBe(PASS_LEVEL);
    expect(twinPeeks.pass!.id).toBe('caravan_pass');
    expect(twinPeeks.grantedByPassPurchase).toBe(true);
  });

  it('hides the unreleased Thirstlands entirely — route authored, region off', () => {
    // The route exists in `tables.json` against the same Caravan Pass, so the
    // day the region is switched on nothing else has to change. Until then the
    // disabled region keeps it out of the catalog, out of `getStatus`, and out
    // of the seeded pools — a player cannot see it, buy it or travel to it.
    const catalog = app.travel.catalog();
    expect(catalog.get('thirstlands')).toBeNull();
    expect(catalog.destinations.map((d) => d.region.id)).toEqual([
      'waifu-valley',
      'twin-peeks',
      'flaccid-foothills',
    ]);
    expect(
      app.content.tables.travel.routes.some((r) => r.regionId === 'thirstlands'),
    ).toBe(true);
  });

  it('seeds no encounter pool for a disabled region', async () => {
    const pooled = await t.db
      .selectDistinct({ regionId: regionEncounterPools.regionId })
      .from(regionEncounterPools);
    expect(pooled.map((r) => r.regionId).sort()).toEqual([
      'flaccid-foothills',
      'twin-peeks',
      'waifu-valley',
    ]);
  });

  it('refuses to travel to it by name', async () => {
    const { playerId } = await provisionPlayer(app, 'g-travel-hidden', 'u-hidden');
    await expect(app.travel.travel(playerId, 'thirstlands')).rejects.toThrow(
      RegionNotFoundError,
    );
  });
});

describe('migration default', () => {
  it('puts every player in Waifu Valley without a backfill', async () => {
    // `players.current_region` carries the default, so a player row created by
    // the normal path — and, by construction, every row that predates the
    // column — reads waifu-valley with nothing having written to it.
    const { playerId } = await provisionPlayer(app, 'g-travel-default', 'u-default');
    const [row] = await t.db
      .select({ currentRegion: players.currentRegion })
      .from(players)
      .where(eq(players.id, playerId));
    expect(row!.currentRegion).toBe('waifu-valley');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('reports the starting region as current and unlocked with no rows at all', async () => {
    const { playerId } = await provisionPlayer(app, 'g-travel-default', 'u-default2');
    const status = await app.travel.getStatus(playerId);
    expect(status.currentRegion).toBe('waifu-valley');
    const valley = status.destinations.find((d) => d.regionId === 'waifu-valley')!;
    expect(valley.state).toBe('current');
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes).toEqual([]);
  });
});

describe('pass purchase', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-travel-buy', 'u-buy'));
  });
  beforeEach(() => resetPlayer(playerId));

  it('deducts exactly the pass price and grants pass + Twin Peeks atomically', async () => {
    const before = await balanceOf(playerId);
    const outcome = await app.travel.purchaseDestination(playerId, 'twin-peeks');

    expect(outcome.grantedPass).toBe(true);
    expect(outcome.amount).toBe(PASS_PRICE);
    expect(await balanceOf(playerId)).toBe(before - PASS_PRICE);

    const passes = await t.db
      .select()
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    expect(passes).toHaveLength(1);
    expect(passes[0]!.passId).toBe('caravan_pass');
    expect(passes[0]!.source).toBe('purchase');

    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes.map((r) => r.regionId)).toEqual(['twin-peeks']);

    const audit = await t.db
      .select()
      .from(travelTransactions)
      .where(eq(travelTransactions.playerId, playerId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'pass',
      passId: 'caravan_pass',
      regionId: 'twin-peeks',
      amount: PASS_PRICE,
      currency: 'waifubux',
      balanceAfter: before - PASS_PRICE,
    });
  });

  it('does not move the player — buying a road is not walking down it', async () => {
    await app.travel.purchaseDestination(playerId, 'twin-peeks');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('leaves the balance untouched on insufficient funds', async () => {
    await resetPlayer(playerId, { waifubux: PASS_PRICE - 1 });
    await expect(app.travel.purchaseDestination(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(await balanceOf(playerId)).toBe(PASS_PRICE - 1);
    const passes = await t.db
      .select()
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    expect(passes).toEqual([]);
    const audit = await t.db
      .select()
      .from(travelTransactions)
      .where(eq(travelTransactions.playerId, playerId));
    expect(audit).toEqual([]);
  });

  it('refuses below the level gate and charges nothing', async () => {
    await resetPlayer(playerId, { level: PASS_LEVEL - 1 });
    const before = await balanceOf(playerId);
    await expect(app.travel.purchaseDestination(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      TravelLevelRequiredError,
    );
    expect(await balanceOf(playerId)).toBe(before);
  });

  it('rejects a second purchase with no charge', async () => {
    await app.travel.purchaseDestination(playerId, 'twin-peeks');
    const after = await balanceOf(playerId);
    await expect(app.travel.purchaseDestination(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      RouteAlreadyUnlockedError,
    );
    expect(await balanceOf(playerId)).toBe(after);
    const audit = await t.db
      .select()
      .from(travelTransactions)
      .where(eq(travelTransactions.playerId, playerId));
    expect(audit).toHaveLength(1);
  });

  it('lets exactly one of two concurrent purchases through', async () => {
    // The real double-click. Both calls lock the same currency row, so one
    // serializes behind the other; whichever loses must find the route row and
    // roll its own deduction back. The invariant that matters is arithmetic:
    // the balance falls by exactly one price, never two.
    const before = await balanceOf(playerId);
    const results = await Promise.allSettled([
      app.travel.purchaseDestination(playerId, 'twin-peeks'),
      app.travel.purchaseDestination(playerId, 'twin-peeks'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await balanceOf(playerId)).toBe(before - PASS_PRICE);

    const passes = await t.db
      .select()
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    expect(passes).toHaveLength(1);
    const audit = await t.db
      .select()
      .from(travelTransactions)
      .where(eq(travelTransactions.playerId, playerId));
    expect(audit).toHaveLength(1);
  });

  it('refuses to sell the starting region', async () => {
    await expect(
      app.travel.purchaseDestination(playerId, 'waifu-valley'),
    ).rejects.toBeInstanceOf(RouteAlreadyUnlockedError);
  });

  it('refuses an unknown region', async () => {
    await expect(app.travel.purchaseDestination(playerId, 'atlantis')).rejects.toBeInstanceOf(
      RegionNotFoundError,
    );
  });
});

describe('travel', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-travel-move', 'u-move'));
  });
  beforeEach(() => resetPlayer(playerId));

  it('is free and immediate once unlocked', async () => {
    await app.travel.purchaseDestination(playerId, 'twin-peeks');
    const balanceBefore = await balanceOf(playerId);

    const outcome = await app.travel.travel(playerId, 'twin-peeks');
    expect(outcome).toMatchObject({ fromRegion: 'waifu-valley', toRegion: 'twin-peeks' });
    expect(await app.travel.getCurrentRegion(playerId)).toBe('twin-peeks');
    expect(await balanceOf(playerId)).toBe(balanceBefore);
  });

  it('always allows the trip home, with no route row involved', async () => {
    await app.travel.grantRoute(playerId, 'twin-peeks');
    await app.travel.travel(playerId, 'twin-peeks');
    await app.travel.revokeRoute(playerId, 'twin-peeks');
    // Revoking the route the player was standing in sends them home rather
    // than stranding them somewhere they can no longer reach.
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('refuses a locked destination', async () => {
    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      RegionLockedError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('refuses travel to where the player already is', async () => {
    await expect(app.travel.travel(playerId, 'waifu-valley')).rejects.toBeInstanceOf(
      AlreadyInRegionError,
    );
  });

  it('is blocked while an encounter is open, and unblocked once it resolves', async () => {
    await app.travel.grantRoute(playerId, 'twin-peeks');
    const [anySpecies] = await t.db.select().from(species).limit(1);
    const [encounter] = await t.db
      .insert(encounters)
      .values({
        playerId,
        speciesId: anySpecies!.id,
        channelId: 'c-travel',
        state: 'active',
        expiresAt: new Date(Date.now() + 60_000),
        regionId: 'waifu-valley',
      })
      .returning();

    await expect(app.travel.travel(playerId, 'twin-peeks')).rejects.toBeInstanceOf(
      TravelBlockedByEncounterError,
    );
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');

    await app.hunt.letHerGo(playerId, encounter!.id);
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('twin-peeks');
  });

  it('is not blocked by an encounter whose window has already closed', async () => {
    await app.travel.grantRoute(playerId, 'twin-peeks');
    const [anySpecies] = await t.db.select().from(species).limit(1);
    await t.db.insert(encounters).values({
      playerId,
      speciesId: anySpecies!.id,
      channelId: 'c-travel',
      state: 'active',
      expiresAt: new Date(Date.now() - 60_000),
      regionId: 'waifu-valley',
    });
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('twin-peeks');
  });
});

describe('admin grants', () => {
  let playerId: number;
  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-travel-admin', 'u-admin'));
  });
  beforeEach(() => resetPlayer(playerId, { level: 1, waifubux: 0 }));

  it('grants a pass and its routes for free, bypassing the level gate', async () => {
    await app.travel.grantPass(playerId, 'caravan_pass');
    const passes = await t.db
      .select()
      .from(playerTravelPasses)
      .where(eq(playerTravelPasses.playerId, playerId));
    expect(passes[0]!.source).toBe('admin');
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes.map((r) => r.regionId)).toEqual(['twin-peeks']);
    expect(await balanceOf(playerId)).toBe(0);
    // A grant is not a purchase, so nothing is audited.
    const audit = await t.db
      .select()
      .from(travelTransactions)
      .where(eq(travelTransactions.playerId, playerId));
    expect(audit).toEqual([]);
  });

  it('is idempotent', async () => {
    await app.travel.grantPass(playerId, 'caravan_pass');
    await app.travel.grantPass(playerId, 'caravan_pass');
    await app.travel.grantRoute(playerId, 'twin-peeks');
    const counted = await t.db
      .select({ count: sql<number>`count(*)::int` })
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(counted[0]!.count).toBe(1);
  });

  it('leaves route rows alone when a pass is revoked', async () => {
    // Pass and route are independent facts. Cascading here would silently
    // strand a player who still has a perfectly good route row.
    await app.travel.grantPass(playerId, 'caravan_pass');
    await app.travel.revokePass(playerId, 'caravan_pass');
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(
        and(
          eq(playerUnlockedRoutes.playerId, playerId),
          eq(playerUnlockedRoutes.regionId, 'twin-peeks'),
        ),
      );
    expect(routes).toHaveLength(1);
  });
});

describe('regional shop stock', () => {
  let playerId: number;
  let charmId: number;

  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-travel-shop', 'u-travel-shop'));
    const [charm] = await t.db.select().from(items).where(eq(items.slug, 'basic_charm'));
    charmId = charm!.id;
  });
  beforeEach(async () => {
    await resetPlayer(playerId);
    await t.db.delete(regionShopItems);
  });
  afterAll(async () => {
    await t.db.delete(regionShopItems);
  });

  /** Scopes an ordinary shipped item to one region, as a region file would. */
  async function stockOnlyIn(regionId: string): Promise<void> {
    await t.db.insert(regionShopItems).values({ regionId, itemId: charmId });
  }

  it('withdraws regionally-scoped stock from the global catalog', async () => {
    const before = await app.shop.getCatalog();
    expect(before.some((e) => e.item.slug === 'basic_charm')).toBe(true);
    await stockOnlyIn('twin-peeks');
    const after = await app.shop.getCatalog();
    expect(after.some((e) => e.item.slug === 'basic_charm')).toBe(false);
    const regional = await app.shop.getRegionalCatalog('twin-peeks');
    expect(regional.map((e) => e.item.slug)).toEqual(['basic_charm']);
  });

  it('refuses to sell regional stock to a player standing elsewhere', async () => {
    // Hiding the button is only half the rule — a `shop:buy` custom id is a
    // string that outlives the screen that painted it, and the Platform API
    // reaches purchase() with no screen at all.
    await stockOnlyIn('twin-peeks');
    const before = await balanceOf(playerId);
    await expect(app.shop.purchase(playerId, 'basic_charm', 1)).rejects.toBeInstanceOf(
      ItemNotSoldHereError,
    );
    expect(await balanceOf(playerId)).toBe(before);
  });

  it('sells it once the player is actually standing there', async () => {
    await stockOnlyIn('twin-peeks');
    await app.travel.grantRoute(playerId, 'twin-peeks');
    await app.travel.travel(playerId, 'twin-peeks');
    const result = await app.shop.purchase(playerId, 'basic_charm', 1);
    expect(result.item.slug).toBe('basic_charm');
  });

  it('leaves unscoped core stock buyable from anywhere', async () => {
    // The regression that matters most: with `region_shop_items` empty — the
    // shipped state — purchase() must behave exactly as it did before travel.
    await stockOnlyIn('twin-peeks');
    const result = await app.shop.purchase(playerId, 'silk_charm', 1);
    expect(result.item.slug).toBe('silk_charm');
  });
});
