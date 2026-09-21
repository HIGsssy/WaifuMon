/**
 * Expeditions Phase 2 — selling salvage for WaifuBux.
 *
 * Salvage gets a sink *before* anything produces it, which is what lets Phase 5
 * tune reward tables against a counter that already works.
 *
 * The theme of these tests is that a sale is one transaction or it is nothing.
 * Inventory and balance must move together or not at all, and the double-click
 * case — two sells of the same stack arriving at once — must pay out once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { items, shopTransactions } from '../../src/db/schema';
import { InsufficientItemsError, ItemNotSellableError } from '../../src/shared/errors';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
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
 * Seed one item directly. Phase 2 ships no salvage content — Phase 5 does —
 * so these tests author their own rather than coupling to a catalog that does
 * not exist yet.
 */
let seq = 0;
async function seedItem(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [row] = await t.db
    .insert(items)
    .values({
      slug: `sell_test_${seq}`,
      name: `Sell Test ${seq}`,
      category: 'salvage',
      sellValue: 40,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return row;
}

async function give(playerId: number, itemId: number, quantity: number) {
  await app.inventory.addItem(t.db, playerId, itemId, quantity);
}

const balanceOf = async (playerId: number) =>
  (await app.currency.getBalances(playerId)).waifubux;

const ownedOf = async (playerId: number, slug: string) =>
  (await app.inventory.getInventory(playerId)).find((e) => e.item.slug === slug)?.quantity ?? 0;

describe('getSellableInventory', () => {
  it('lists an owned salvage stack with its unit and stack value', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-list');
    const scrap = await seedItem({ sellValue: 25 });
    await give(playerId, scrap.id, 4);

    const sellable = await app.shop.getSellableInventory(playerId);
    const entry = sellable.find((e) => e.item.slug === scrap.slug);
    expect(entry).toBeDefined();
    expect(entry?.quantity).toBe(4);
    expect(entry?.unitValue).toBe(25);
    expect(entry?.stackValue).toBe(100);
  });

  it('omits an item with no sell value, however much of it the player owns', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-nosell');
    const junk = await seedItem({ category: 'material', sellValue: null });
    await give(playerId, junk.id, 10);

    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug)).not.toContain(junk.slug);
  });

  it('omits a disabled item — retirement withdraws it from the counter too', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-disabled');
    const retired = await seedItem({ enabled: false });
    await give(playerId, retired.id, 3);

    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug)).not.toContain(retired.slug);
  });

  it('omits an item the player does not own', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-unowned');
    const unowned = await seedItem();
    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug)).not.toContain(unowned.slug);
  });

  it('omits a stack the player has sold down to zero', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-emptied');
    const scrap = await seedItem();
    await give(playerId, scrap.id, 2);
    await app.shop.sellItem(playerId, scrap.slug, 2);

    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug)).not.toContain(scrap.slug);
  });

  // A key item is sellable only because content said so twice; one that never
  // opted in has no sell value and therefore never reaches the counter.
  it('omits a key item that was never made explicitly sellable', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-key');
    const key = await seedItem({ category: 'key', sellValue: null });
    await give(playerId, key.id, 1);

    const sellable = await app.shop.getSellableInventory(playerId);
    expect(sellable.map((e) => e.item.slug)).not.toContain(key.slug);
    await expect(app.shop.sellItem(playerId, key.slug, 1)).rejects.toBeInstanceOf(
      ItemNotSellableError,
    );
    expect(await ownedOf(playerId, key.slug)).toBe(1);
  });

  it('orders the most valuable stack first', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-order');
    const cheap = await seedItem({ sellValue: 10 });
    const dear = await seedItem({ sellValue: 900 });
    await give(playerId, cheap.id, 1);
    await give(playerId, dear.id, 1);

    const slugs = (await app.shop.getSellableInventory(playerId)).map((e) => e.item.slug);
    expect(slugs.indexOf(dear.slug)).toBeLessThan(slugs.indexOf(cheap.slug));
  });
});

describe('sellItem', () => {
  it.each([
    ['one', 1, 50],
    ['five', 5, 250],
  ])('sells %s and moves inventory and balance together', async (_label, qty, expected) => {
    const { playerId } = await provisionPlayer(app, 'g-sell', `u-qty-${qty}`);
    const scrap = await seedItem({ sellValue: 50 });
    await give(playerId, scrap.id, 8);

    const result = await app.shop.sellItem(playerId, scrap.slug, qty as number);
    expect(result.totalValue).toBe(expected);
    expect(result.unitValue).toBe(50);
    expect(result.ownedAfter).toBe(8 - (qty as number));
    expect(result.balanceAfter).toBe(expected);
    expect(await balanceOf(playerId)).toBe(expected);
    expect(await ownedOf(playerId, scrap.slug)).toBe(8 - (qty as number));
  });

  it('sells a whole stack', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-all');
    const scrap = await seedItem({ sellValue: 33 });
    await give(playerId, scrap.id, 7);

    const result = await app.shop.sellItem(playerId, scrap.slug, 7);
    expect(result.totalValue).toBe(231);
    expect(result.ownedAfter).toBe(0);
    expect(await balanceOf(playerId)).toBe(231);
  });

  // The whole point of consuming before granting: the refusal has to leave
  // *both* sides untouched, not just the one the error is named after.
  it('refuses to sell more than owned and mutates nothing', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-over');
    const scrap = await seedItem({ sellValue: 60 });
    await give(playerId, scrap.id, 3);

    await expect(app.shop.sellItem(playerId, scrap.slug, 4)).rejects.toBeInstanceOf(
      InsufficientItemsError,
    );
    expect(await ownedOf(playerId, scrap.slug)).toBe(3);
    expect(await balanceOf(playerId)).toBe(0);
  });

  it('throws ItemNotSellableError for an item with no sell value', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-throw');
    const junk = await seedItem({ category: 'material', sellValue: null });
    await give(playerId, junk.id, 5);

    await expect(app.shop.sellItem(playerId, junk.slug, 1)).rejects.toBeInstanceOf(
      ItemNotSellableError,
    );
    expect(await ownedOf(playerId, junk.slug)).toBe(5);
    expect(await balanceOf(playerId)).toBe(0);
  });

  it.each([0, -1, 1.5])('rejects a quantity of %s without touching anything', async (qty) => {
    const { playerId } = await provisionPlayer(app, 'g-sell', `u-badqty-${qty}`);
    const scrap = await seedItem();
    await give(playerId, scrap.id, 5);

    await expect(app.shop.sellItem(playerId, scrap.slug, qty)).rejects.toBeInstanceOf(RangeError);
    expect(await ownedOf(playerId, scrap.slug)).toBe(5);
    expect(await balanceOf(playerId)).toBe(0);
  });

  /**
   * The double-click. Two sells of the same two-item stack race; the
   * conditional decrement means exactly one can win, and the loser must not
   * have been paid before it lost.
   */
  it('pays out once when the same stack is sold twice concurrently', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-race');
    const scrap = await seedItem({ sellValue: 100 });
    await give(playerId, scrap.id, 2);

    const attempts = await Promise.allSettled([
      app.shop.sellItem(playerId, scrap.slug, 2),
      app.shop.sellItem(playerId, scrap.slug, 2),
    ]);
    const fulfilled = attempts.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await ownedOf(playerId, scrap.slug)).toBe(0);
    expect(await balanceOf(playerId)).toBe(200);
  });
});

describe('audit trail', () => {
  it('writes a sale row with the payout and the post-credit balance', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-audit');
    const scrap = await seedItem({ sellValue: 45 });
    await give(playerId, scrap.id, 3);
    await app.currency.grantWaifubux(t.db, playerId, 1000);

    await app.shop.sellItem(playerId, scrap.slug, 2);

    const [row] = await t.db
      .select()
      .from(shopTransactions)
      .where(and(eq(shopTransactions.playerId, playerId), eq(shopTransactions.kind, 'sale')));
    expect(row).toBeDefined();
    expect(row?.itemId).toBe(scrap.id);
    // Quantity and price keep their plain meanings in both directions —
    // direction is read off `kind`, never off a sign.
    expect(row?.quantity).toBe(2);
    expect(row?.unitPrice).toBe(45);
    expect(row?.totalPrice).toBe(90);
    expect(row?.currency).toBe('waifubux');
    expect(row?.balanceAfter).toBe(1090);
  });

  it('still records a purchase as kind=purchase, so one ledger answers both', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-buy');
    await app.currency.grantWaifubux(t.db, playerId, 5000);
    await app.shop.purchase(playerId, 'basic_charm', 1);

    const rows = await t.db
      .select()
      .from(shopTransactions)
      .where(eq(shopTransactions.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('purchase');
  });

  // An Essence-priced item is not an Essence printer: what an item costs to
  // buy says nothing about what the counter pays out.
  it('always pays WaifuBux, even for an Essence-priced item', async () => {
    const { playerId } = await provisionPlayer(app, 'g-sell', 'u-essence');
    const exotic = await seedItem({ sellValue: 70, priceCurrency: 'essence' });
    await give(playerId, exotic.id, 1);

    const result = await app.shop.sellItem(playerId, exotic.slug, 1);
    expect(result.balanceAfter).toBe(70);
    const balances = await app.currency.getBalances(playerId);
    expect(balances.waifubux).toBe(70);
    expect(balances.essence).toBe(0);
  });
});
