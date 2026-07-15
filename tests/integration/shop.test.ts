import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { items, shopTransactions } from '../../src/db/schema';
import {
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

describe('shop catalog', () => {
  it('lists all 5 capture items: 3 buyable, Prismatic unavailable, Mythic not for sale', async () => {
    const catalog = await app.shop.getCatalog();
    const bySlug = new Map(catalog.map((e) => [e.item.slug, e]));
    expect(catalog).toHaveLength(5);
    for (const slug of ['basic_charm', 'silk_charm', 'velvet_charm']) {
      expect(bySlug.get(slug)?.available).toBe(true);
    }
    expect(bySlug.get('prismatic_charm')?.available).toBe(false);
    expect(bySlug.get('prismatic_charm')?.availabilityNote).toBe('Unavailable');
    expect(bySlug.get('mythic_contract')?.available).toBe(false);
    expect(bySlug.get('mythic_contract')?.availabilityNote).toBe('Not for sale');
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
