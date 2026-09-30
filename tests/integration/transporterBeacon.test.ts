/**
 * Transporter Beacon — the key item that gates the Assteroid Belt, end to end.
 *
 * The Belt used to be a Caravan Pass route; it is now reached by *holding* a
 * permanent `key` item built from four components and 1,500 WaifuBux. The
 * rules under test are the whole contract of that change:
 *
 *   - no beacon, no trip — and the refusal explains the recipe rather than
 *     saying "locked";
 *   - construction is all-or-nothing: exact components, exactly 1,500
 *     WaifuBux, exactly one beacon, or nothing at all;
 *   - no amount of double-clicking builds two or charges twice;
 *   - travel checks the beacon and never spends it, and leaving the Belt never
 *     depends on it; there is no level gate on top of it;
 *   - components are vendorable key items, the beacon is not, and selling
 *     surplus components never touches Belt access;
 *   - every other destination is still a Caravan Pass route, untouched.
 *
 * Written against shipped content, so the recipe asserted here is the recipe
 * players get.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encounters,
  items,
  keyItemConstructions,
  playerAchievements,
  playerCurrencies,
  playerInventory,
  playerTravelPasses,
  playerUnlockedRoutes,
  players,
} from '../../src/db/schema';
import {
  handleShop,
  handleShopBuy,
  handleShopSell,
} from '../../src/discord/commands/waifumon';
import {
  handleLocationDetail,
  handleLocationKeyBuild,
  handleLocationKeyConfirm,
} from '../../src/discord/commands/waifumonLocations';
import type { AppContext, Provisioned } from '../../src/discord/types';
import {
  InsufficientFundsError,
  ItemNotSellableError,
  ItemOwnershipLimitError,
  KeyItemAlreadyOwnedError,
  KeyItemComponentsMissingError,
  KeyItemRequiredError,
  RegionLockedError,
  TravelLevelRequiredError,
  TravelPassRequiredError,
} from '../../src/shared/errors';
import {
  bootstrapApp,
  createEventHarness,
  forceRegion,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let prov: Provisioned;
let playerId: number;
let ctx: AppContext;

const BELT = 'assteroid-belt';
const BEACON = 'transporter_beacon';
const RECIPE = 'transporter_beacon';
const COST = 1500;
/** Past every Caravan Pass gate. The Belt itself has no level gate. */
const LEVEL = 35;
/** Resale value of each component; the beacon itself has none. */
const COMPONENT_SELL_VALUES: Readonly<Record<string, number>> = {
  cracked_teleport_core: 150,
  quantum_stabilizer: 35,
  phase_coupler: 25,
  astral_power_cell: 400,
};
/** The shipped recipe, spelled out so the test does not trust content's copy. */
const COMPONENTS: readonly (readonly [string, number])[] = [
  ['cracked_teleport_core', 1],
  ['quantum_stabilizer', 2],
  ['phase_coupler', 1],
  ['astral_power_cell', 1],
];
const TRACKED = [BEACON, ...COMPONENTS.map(([slug]) => slug)];

const itemIds = new Map<string, number>();

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  prov = await provisionPlayer(app, 'g-beacon', 'u-beacon');
  playerId = prov.playerId;
  const rows = await t.db.select({ id: items.id, slug: items.slug }).from(items);
  for (const r of rows) itemIds.set(r.slug, r.id);
  const harness = createEventHarness(app, t.logger);
  ctx = {
    config: {} as AppContext['config'],
    logger: t.logger,
    db: t.db,
    content: app.content,
    events: harness.bus,
    huntSessions: harness.huntSessions,
    services: {
      guilds: app.guilds,
      travel: app.travel,
      keyItems: app.keyItems,
      players: app.players,
      achievements: app.achievements,
      leaderboards: app.leaderboards,
      currency: app.currency,
      inventory: app.inventory,
      daily: app.daily,
      shop: app.shop,
      hunt: app.hunt,
      capture: app.capture,
      collection: app.collection,
      expeditions: app.expeditions,
      availability: app.availability,
      appearance: app.appearance,
      care: app.care,
      progression: app.progression,
      quests: app.quests,
      effects: app.effects,
      itemUse: app.itemUse,
      gifts: app.gifts,
      session: app.session,
    },
  };
});

afterAll(async () => {
  await t.cleanup();
});

/** Nothing owned, level 35, the balance the caller chooses, standing in the valley. */
async function resetPlayer(opts: { waifubux?: number; level?: number } = {}): Promise<void> {
  await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.delete(playerUnlockedRoutes).where(eq(playerUnlockedRoutes.playerId, playerId));
  await t.db.delete(playerTravelPasses).where(eq(playerTravelPasses.playerId, playerId));
  await t.db.delete(keyItemConstructions).where(eq(keyItemConstructions.playerId, playerId));
  await t.db.delete(playerAchievements).where(eq(playerAchievements.playerId, playerId));
  await t.db
    .update(players)
    .set({
      level: opts.level ?? LEVEL,
      careModeStartedAt: null,
      careModeLastTickAt: null,
      careModeWaifuId: null,
    })
    .where(eq(players.id, playerId));
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: opts.waifubux ?? 5000, huntEnergy: 50 })
    .where(eq(playerCurrencies.playerId, playerId));
  await forceRegion(t.db, playerId, 'waifu-valley');
}

beforeEach(() => resetPlayer());

async function give(slug: string, quantity: number): Promise<void> {
  await t.db.transaction((tx) => app.inventory.addItem(tx, playerId, itemIds.get(slug)!, quantity));
}

/** The Phase Coupler is capped at one (`max_owned`), so it never gets spares. */
const CAPPED = new Set(['phase_coupler']);
const spare = (slug: string, extra: number) => (CAPPED.has(slug) ? 0 : extra);

async function giveAllComponents(extra = 0): Promise<void> {
  for (const [slug, qty] of COMPONENTS) await give(slug, qty + spare(slug, extra));
}

async function held(slug: string): Promise<number> {
  const [row] = await t.db
    .select({ quantity: playerInventory.quantity })
    .from(playerInventory)
    .where(
      and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, itemIds.get(slug)!)),
    );
  return row?.quantity ?? 0;
}

async function snapshot() {
  const counts = Object.fromEntries(await Promise.all(TRACKED.map(async (s) => [s, await held(s)])));
  const bux = (await app.currency.getBalances(playerId)).waifubux;
  const audits = await t.db
    .select()
    .from(keyItemConstructions)
    .where(eq(keyItemConstructions.playerId, playerId));
  return { counts, bux, audits: audits.length };
}

describe('shipped items', () => {
  it('ships the beacon as an unbuyable, unsellable key item capped at one', async () => {
    const [row] = await t.db.select().from(items).where(eq(items.slug, BEACON));
    expect(row!.category).toBe('key');
    expect(row!.maxOwned).toBe(1);
    expect(row!.buyPrice).toBeNull();
    expect(row!.sellValue).toBeNull();
    expect(row!.shopRegions).toEqual([]);
    expect(row!.enabled).toBe(true);
  });

  it('ships every component as a sellable key item, priced by how hard it is to get', async () => {
    for (const [slug] of COMPONENTS) {
      const [row] = await t.db.select().from(items).where(eq(items.slug, slug));
      expect(row!.category, slug).toBe('key');
      expect(row!.sellValue, slug).toBe(COMPONENT_SELL_VALUES[slug]);
    }
  });

  it('keeps every component off the shelves except the Phase Coupler', async () => {
    for (const [slug] of COMPONENTS) {
      const [row] = await t.db.select().from(items).where(eq(items.slug, slug));
      if (slug === 'phase_coupler') {
        expect(row!.shopRegions).toEqual(['base-80085']);
        expect(row!.buyPrice).toBe(900);
        expect(row!.maxOwned).toBe(1);
        // Resale is a fraction of the shelf price, so buy-to-sell only loses.
        expect(row!.sellValue!).toBeLessThan(row!.buyPrice!);
      } else {
        expect(row!.shopRegions, slug).toEqual([]);
        expect(row!.buyPrice, slug).toBeNull();
      }
    }
  });
});

describe('without a beacon', () => {
  it('cannot travel to the Assteroid Belt', async () => {
    await giveAllComponents();
    await expect(app.travel.travel(playerId, BELT)).rejects.toBeInstanceOf(KeyItemRequiredError);
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
    // A refused trip costs nothing.
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(50);
  });

  it('explains the requirement in the refusal', async () => {
    const err = await app.travel.travel(playerId, BELT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyItemRequiredError);
    expect((err as KeyItemRequiredError).userMessage).toContain('Transporter Beacon');
  });

  it('shows the beacon and every component with the player’s progress', async () => {
    await give('cracked_teleport_core', 1);
    await give('quantum_stabilizer', 1);
    await give('astral_power_cell', 1);
    await t.db
      .update(playerCurrencies)
      .set({ waifubux: 2340 })
      .where(eq(playerCurrencies.playerId, playerId));

    const view = await app.travel.getDestination(playerId, BELT);
    expect(view!.state).toBe('key_required');
    expect(view!.requirements.join(' ')).toContain('Transporter Beacon');
    const progress = view!.keyItem!.progress!;
    expect(progress.output.name).toBe('Transporter Beacon');
    expect(progress.components.map((c) => [c.slug, c.owned, c.required, c.complete])).toEqual([
      ['cracked_teleport_core', 1, 1, true],
      ['quantum_stabilizer', 1, 2, false],
      ['phase_coupler', 0, 1, false],
      ['astral_power_cell', 1, 1, true],
    ]);
    expect(progress.waifubux).toEqual({ required: COST, owned: 2340, complete: true });
    expect(progress.ready).toBe(false);
    // Every component says where to look.
    expect(progress.components.every((c) => c.hint.length > 0)).toBe(true);
  });

  it('is never for sale through the purchase path', async () => {
    await expect(app.travel.purchaseDestination(playerId, BELT)).rejects.toBeInstanceOf(
      KeyItemRequiredError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000);
  });
});

describe('construction', () => {
  it('refuses with incomplete components, consuming and charging nothing', async () => {
    await giveAllComponents();
    await t.db
      .update(playerInventory)
      .set({ quantity: 1 })
      .where(
        and(
          eq(playerInventory.playerId, playerId),
          eq(playerInventory.itemId, itemIds.get('quantum_stabilizer')!),
        ),
      );
    const before = await snapshot();
    const err = await app.keyItems.construct(playerId, RECIPE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyItemComponentsMissingError);
    expect((err as KeyItemComponentsMissingError).userMessage).toContain('Quantum Stabilizer 1/2');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses with every component but too little WaifuBux, consuming nothing', async () => {
    await resetPlayer({ waifubux: COST - 1 });
    await giveAllComponents();
    const before = await snapshot();
    await expect(app.keyItems.construct(playerId, RECIPE)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect(await snapshot()).toEqual(before);
    expect(before.counts[BEACON]).toBe(0);
  });

  it('consumes exactly the recipe, charges exactly 1,500, grants exactly one beacon', async () => {
    // One spare of everything, so "exact" is distinguishable from "all".
    await giveAllComponents(1);
    const outcome = await app.keyItems.construct(playerId, RECIPE);

    expect(outcome.waifubuxSpent).toBe(COST);
    expect(outcome.balanceAfter).toBe(5000 - COST);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - COST);
    for (const [slug] of COMPONENTS) expect(await held(slug), slug).toBe(spare(slug, 1));
    expect(await held(BEACON)).toBe(1);

    const audits = await t.db
      .select()
      .from(keyItemConstructions)
      .where(eq(keyItemConstructions.playerId, playerId));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.source).toBe('construct');
    expect(audits[0]!.waifubuxSpent).toBe(COST);
    expect(audits[0]!.balanceAfter).toBe(5000 - COST);
    expect(audits[0]!.inputs).toEqual(COMPONENTS.map(([slug, quantity]) => ({ slug, quantity })));

    const view = await app.travel.getDestination(playerId, BELT);
    expect(view!.state).toBe('unlocked');
    expect(view!.keyItem!.owned).toBe(true);
  });

  it('refuses a second construction and charges nothing for it', async () => {
    await giveAllComponents(5);
    await app.keyItems.construct(playerId, RECIPE);
    const before = await snapshot();
    await expect(app.keyItems.construct(playerId, RECIPE)).rejects.toBeInstanceOf(
      KeyItemAlreadyOwnedError,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('builds exactly one beacon from a burst of concurrent attempts', async () => {
    // Spares of every uncapped component. The single Phase Coupler is consumed
    // by the winner, but the losers are refused earlier — "already owned" is
    // checked before components — so the error proves the rule, not a shortage.
    await giveAllComponents(10);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => app.keyItems.construct(playerId, RECIPE)),
    );
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    for (const r of lost) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(KeyItemAlreadyOwnedError);
    }
    expect(await held(BEACON)).toBe(1);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - COST);
    // Exactly one recipe's worth consumed: the spares are all still there.
    for (const [slug] of COMPONENTS) expect(await held(slug), slug).toBe(spare(slug, 10));
    const audits = await t.db
      .select()
      .from(keyItemConstructions)
      .where(eq(keyItemConstructions.playerId, playerId));
    expect(audits).toHaveLength(1);
  });

  it('caps the beacon at one in the inventory layer itself, even under concurrent grants', async () => {
    // The database backstop under the service check: no caller — admin tool,
    // reward, race — can stack a second beacon.
    const grants = await Promise.allSettled(
      Array.from({ length: 5 }, () => give(BEACON, 1)),
    );
    expect(grants.filter((g) => g.status === 'fulfilled')).toHaveLength(1);
    for (const g of grants.filter((r) => r.status === 'rejected')) {
      expect((g as PromiseRejectedResult).reason).toBeInstanceOf(ItemOwnershipLimitError);
    }
    expect(await held(BEACON)).toBe(1);
    await expect(give(BEACON, 1)).rejects.toBeInstanceOf(ItemOwnershipLimitError);
    await expect(give(BEACON, 2)).rejects.toBeInstanceOf(ItemOwnershipLimitError);
    expect(await held(BEACON)).toBe(1);
  });

  it('leaves uncapped items stacking exactly as before', async () => {
    await give('quantum_stabilizer', 3);
    await give('quantum_stabilizer', 4);
    expect(await held('quantum_stabilizer')).toBe(7);
  });
});

describe('travel with a beacon', () => {
  beforeEach(async () => {
    await giveAllComponents();
    await app.keyItems.construct(playerId, RECIPE);
  });

  it('enters the Assteroid Belt without consuming the beacon', async () => {
    const outcome = await app.travel.travel(playerId, BELT);
    expect(outcome.toRegion).toBe(BELT);
    expect(await app.travel.getCurrentRegion(playerId)).toBe(BELT);
    expect(await held(BEACON)).toBe(1);
    // Travel costs its usual Energy and no WaifuBux.
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - COST);
  });

  it('comes and goes repeatedly on the same beacon', async () => {
    for (let i = 0; i < 3; i++) {
      await app.travel.travel(playerId, BELT);
      await app.travel.travel(playerId, 'waifu-valley');
    }
    expect(await held(BEACON)).toBe(1);
  });

  it('leaves the Belt normally, to home or any route already owned', async () => {
    await app.travel.grantPass(playerId, 'caravan_pass');
    await app.travel.travel(playerId, BELT);
    await app.travel.travel(playerId, 'twin-peeks');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('twin-peeks');
    await app.travel.travel(playerId, BELT);
    await app.travel.travel(playerId, 'waifu-valley');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });

  it('never strands a player in the Belt who has lost the beacon', async () => {
    await app.travel.travel(playerId, BELT);
    // An inconsistent state only an admin edit can produce: standing in the
    // Belt with no beacon. Leaving checks the destination, never the origin.
    await t.db
      .update(playerInventory)
      .set({ quantity: 0 })
      .where(
        and(eq(playerInventory.playerId, playerId), eq(playerInventory.itemId, itemIds.get(BEACON)!)),
      );
    expect((await app.travel.getDestination(playerId, BELT))!.state).toBe('current');
    await app.travel.travel(playerId, 'waifu-valley');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
    // …and cannot go back without rebuilding it.
    await expect(app.travel.travel(playerId, BELT)).rejects.toBeInstanceOf(KeyItemRequiredError);
  });

  it('has no level gate: the beacon alone opens the trip', async () => {
    await t.db.update(players).set({ level: 1 }).where(eq(players.id, playerId));
    expect((await app.travel.getDestination(playerId, BELT))!.requiredLevel).toBeNull();
    await app.travel.travel(playerId, BELT);
    expect(await app.travel.getCurrentRegion(playerId)).toBe(BELT);
    expect(await held(BEACON)).toBe(1);
  });
});

describe('admin helpers on a key-item destination', () => {
  it('grantRoute hands over the beacon, idempotently', async () => {
    await app.travel.grantRoute(playerId, BELT);
    await app.travel.grantRoute(playerId, BELT);
    expect(await held(BEACON)).toBe(1);
    // No route row: the beacon is the entitlement.
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes).toEqual([]);
  });

  it('revokeRoute takes the beacon and sends a player standing in the Belt home', async () => {
    await app.travel.grantRoute(playerId, BELT);
    await app.travel.travel(playerId, BELT);
    await app.travel.revokeRoute(playerId, BELT);
    expect(await held(BEACON)).toBe(0);
    expect(await app.travel.getCurrentRegion(playerId)).toBe('waifu-valley');
  });
});

describe('selling components', () => {
  it('sells each component for its sell value', async () => {
    for (const [slug] of COMPONENTS) {
      await give(slug, 1);
      const bux = (await app.currency.getBalances(playerId)).waifubux;
      const sale = await app.shop.sellItem(playerId, slug, 1);
      expect(sale.totalValue, slug).toBe(COMPONENT_SELL_VALUES[slug]);
      expect(sale.balanceAfter, slug).toBe(bux + COMPONENT_SELL_VALUES[slug]!);
      expect(await held(slug), slug).toBe(0);
    }
  });

  it('refuses to sell the beacon and keeps it', async () => {
    await app.travel.grantRoute(playerId, BELT);
    await expect(app.shop.sellItem(playerId, BEACON, 1)).rejects.toBeInstanceOf(
      ItemNotSellableError,
    );
    expect(await held(BEACON)).toBe(1);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000);
  });

  it('allows selling a component before construction, which then comes up short', async () => {
    await giveAllComponents();
    await app.shop.sellItem(playerId, 'astral_power_cell', 1);
    await expect(app.keyItems.construct(playerId, RECIPE)).rejects.toBeInstanceOf(
      KeyItemComponentsMissingError,
    );
    expect(await held(BEACON)).toBe(0);
  });

  it('sells surplus after construction without touching the beacon or Belt access', async () => {
    await giveAllComponents(2);
    await app.keyItems.construct(playerId, RECIPE);
    expect(await held(BEACON)).toBe(1);

    for (const [slug] of COMPONENTS) {
      const surplus = await held(slug);
      if (surplus > 0) await app.shop.sellItem(playerId, slug, surplus);
      expect(await held(slug), slug).toBe(0);
    }

    expect(await held(BEACON)).toBe(1);
    expect((await app.travel.getDestination(playerId, BELT))!.state).toBe('unlocked');
    await app.travel.travel(playerId, BELT);
    expect(await app.travel.getCurrentRegion(playerId)).toBe(BELT);
  });

  it('lists components on the Sell screen and never the beacon', async () => {
    await app.travel.grantRoute(playerId, BELT);
    for (const [slug] of COMPONENTS) await give(slug, 1);

    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug).sort()).toEqual(
      Object.keys(COMPONENT_SELL_VALUES).sort(),
    );

    const btn = fakeButton();
    await handleShopSell(ctx, btn as never, prov);
    const text = descriptionOf(painted(btn));
    for (const name of [
      'Cracked Teleport Core',
      'Quantum Stabilizer',
      'Phase Coupler',
      'Astral Power Cell',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain('Transporter Beacon');
    const sellButtons = buttonsOf(painted(btn)).filter((b) => b.customId.includes('sellqty'));
    expect(sellButtons.length).toBeGreaterThan(0);
    expect(sellButtons.some((b) => b.customId.includes(BEACON))).toBe(false);
  });
});

describe('every other destination is unchanged', () => {
  it('keeps the Caravan Pass purchase for Twin Peeks', async () => {
    const view = await app.travel.getDestination(playerId, 'twin-peeks');
    expect(view!.state).toBe('purchasable');
    expect(view!.keyItem).toBeNull();
    expect(view!.purchaseGrantsPass).toBe(true);
    expect(view!.price).toBe(1000);
    const outcome = await app.travel.purchaseDestination(playerId, 'twin-peeks');
    expect(outcome.grantedPass).toBe(true);
    expect(outcome.amount).toBe(1000);
  });

  it('keeps every later destination a route stamped onto the pass', async () => {
    for (const [region, price, level] of [
      ['flaccid-foothills', 1500, 20],
      ['thirstlands', 2000, 25],
      ['base-80085', 2500, 30],
    ] as const) {
      // No pass yet: the pass is still the missing requirement.
      await expect(app.travel.purchaseDestination(playerId, region)).rejects.toBeInstanceOf(
        TravelPassRequiredError,
      );
      await expect(app.travel.travel(playerId, region)).rejects.toBeInstanceOf(RegionLockedError);
      const view = await app.travel.getDestination(playerId, region);
      expect(view!.keyItem, region).toBeNull();
      expect(view!.price, region).toBe(price);
      expect(view!.requiredLevel, region).toBe(level);
    }
    await app.travel.grantPass(playerId, 'caravan_pass');
    const outcome = await app.travel.purchaseDestination(playerId, 'base-80085');
    expect(outcome.amount).toBe(2500);
    await app.travel.travel(playerId, 'base-80085');
    expect(await app.travel.getCurrentRegion(playerId)).toBe('base-80085');
  });

  it('keeps every Caravan Pass level gate, beacon or not', async () => {
    await app.travel.grantRoute(playerId, BELT);
    await app.travel.grantPass(playerId, 'caravan_pass');
    for (const [region, level] of [
      ['flaccid-foothills', 20],
      ['thirstlands', 25],
      ['base-80085', 30],
    ] as const) {
      await t.db.update(players).set({ level: level - 1 }).where(eq(players.id, playerId));
      const view = await app.travel.getDestination(playerId, region);
      expect(view!.state, region).toBe('ineligible');
      expect(view!.requirements.join(' '), region).toContain(`Trainer Level ${level}`);
      await expect(app.travel.purchaseDestination(playerId, region), region).rejects.toBeInstanceOf(
        TravelLevelRequiredError,
      );
    }
  });

  it('does not let a beacon open any other region', async () => {
    await app.travel.grantRoute(playerId, BELT);
    for (const region of ['twin-peeks', 'flaccid-foothills', 'thirstlands', 'base-80085']) {
      await expect(app.travel.travel(playerId, region), region).rejects.toBeInstanceOf(
        RegionLockedError,
      );
    }
  });
});

describe('regions-unlocked achievements', () => {
  async function explorer(id: 'explorer_1' | 'explorer_2') {
    const { achievements } = await app.achievements.getPlayerAchievements(playerId);
    return achievements.find((a) => a.id === id)!;
  }

  it('counts the Belt for a player whose only access is a constructed beacon', async () => {
    expect(await app.travel.accessibleRegions(playerId)).toEqual(['waifu-valley']);
    expect((await explorer('explorer_1')).unlocked).toBe(false);

    await giveAllComponents();
    await app.keyItems.construct(playerId, RECIPE);
    // No route row anywhere — the beacon is the whole entitlement.
    const routes = await t.db
      .select()
      .from(playerUnlockedRoutes)
      .where(eq(playerUnlockedRoutes.playerId, playerId));
    expect(routes).toEqual([]);

    expect(await app.travel.accessibleRegions(playerId)).toEqual(['waifu-valley', BELT]);
    expect((await explorer('explorer_1')).unlocked).toBe(true);
  });

  it('adds the beacon to route unlocks — two routes and a beacon reach four', async () => {
    await app.travel.grantPass(playerId, 'caravan_pass'); // Twin Peeks
    await app.travel.grantRoute(playerId, 'flaccid-foothills');
    expect((await app.travel.accessibleRegions(playerId)).length).toBe(3);
    expect((await explorer('explorer_2')).unlocked).toBe(false);

    await giveAllComponents();
    await app.keyItems.construct(playerId, RECIPE);
    expect(await app.travel.accessibleRegions(playerId)).toEqual([
      'waifu-valley',
      'twin-peeks',
      'flaccid-foothills',
      BELT,
    ]);
    expect((await explorer('explorer_2')).unlocked).toBe(true);
  });

  it('does not count a leftover Belt route row without the beacon', async () => {
    // Under the new access model a bare route row is not access to the Belt,
    // so it is not an unlocked region either.
    await t.db.insert(playerUnlockedRoutes).values({ playerId, regionId: BELT });
    expect(await app.travel.accessibleRegions(playerId)).toEqual(['waifu-valley']);
    expect((await explorer('explorer_1')).unlocked).toBe(false);
  });
});

describe('Phase Coupler in the Base 80085 shop', () => {
  const COUPLER = 'phase_coupler';
  const PRICE = 900;

  beforeEach(async () => {
    await app.travel.grantPass(playerId, 'caravan_pass');
    await app.travel.grantRoute(playerId, 'base-80085');
    await forceRegion(t.db, playerId, 'base-80085');
  });

  it('sells one, then refuses a second without charging', async () => {
    const first = await app.shop.purchase(playerId, COUPLER, 1);
    expect(first.totalPrice).toBe(PRICE);
    expect(first.ownedAfter).toBe(1);
    const bux = (await app.currency.getBalances(playerId)).waifubux;
    expect(bux).toBe(5000 - PRICE);

    const err = await app.shop.purchase(playerId, COUPLER, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ItemOwnershipLimitError);
    expect((err as ItemOwnershipLimitError).userMessage).toContain('Phase Coupler');
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(bux);
    expect(await held(COUPLER)).toBe(1);
  });

  it('refuses a multi-quantity purchase past the cap, even from zero', async () => {
    await expect(app.shop.purchase(playerId, COUPLER, 2)).rejects.toBeInstanceOf(
      ItemOwnershipLimitError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000);
    expect(await held(COUPLER)).toBe(0);
  });

  it('charges exactly once for a burst of concurrent buy clicks', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => app.shop.purchase(playerId, COUPLER, 1)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await held(COUPLER)).toBe(1);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - PRICE);
  });

  it('sells back for less than it costs, freeing the cap for another purchase', async () => {
    await app.shop.purchase(playerId, COUPLER, 1);
    const sale = await app.shop.sellItem(playerId, COUPLER, 1);
    expect(sale.totalValue).toBe(COMPONENT_SELL_VALUES[COUPLER]);
    expect(sale.balanceAfter).toBe(5000 - PRICE + COMPONENT_SELL_VALUES[COUPLER]!);
    expect(await held(COUPLER)).toBe(0);

    await app.shop.purchase(playerId, COUPLER, 1);
    expect(await held(COUPLER)).toBe(1);
    await expect(app.shop.purchase(playerId, COUPLER, 1)).rejects.toBeInstanceOf(
      ItemOwnershipLimitError,
    );
  });

  it('can be bought again once construction has consumed it', async () => {
    await app.shop.purchase(playerId, COUPLER, 1);
    for (const [slug, qty] of COMPONENTS) if (slug !== COUPLER) await give(slug, qty);
    await app.keyItems.construct(playerId, RECIPE);
    expect(await held(COUPLER)).toBe(0);
    await app.shop.purchase(playerId, COUPLER, 1);
    expect(await held(COUPLER)).toBe(1);
  });

  it('shows the cap on the shelf and disables Buy once one is held', async () => {
    const before = fakeButton();
    await handleShop(ctx, before as never, prov);
    const buyBefore = buttonsOf(painted(before)).find((b) => b.customId.includes(COUPLER))!;
    expect(buyBefore.label).toContain('Buy Phase Coupler');
    expect(buyBefore.disabled).toBe(false);
    expect(descriptionOf(painted(before))).toContain('owned ×0 (max 1)');

    const buy = fakeButton();
    await handleShopBuy(ctx, buy as never, prov, COUPLER);
    const after = buttonsOf(painted(buy)).find((b) => b.customId.includes(COUPLER))!;
    expect(after.disabled).toBe(true);
    expect(after.label).toContain('owned (max 1)');
    expect(descriptionOf(painted(buy))).toContain('owned ×1 (max 1)');

    // A stale Buy button from an older screen still refuses before charging;
    // the dispatcher shows the error's player-safe message.
    const bux = (await app.currency.getBalances(playerId)).waifubux;
    await expect(handleShopBuy(ctx, fakeButton() as never, prov, COUPLER)).rejects.toBeInstanceOf(
      ItemOwnershipLimitError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(bux);
  });
});

/* ── The Locations screen ─────────────────────────────────────────────── */

function fakeButton() {
  const channel = { id: 'c-beacon', send: vi.fn(), messages: { edit: vi.fn() } };
  return {
    isChatInputCommand: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    replied: false,
    deferred: false,
    reply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}),
    channel,
    channelId: channel.id,
    user: { id: 'u-beacon', displayName: 'Hunter' },
    guildId: 'g-beacon',
    message: { id: 'm-beacon' },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function painted(btn: ReturnType<typeof fakeButton>): any {
  const calls = [...btn.update.mock.calls, ...btn.reply.mock.calls] as any[][];
  return calls[0]?.[0];
}

function buttonsOf(payload: any): { customId: string; label: string; disabled: boolean }[] {
  return (payload?.components ?? []).flatMap((row: any) => {
    const json = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return (json.components ?? []).map((c: any) => ({
      customId: c.custom_id ?? '',
      label: c.label ?? '',
      disabled: c.disabled ?? false,
    }));
  });
}

function descriptionOf(payload: any): string {
  const embed = payload?.embeds?.[0];
  const json = embed && typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  return json?.description ?? '';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('the Locations detail screen', () => {
  it('shows the requirement and progress instead of a generic lock', async () => {
    await give('cracked_teleport_core', 1);
    await give('quantum_stabilizer', 1);
    await give('astral_power_cell', 1);
    await t.db
      .update(playerCurrencies)
      .set({ waifubux: 2340 })
      .where(eq(playerCurrencies.playerId, playerId));

    const btn = fakeButton();
    await handleLocationDetail(ctx, btn as never, prov, BELT);
    const text = descriptionOf(painted(btn));
    expect(text).toContain('Transporter Beacon Required');
    expect(text).toContain('Cracked Teleport Core: **1/1**');
    expect(text).toContain('Quantum Stabilizer: **1/2**');
    expect(text).toContain('Phase Coupler: **0/1**');
    expect(text).toContain('Astral Power Cell: **1/1**');
    expect(text).toContain('WaifuBux: **2,340 / 1,500**');
    // Missing components carry their hint; nothing offers to build yet.
    expect(text).toContain('Base 80085 shop');
    expect(buttonsOf(painted(btn)).some((b) => b.customId.includes('kconfirm'))).toBe(false);
    expect(buttonsOf(painted(btn)).some((b) => b.customId.includes(':travel:'))).toBe(false);
  });

  it('offers Construct once everything is in hand, behind a confirmation', async () => {
    await giveAllComponents();
    const detail = fakeButton();
    await handleLocationDetail(ctx, detail as never, prov, BELT);
    const construct = buttonsOf(painted(detail)).find((b) => b.customId.includes('kconfirm'));
    expect(construct).toBeDefined();
    expect(construct!.label).toContain('1,500');

    // The confirm screen spends nothing.
    const confirm = fakeButton();
    await handleLocationKeyConfirm(ctx, confirm as never, prov, BELT);
    expect(await held(BEACON)).toBe(0);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000);
    expect(buttonsOf(painted(confirm)).some((b) => b.customId.includes('kbuild'))).toBe(true);

    // Build, then land back on the detail screen with the road open.
    const build = fakeButton();
    await handleLocationKeyBuild(ctx, build as never, prov, BELT);
    expect(descriptionOf(painted(build))).toContain('Constructed the **Transporter Beacon**');
    expect(await held(BEACON)).toBe(1);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - COST);
    expect(buttonsOf(painted(build)).some((b) => b.label.includes('Travel to Assteroid Belt'))).toBe(
      true,
    );

    // A replayed build button is refused on-screen and charges nothing.
    const again = fakeButton();
    await handleLocationKeyBuild(ctx, again as never, prov, BELT);
    expect(await held(BEACON)).toBe(1);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(5000 - COST);
  });
});
