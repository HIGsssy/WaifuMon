import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InsufficientFundsError, InsufficientItemsError } from '../../src/shared/errors';
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

describe('currency service', () => {
  it('grants and spends WaifuBux', async () => {
    const { playerId } = await provisionPlayer(app, 'g-cur', 'u-1');
    await app.currency.grantWaifubux(t.db, playerId, 300);
    const after = await app.currency.spendWaifubux(t.db, playerId, 120);
    expect(after.waifubux).toBe(180);
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(180);
  });

  it('rejects overspends and leaves the balance untouched', async () => {
    const { playerId } = await provisionPlayer(app, 'g-cur', 'u-2');
    await app.currency.grantWaifubux(t.db, playerId, 50);
    await expect(app.currency.spendWaifubux(t.db, playerId, 51)).rejects.toBeInstanceOf(
      InsufficientFundsError,
    );
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(50);
  });

  it('never goes negative under concurrent spends', async () => {
    const { playerId } = await provisionPlayer(app, 'g-cur', 'u-3');
    await app.currency.grantWaifubux(t.db, playerId, 100);
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        t.db.transaction(async (tx) => {
          await app.currency.lockCurrencies(tx, playerId);
          return app.currency.spendWaifubux(tx, playerId, 40);
        }),
      ),
    );
    const succeeded = attempts.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(2); // 100 / 40
    expect((await app.currency.getBalances(playerId)).waifubux).toBe(20);
  });

  it('sets hunt energy', async () => {
    const { playerId } = await provisionPlayer(app, 'g-cur', 'u-4');
    await app.currency.setHuntEnergy(t.db, playerId, 0);
    expect((await app.currency.getBalances(playerId)).huntEnergy).toBe(0);
  });
});

describe('inventory service', () => {
  it('adds and stacks items', async () => {
    const { playerId } = await provisionPlayer(app, 'g-inv', 'u-1');
    const basic = await getItemBySlug(t.db, 'basic_charm');
    expect(await app.inventory.addItem(t.db, playerId, basic.id, 3)).toBe(3);
    expect(await app.inventory.addItem(t.db, playerId, basic.id, 2)).toBe(5);
    expect(await app.inventory.getQuantity(playerId, basic.id)).toBe(5);
  });

  it('consumes items conditionally, never below zero', async () => {
    const { playerId } = await provisionPlayer(app, 'g-inv', 'u-2');
    const silk = await getItemBySlug(t.db, 'silk_charm');
    await app.inventory.addItem(t.db, playerId, silk.id, 2);
    expect(await app.inventory.consumeItem(t.db, playerId, silk.id, 1)).toBe(1);
    await expect(app.inventory.consumeItem(t.db, playerId, silk.id, 2)).rejects.toBeInstanceOf(
      InsufficientItemsError,
    );
    expect(await app.inventory.getQuantity(playerId, silk.id)).toBe(1);
  });

  it('counts capture items across the inventory for the capacity check', async () => {
    const { playerId } = await provisionPlayer(app, 'g-inv', 'u-3');
    const basic = await getItemBySlug(t.db, 'basic_charm');
    const velvet = await getItemBySlug(t.db, 'velvet_charm');
    await app.inventory.addItem(t.db, playerId, basic.id, 10);
    await app.inventory.addItem(t.db, playerId, velvet.id, 4);
    expect(await app.inventory.countCaptureItems(t.db, playerId)).toBe(14);
  });

  it('lists inventory entries joined with item data', async () => {
    const { playerId } = await provisionPlayer(app, 'g-inv', 'u-4');
    const mythic = await getItemBySlug(t.db, 'mythic_contract');
    await app.inventory.addItem(t.db, playerId, mythic.id, 1);
    const entries = await app.inventory.getInventory(playerId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.item.isGuaranteedCapture).toBe(true);
    expect(entries[0]?.quantity).toBe(1);
  });
});
