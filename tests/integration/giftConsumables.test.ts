/**
 * The three gift-exclusive energy consumables — real Postgres.
 *
 * Quickie Coffee and Reach Around share one new `restore_energy_amount`
 * effect; Full Body Massage deliberately reuses Energy Drink's existing
 * `restore_energy_full`. All three exit Care Mode, and all three obey the same
 * "never above the computed max, never burned for nothing" rules the drink
 * already had.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  playerCurrencies,
  playerInventory,
  players,
  species,
} from '../../src/db/schema';
import { formatItemUseResult } from '../../src/discord/commands/waifumon';
import {
  EnergyAlreadyFullError,
  InsufficientItemsError,
} from '../../src/shared/errors';
import {
  bootstrapApp,
  getItemBySlug,
  insertOwnedWaifu,
  provisionPlayer,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let maxEnergy: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-gift-consumables', 'u-1'));
  const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
  maxEnergy = app.progression.computeMaxEnergy(player!.level);
});
afterAll(async () => {
  await t.cleanup();
});

async function grant(slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, qty);
}

async function setEnergy(value: number): Promise<void> {
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: value })
    .where(eq(playerCurrencies.playerId, playerId));
}

async function energy(): Promise<number> {
  return (await app.currency.getBalances(playerId)).huntEnergy;
}

/** Care Mode needs a target; reuse an owned copy, minting one on first call. */
async function careTarget(): Promise<number> {
  const owned = await app.collection.listOwned(playerId);
  const existing = owned.entries[0]?.waifu.id;
  if (existing != null) return existing;
  const [speciesRow] = await t.db.select().from(species).limit(1);
  const row = await insertOwnedWaifu(t.db, { playerId, speciesId: speciesRow!.id });
  return row!.id;
}

beforeEach(async () => {
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db
    .update(players)
    .set({ careModeStartedAt: null, careModeLastTickAt: null, careModeWaifuId: null })
    .where(eq(players.id, playerId));
  await setEnergy(0);
});

describe('content + seeding', () => {
  it('seeds each item with the documented effect config', async () => {
    expect(await getItemBySlug(t.db, 'quickie_coffee')).toMatchObject({
      category: 'consumable',
      effectType: 'restore_energy_amount',
      purchasable: false,
      emoji: '☕',
    });
    expect((await getItemBySlug(t.db, 'quickie_coffee')).effectConfig).toMatchObject({
      amount: 5,
      exitCareMode: true,
    });

    expect((await getItemBySlug(t.db, 'reach_around')).effectConfig).toMatchObject({
      amount: 10,
      exitCareMode: true,
    });

    // Reuses the Energy Drink effect rather than inventing a parallel one.
    expect(await getItemBySlug(t.db, 'full_body_massage')).toMatchObject({
      category: 'consumable',
      effectType: 'restore_energy_full',
    });
    expect((await getItemBySlug(t.db, 'full_body_massage')).effectConfig).toMatchObject({
      restoreToMax: true,
      exitCareMode: true,
    });
  });
});

describe('amount-based restores', () => {
  it.each([
    ['quickie_coffee', 5],
    ['reach_around', 10],
  ])('%s restores %i energy', async (slug, amount) => {
    await grant(slug as string, 1);
    await setEnergy(0);
    const result = await app.itemUse.use(playerId, slug as string);
    expect(result.kind).toBe('restore_energy_amount');
    if (result.kind === 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.energyBefore).toBe(0);
    expect(result.energyAfter).toBe(amount);
    expect(result.restoreAmount).toBe(amount);
    expect(await energy()).toBe(amount);
    // Exactly one copy consumed.
    const item = await getItemBySlug(t.db, slug as string);
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(0);
  });

  it('clamps at the computed max and spills the remainder', async () => {
    await grant('reach_around', 1);
    await setEnergy(maxEnergy - 2);
    const result = await app.itemUse.use(playerId, 'reach_around');
    if (result.kind === 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.energyAfter).toBe(maxEnergy);
    expect(result.restoreAmount).toBe(10);
    expect(await energy()).toBe(maxEnergy);
    // The status line reports what landed, not what was promised.
    expect(formatItemUseResult(result)).toContain('+2');
    expect(formatItemUseResult(result)).toContain('(capped)');
  });

  it('refuses at full energy without consuming the item', async () => {
    await grant('quickie_coffee', 1);
    await setEnergy(maxEnergy);
    await expect(app.itemUse.use(playerId, 'quickie_coffee')).rejects.toBeInstanceOf(
      EnergyAlreadyFullError,
    );
    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(1);
    expect(await energy()).toBe(maxEnergy);
  });

  it('refuses when the player owns none', async () => {
    await setEnergy(0);
    await expect(app.itemUse.use(playerId, 'quickie_coffee')).rejects.toBeInstanceOf(
      InsufficientItemsError,
    );
    expect(await energy()).toBe(0);
  });

  it('exits Care Mode, crediting pending ticks first', async () => {
    await grant('quickie_coffee', 1);
    await app.care.start(playerId, await careTarget());
    expect((await app.care.getState(playerId)).active).toBe(true);

    await setEnergy(0);
    const result = await app.itemUse.use(playerId, 'quickie_coffee');
    if (result.kind === 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.careModeExited).toBe(true);
    expect((await app.care.getState(playerId)).active).toBe(false);
  });
});

describe('Full Body Massage', () => {
  it('restores to the computed maximum', async () => {
    await grant('full_body_massage', 1);
    await setEnergy(1);
    const result = await app.itemUse.use(playerId, 'full_body_massage');
    expect(result.kind).toBe('restore_energy_full');
    if (result.kind === 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.energyAfter).toBe(maxEnergy);
    expect(result.restoreAmount).toBeNull();
    expect(await energy()).toBe(maxEnergy);
  });

  it('refuses at full energy without consuming it', async () => {
    await grant('full_body_massage', 1);
    await setEnergy(maxEnergy);
    await expect(app.itemUse.use(playerId, 'full_body_massage')).rejects.toBeInstanceOf(
      EnergyAlreadyFullError,
    );
    const item = await getItemBySlug(t.db, 'full_body_massage');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(1);
  });

  it('exits Care Mode like the Energy Drink it shares an effect with', async () => {
    await grant('full_body_massage', 1);
    await app.care.start(playerId, await careTarget());
    await setEnergy(0);
    const result = await app.itemUse.use(playerId, 'full_body_massage');
    if (result.kind === 'capture_bonus_charges') throw new Error('unreachable');
    expect(result.careModeExited).toBe(true);
  });
});
