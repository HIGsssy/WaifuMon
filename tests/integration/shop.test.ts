import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items, shopTransactions } from '../../src/db/schema';
import {
  InsufficientEssenceError,
  InsufficientFundsError,
  InventoryCapacityError,
  ItemNotFoundError,
  ItemNotPurchasableError,
} from '../../src/shared/errors';
import { bootstrapApp, getItemBySlug, provisionPlayer, type App } from '../helpers/fixtures';
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
 * generated, stored, claimed and used) but never for sale.
 */
const GIFT_ONLY_SLUGS = [
  'quickie_coffee',
  'reach_around',
  'full_body_massage',
  'fluffy_cuffs',
  'shibari_rope',
  'mythic_contract',
] as const;

describe('shop catalog', () => {
  it('lists the buyable charms plus the utility consumables', async () => {
    const catalog = await app.shop.getCatalog();
    const bySlug = new Map(catalog.map((e) => [e.item.slug, e]));
    expect([...bySlug.keys()].sort()).toEqual([
      'basic_charm',
      'energy_drink',
      'microdose',
      'prismatic_charm',
      'silk_charm',
      'velvet_charm',
    ]);
    for (const entry of catalog) {
      expect(entry.available).toBe(true);
      expect(entry.availabilityNote).toBeNull();
      expect(entry.item.enabled).toBe(true);
      expect(entry.item.purchasable).toBe(true);
      expect(entry.item.buyPrice).not.toBeNull();
    }
  });

  it('exposes each entry with the currency its price is denominated in', async () => {
    const bySlug = new Map((await app.shop.getCatalog()).map((e) => [e.item.slug, e]));
    expect(bySlug.get('basic_charm')).toMatchObject({ available: true, currency: 'waifubux' });
    expect(bySlug.get('energy_drink')).toMatchObject({ available: true, currency: 'waifubux' });
    expect(bySlug.get('microdose')).toMatchObject({ available: true, currency: 'essence' });
  });

  it('never lists an enabled-but-non-purchasable item — the gift-only rows', async () => {
    // Guard the premise: these are all still *enabled*, so the shop is
    // filtering on `purchasable`, not quietly on `enabled`.
    const rows = await t.db
      .select()
      .from(items)
      .where(inArray(items.slug, [...GIFT_ONLY_SLUGS]));
    expect(rows).toHaveLength(GIFT_ONLY_SLUGS.length);
    for (const row of rows) {
      expect(row.enabled).toBe(true);
      expect(row.purchasable).toBe(false);
    }

    const listed = new Set((await app.shop.getCatalog()).map((e) => e.item.slug));
    for (const slug of GIFT_ONLY_SLUGS) {
      expect(listed.has(slug)).toBe(false);
    }
  });

  it('drops an item from the catalog the moment it is marked non-purchasable', async () => {
    await t.db.update(items).set({ purchasable: false }).where(eq(items.slug, 'silk_charm'));
    try {
      const listed = new Set((await app.shop.getCatalog()).map((e) => e.item.slug));
      expect(listed.has('silk_charm')).toBe(false);
      expect(listed.has('basic_charm')).toBe(true);
    } finally {
      await t.db.update(items).set({ purchasable: true }).where(eq(items.slug, 'silk_charm'));
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

  it('rejects the Prismatic Charm (listed but disabled at launch)', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-prism');
    await app.currency.grantWaifubux(t.db, playerId, 10_000);
    await expect(app.shop.purchase(playerId, 'prismatic_charm')).rejects.toBeInstanceOf(
      ItemNotPurchasableError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(10_000);
  });

  it('rejects the Mythic Contract (never sold), regardless of balance', async () => {
    const { playerId } = await provisionPlayer(app, 'g-shop', 'u-mythic');
    await app.currency.grantWaifubux(t.db, playerId, 1_000_000);
    await expect(app.shop.purchase(playerId, 'mythic_contract')).rejects.toBeInstanceOf(
      ItemNotPurchasableError,
    );
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
    'rejects a direct purchase of the non-purchasable %s, however rich the player',
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
