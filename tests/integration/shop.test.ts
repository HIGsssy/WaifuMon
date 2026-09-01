import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items, shopTransactions } from '../../src/db/schema';
import {
  CharmRecipeNotFoundError,
  InsufficientCharmsError,
  InsufficientEssenceError,
  InsufficientFundsError,
  InventoryCapacityError,
  ItemNotFoundError,
  ItemNotPurchasableError,
  ItemNotSoldHereError,
} from '../../src/shared/errors';
import {
  bootstrapApp,
  forceRegion,
  getItemBySlug,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
});
afterAll(async () => {
  await t.cleanup();
});

/**
 * Every item that exists only as a drop or a reward: enabled (so it can be
 * generated, stored, claimed and used) but sold in no region. Shibari Rope is
 * *not* here — it is sold exclusively in Twin Peeks.
 */
const GIFT_ONLY_SLUGS = [
  'quickie_coffee',
  'reach_around',
  'full_body_massage',
  'fluffy_cuffs',
  'mythic_contract',
] as const;

describe('shop catalog', () => {
  it('lists the union of every region shop — the sold-somewhere items', async () => {
    const catalog = await app.shop.getCatalog();
    const bySlug = new Map(catalog.map((e) => [e.item.slug, e]));
    expect([...bySlug.keys()].sort()).toEqual([
      'basic_charm',
      'energy_drink',
      'microdose',
      'prismatic_charm',
      'shibari_rope',
      'silk_charm',
      'velvet_charm',
    ]);
    for (const entry of catalog) {
      expect(entry.available).toBe(true);
      expect(entry.availabilityNote).toBeNull();
      expect(entry.item.enabled).toBe(true);
      expect(entry.item.shopRegions.length).toBeGreaterThan(0);
      expect(entry.item.buyPrice).not.toBeNull();
    }
  });

  it('exposes each entry with the currency its price is denominated in', async () => {
    const bySlug = new Map((await app.shop.getCatalog()).map((e) => [e.item.slug, e]));
    expect(bySlug.get('basic_charm')).toMatchObject({ available: true, currency: 'waifubux' });
    expect(bySlug.get('energy_drink')).toMatchObject({ available: true, currency: 'waifubux' });
    expect(bySlug.get('microdose')).toMatchObject({ available: true, currency: 'essence' });
  });

  it("lists Waifu Valley's shelf but not the Twin Peeks-exclusive rope", async () => {
    const listed = new Set(
      (await app.shop.getRegionalCatalog('waifu-valley')).map((e) => e.item.slug),
    );
    expect(listed).toEqual(
      new Set(['basic_charm', 'silk_charm', 'velvet_charm', 'prismatic_charm', 'energy_drink', 'microdose']),
    );
    expect(listed.has('shibari_rope')).toBe(false);
  });

  it('sells Shibari Rope only from the Twin Peeks shelf', async () => {
    const twinPeeks = await app.shop.getRegionalCatalog('twin-peeks');
    expect(twinPeeks.map((e) => e.item.slug)).toEqual(['shibari_rope']);
    expect(twinPeeks[0]?.item.buyPrice).toBe(750);
  });

  it('leaves a region no item names with an empty shelf', async () => {
    expect(await app.shop.getRegionalCatalog('flaccid-foothills')).toEqual([]);
  });

  it('never lists an item sold in no region — the gift-only rows', async () => {
    // Guard the premise: these are all still *enabled*, so the shop is
    // filtering on `shopRegions`, not quietly on `enabled`.
    const rows = await t.db
      .select()
      .from(items)
      .where(inArray(items.slug, [...GIFT_ONLY_SLUGS]));
    expect(rows).toHaveLength(GIFT_ONLY_SLUGS.length);
    for (const row of rows) {
      expect(row.enabled).toBe(true);
      expect(row.shopRegions).toEqual([]);
    }

    const listed = new Set((await app.shop.getCatalog()).map((e) => e.item.slug));
    for (const slug of GIFT_ONLY_SLUGS) {
      expect(listed.has(slug)).toBe(false);
    }
  });

  it('drops an item from the catalog the moment its shop_regions are cleared', async () => {
    await t.db.update(items).set({ shopRegions: [] }).where(eq(items.slug, 'silk_charm'));
    try {
      const listed = new Set((await app.shop.getCatalog()).map((e) => e.item.slug));
      expect(listed.has('silk_charm')).toBe(false);
      expect(listed.has('basic_charm')).toBe(true);
    } finally {
      await t.db
        .update(items)
        .set({ shopRegions: ['waifu-valley'] })
        .where(eq(items.slug, 'silk_charm'));
    }
  });

  it('does not list disabled items', async () => {
    await t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'velvet_charm'));
    try {
      const listed = new Set((await app.shop.getCatalog()).map((e) => e.item.slug));
      expect(listed.has('velvet_charm')).toBe(false);
      expect(listed.has('basic_charm')).toBe(true);
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'velvet_charm'));
    }
  });
});

describe('shop purchase', () => {
  it('buys Basic, Silk, and Velvet Charms with WaifuBux and writes audit rows', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-1');
    await app.currency.grantWaifubux(t.db, playerId, 500);

    const basic = await app.shop.purchase(playerId, 'basic_charm');
    expect(basic.totalPrice).toBe(25);
    expect(basic.balanceAfter).toBe(475);
    const silk = await app.shop.purchase(playerId, 'silk_charm');
    expect(silk.balanceAfter).toBe(400);
    const velvet = await app.shop.purchase(playerId, 'velvet_charm');
    expect(velvet.balanceAfter).toBe(200);

    const audits = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId))
      .orderBy(shopTransactions.id);
    expect(audits).toHaveLength(3);
    expect(audits.map((a) => a.totalPrice)).toEqual([25, 75, 200]);
    expect(audits.map((a) => a.balanceAfter)).toEqual([475, 400, 200]);
    expect(audits[0]?.unitPrice).toBe(25);
    expect(audits[0]?.quantity).toBe(1);

    const basicItem = await getItemBySlug(t.db, 'basic_charm');
    expect(await app.inventory.getQuantity(playerId, basicItem.id)).toBe(1);
  });

  it('rejects purchases the player cannot afford — nothing changes', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-broke');
    await app.currency.grantWaifubux(t.db, playerId, 20);
    await expect(app.shop.purchase(playerId, 'basic_charm')).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(20);
    const audits = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audits).toHaveLength(0);
  });

  it('sells the Prismatic Charm in Waifu Valley for Essence', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-prism');
    await app.currency.grantEssence(t.db, playerId, 2_000);
    const bought = await app.shop.purchase(playerId, 'prismatic_charm');
    expect(bought.currency).toBe('essence');
    expect(bought.totalPrice).toBe(1750);
    expect((await app.currency.getBalances(playerId)).essence).toBe(250);
  });

  it('rejects the Mythic Contract (never sold), regardless of balance', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-mythic');
    await app.currency.grantWaifubux(t.db, playerId, 1_000_000);
    await expect(app.shop.purchase(playerId, 'mythic_contract')).rejects.toBeInstanceOf(
      ItemNotPurchasableError,
    );
  });

  it('refuses the Twin Peeks-exclusive rope while the player is in Waifu Valley', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-rope-here');
    await app.currency.grantWaifubux(t.db, playerId, 10_000);
    await expect(app.shop.purchase(playerId, 'shibari_rope')).rejects.toBeInstanceOf(
      ItemNotSoldHereError,
    );
    // Nothing spent.
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(10_000);
    const rope = await getItemBySlug(t.db, 'shibari_rope');
    expect(await app.inventory.getQuantity(playerId, rope.id)).toBe(0);
  });

  it('sells the rope once the player is standing in Twin Peeks', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-rope-there');
    await app.currency.grantWaifubux(t.db, playerId, 10_000);
    await forceRegion(t.db, playerId, 'twin-peeks');
    const bought = await app.shop.purchase(playerId, 'shibari_rope');
    expect(bought.totalPrice).toBe(750);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(9_250);
    const rope = await getItemBySlug(t.db, 'shibari_rope');
    expect(await app.inventory.getQuantity(playerId, rope.id)).toBe(1);
  });

  it('rejects disabled items', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-disabled');
    await app.currency.grantWaifubux(t.db, playerId, 1_000);
    await t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'velvet_charm'));
    try {
      await expect(app.shop.purchase(playerId, 'velvet_charm')).rejects.toBeInstanceOf(
        ItemNotFoundError,
      );
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'velvet_charm'));
    }
  });

  it.each([...GIFT_ONLY_SLUGS])(
    'rejects a direct purchase of the sold-nowhere %s, however rich the player',
    async (slug) => {
      const { playerId } = await provisionPlayer(app, 'g-shop', `u-gift-${slug}`);
      await app.currency.grantWaifubux(t.db, playerId, 1_000_000);
      await app.currency.grantEssence(t.db, playerId, 1_000_000);
      await expect(app.shop.purchase(playerId, slug)).rejects.toBeInstanceOf(
        ItemNotPurchasableError,
      );
      // Nothing spent, nothing granted, no audit row.
      const item = await getItemBySlug(t.db, slug);
      expect(await app.inventory.getQuantity(playerId, item.id)).toBe(0);
      const balances = await app.currency.getBalances(playerId);
      expect(balances.waifubux).toBe(1_000_000);
      expect(balances.essence).toBe(1_000_000);
      const audits = await t.db
        .select()
        .from(shopTransactions)
        .where(eq(shopTransactions.playerId, playerId));
      expect(audits).toHaveLength(0);
    },
  );

  it('rejects unknown items', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-unknown');
    await expect(app.shop.purchase(playerId, 'love_potion')).rejects.toBeInstanceOf(
      ItemNotFoundError,
    );
  });

  it('rejects purchases over the capture-item capacity before charging', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-capped');
    await app.currency.grantWaifubux(t.db, playerId, 10_000);
    const basic = await getItemBySlug(t.db, 'basic_charm');
    await app.inventory.addItem(t.db, playerId, basic.id, 50); // at the cap
    await expect(app.shop.purchase(playerId, 'basic_charm')).rejects.toBeInstanceOf(
      InventoryCapacityError,
    );
    // Nothing charged, nothing granted, no audit row.
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(10_000);
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(50);
    const audits = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audits).toHaveLength(0);
  });

  it('buys an Essence-priced item from the Essence balance, leaving WaifuBux alone', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-essence');
    await app.currency.grantEssence(t.db, playerId, 100);
    await app.currency.grantWaifubux(t.db, playerId, 100);

    const result = await app.shop.purchase(playerId, 'microdose');
    expect(result.currency).toBe('essence');
    expect(result.totalPrice).toBe(40);
    expect(result.balanceAfter).toBe(60);

    const balances = await app.currency.getBalances(playerId);
    expect(balances.essence).toBe(60);
    expect(balances.waifubux).toBe(100); // untouched

    const [audit] = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audit).toMatchObject({ currency: 'essence', totalPrice: 40, balanceAfter: 60 });
  });

  it('buys a WaifuBux-priced consumable and records waifubux on the audit row', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-drink');
    await app.currency.grantWaifubux(t.db, playerId, 600);

    const result = await app.shop.purchase(playerId, 'energy_drink');
    expect(result).toMatchObject({ currency: 'waifubux', totalPrice: 500, balanceAfter: 100 });

    const drink = await getItemBySlug(t.db, 'energy_drink');
    expect(await app.inventory.getQuantity(playerId, drink.id)).toBe(1);
    const [audit] = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audit?.currency).toBe('waifubux');
  });

  it('blocks an Essence purchase with insufficient Essence — even when rich in WaifuBux', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-no-essence');
    await app.currency.grantWaifubux(t.db, playerId, 100_000);
    await app.currency.grantEssence(t.db, playerId, 39);

    await expect(app.shop.purchase(playerId, 'microdose')).rejects.toBeInstanceOf(
      InsufficientEssenceError,
    );

    // Nothing partially granted: no item, no spend, no audit row.
    const microdose = await getItemBySlug(t.db, 'microdose');
    expect(await app.inventory.getQuantity(playerId, microdose.id)).toBe(0);
    const balances = await app.currency.getBalances(playerId);
    expect(balances.essence).toBe(39);
    expect(balances.waifubux).toBe(100_000);
    const audits = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audits).toHaveLength(0);
  });

  it('does not count consumables against the capture-item capacity', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-consumable-cap');
    await app.currency.grantWaifubux(t.db, playerId, 5_000);
    const basic = await getItemBySlug(t.db, 'basic_charm');
    await app.inventory.addItem(t.db, playerId, basic.id, 50); // capture items at the cap

    const result = await app.shop.purchase(playerId, 'energy_drink');
    expect(result.ownedAfter).toBe(1);
  });

  it('concurrent purchases drain the balance without ever going negative', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-race');
    await app.currency.grantWaifubux(t.db, playerId, 100); // affords 4 basic charms
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => app.shop.purchase(playerId, 'basic_charm')),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(4);
    const balances = await app.currency.getBalances(playerId);
    expect(balances.waifubux).toBe(0);
    const basic = await getItemBySlug(t.db, 'basic_charm');
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(4);
    const audits = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(audits).toHaveLength(4);
  });
});

/**
 * Charm Exchange: the shop's inventory sink. A fixed 10:1 ladder that trades
 * lower-tier charms one tier up, with no currency cost and no cascading.
 */
describe('charm exchange', () => {
  async function grantCharm(playerId: number, slug: string, quantity: number): Promise<number> {
    const item = await getItemBySlug(t.db, slug);
    return app.inventory.addItem(t.db, playerId, item.id, quantity);
  }
  async function ownedCharm(playerId: number, slug: string): Promise<number> {
    const item = await getItemBySlug(t.db, slug);
    return app.inventory.getQuantity(playerId, item.id);
  }

  it('exposes exactly the three upward-tier recipes with live standings', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-catalog');
    await grantCharm(playerId, 'basic_charm', 47);
    await grantCharm(playerId, 'silk_charm', 3);

    const rows = await app.shop.getCharmExchange(playerId);
    expect(rows.map((r) => r.recipe.id)).toEqual(['basic_silk', 'silk_velvet', 'velvet_prismatic']);

    const basicRow = rows.find((r) => r.recipe.id === 'basic_silk')!;
    expect(basicRow.inputItem.slug).toBe('basic_charm');
    expect(basicRow.outputItem.slug).toBe('silk_charm');
    expect(basicRow.recipe.inputQuantity).toBe(10);
    expect(basicRow.recipe.outputQuantity).toBe(1);
    expect(basicRow.ownedInput).toBe(47);
    expect(basicRow.conversionsPossible).toBe(4);

    const silkRow = rows.find((r) => r.recipe.id === 'silk_velvet')!;
    expect(silkRow.ownedInput).toBe(3);
    expect(silkRow.conversionsPossible).toBe(0);

    // Prismatic is the end of the ladder — it is never an input.
    expect(rows.some((r) => r.recipe.inputSlug === 'prismatic_charm')).toBe(false);
  });

  it('converts 10 Basic Charms into 1 Silk Charm (Convert 1)', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-basic-one');
    await grantCharm(playerId, 'basic_charm', 10);

    const result = await app.shop.convertCharms(playerId, 'basic_silk', 'one');
    expect(result).toMatchObject({
      conversions: 1,
      inputConsumed: 10,
      outputGranted: 1,
      ownedInputAfter: 0,
      ownedOutputAfter: 1,
    });
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(0);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(1);
  });

  it('converts 10 Silk Charms into 1 Velvet Charm', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-silk-one');
    await grantCharm(playerId, 'silk_charm', 10);

    await app.shop.convertCharms(playerId, 'silk_velvet', 'one');
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(0);
    expect(await ownedCharm(playerId, 'velvet_charm')).toBe(1);
  });

  it('converts 10 Velvet Charms into 1 Prismatic Charm', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-velvet-one');
    await grantCharm(playerId, 'velvet_charm', 10);

    await app.shop.convertCharms(playerId, 'velvet_prismatic', 'one');
    expect(await ownedCharm(playerId, 'velvet_charm')).toBe(0);
    expect(await ownedCharm(playerId, 'prismatic_charm')).toBe(1);
  });

  it('Convert 1 consumes exactly 10 and grants exactly 1, leaving the rest', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-basic-one-rest');
    await grantCharm(playerId, 'basic_charm', 25);

    const result = await app.shop.convertCharms(playerId, 'basic_silk', 'one');
    expect(result.inputConsumed).toBe(10);
    expect(result.outputGranted).toBe(1);
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(15);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(1);
  });

  it('Convert Max converts floor(quantity / 10) and leaves the remainder', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-basic-max');
    await grantCharm(playerId, 'basic_charm', 47);

    const result = await app.shop.convertCharms(playerId, 'basic_silk', 'max');
    expect(result).toMatchObject({ conversions: 4, inputConsumed: 40, outputGranted: 4 });
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(7);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(4);
  });

  it('Convert Max applies to one recipe only — it never cascades to the next tier', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-no-cascade');
    await grantCharm(playerId, 'basic_charm', 100);

    const result = await app.shop.convertCharms(playerId, 'basic_silk', 'max');
    expect(result.outputGranted).toBe(10);
    // The 10 new Silk Charms are NOT rolled up into a Velvet Charm.
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(0);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(10);
    expect(await ownedCharm(playerId, 'velvet_charm')).toBe(0);
  });

  it('rejects a conversion with insufficient input and mutates nothing', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-insufficient');
    await grantCharm(playerId, 'basic_charm', 5);

    await expect(app.shop.convertCharms(playerId, 'basic_silk', 'one')).rejects.toBeInstanceOf(
      InsufficientCharmsError,
    );
    await expect(app.shop.convertCharms(playerId, 'basic_silk', 'max')).rejects.toBeInstanceOf(
      InsufficientCharmsError,
    );
    // Nothing consumed, nothing granted.
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(5);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(0);
  });

  it('rejects an unknown recipe id', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-bad-recipe');
    await grantCharm(playerId, 'basic_charm', 100);
    await expect(
      app.shop.convertCharms(playerId, 'basic_prismatic', 'max'),
    ).rejects.toBeInstanceOf(CharmRecipeNotFoundError);
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(100);
  });

  it('concurrent Convert 1 clicks never duplicate the output or overdraw the input', async () => {
    const { playerId } = await provisionPlayer(app, 'g-exch', 'u-exch-race');
    await grantCharm(playerId, 'basic_charm', 10); // enough for exactly one conversion

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => app.shop.convertCharms(playerId, 'basic_silk', 'one')),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);
    expect(await ownedCharm(playerId, 'basic_charm')).toBe(0);
    expect(await ownedCharm(playerId, 'silk_charm')).toBe(1);
  });
});
