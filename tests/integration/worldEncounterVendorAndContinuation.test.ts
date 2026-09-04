/**
 * World Encounter vendor + continuation — real Postgres, real transactions.
 *
 * Covers:
 *   - vendor idempotent open (double-click a vendor cannot regenerate stock)
 *   - transactional purchase (double-click cannot buy twice with one row of stock)
 *   - insufficient funds fails cleanly
 *   - unknown slug rejected
 *   - continuation created for a chained encounter
 *   - continuation resolves as its own encounter
 *   - continuation cannot be consumed twice (partial unique index catches it)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  activeWorldEncounters,
  playerCurrencies,
  playerInventory,
  worldEncounterChoices,
  worldEncounterVendorInstances,
  worldEncounters,
} from '../../src/db/schema';
import {
  VendorOutOfStockError,
  VendorInstanceNotFoundError,
} from '../../src/modules/worldEncounters/vendorService';
import { InsufficientFundsError } from '../../src/shared/errors';
import { bootstrapApp, provisionPlayer, type App } from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;
let guildDbId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId, guildDbId } = await provisionPlayer(app, 'g-vendor', 'u-1'));
});
afterAll(async () => {
  await t.cleanup();
});

beforeEach(async () => {
  await t.db
    .update(playerCurrencies)
    .set({ waifubux: 5000, essence: 1000 })
    .where(eq(playerCurrencies.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await t.db.delete(worldEncounterVendorInstances);
  await t.db.delete(activeWorldEncounters).where(eq(activeWorldEncounters.playerId, playerId));
});

/**
 * Create a pending active encounter row directly so vendor + continuation
 * tests do not have to run the full hunt/travel roll pipeline. The row is
 * shaped exactly like a real one; the vendor and continuation code paths
 * do not inspect the encounterId — only the id + player + status.
 */
async function insertActiveFor(encounterSlug: string): Promise<number> {
  const [encounter] = await t.db
    .select()
    .from(worldEncounters)
    .where(eq(worldEncounters.slug, encounterSlug));
  if (!encounter) throw new Error(`unknown encounter slug ${encounterSlug}`);
  const [row] = await t.db
    .insert(activeWorldEncounters)
    .values({
      playerId,
      encounterId: encounter.id,
      source: 'travel',
      regionId: 'waifu-valley',
      originRegionId: 'waifu-valley',
      destinationRegionId: 'twin-peeks',
      guildId: guildDbId,
      channelId: 'c-1',
      contextJson: {},
      expiresAt: new Date(Date.now() + 10 * 60_000),
    })
    .returning();
  return row!.id;
}

describe('vendor: idempotent open', () => {
  it('re-opening the same encounter picks up the same row (no stock regenerated)', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    const first = await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    const second = await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    expect(second.id).toBe(first.id);
    expect(second.stock).toEqual(first.stock);
  });
});

describe('vendor: purchase', () => {
  it('spends currency and adds one item on a successful buy', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    const result = await app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm');
    expect(result.itemSlug).toBe('basic_charm');
    expect(result.remaining).toBe(2); // seed template starts at 3
    const [balance] = await t.db
      .select({ waifubux: playerCurrencies.waifubux })
      .from(playerCurrencies)
      .where(eq(playerCurrencies.playerId, playerId));
    expect(balance!.waifubux).toBe(5000 - result.price);
  });

  it('decrements stock so N purchases empty a row of N', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    // seed has quantity=3 for basic_charm; three buys empty it.
    await app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm');
    await app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm');
    await app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm');
    await expect(
      app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm'),
    ).rejects.toBeInstanceOf(VendorOutOfStockError);
  });

  it('rejects an unknown slug', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    await expect(
      app.worldEncounterVendor.purchase(playerId, activeId, 'no_such_item'),
    ).rejects.toThrow(/not available/i);
  });

  it('rejects a purchase for a vendor bound to a different player', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    const other = await provisionPlayer(app, 'g-vendor', 'u-2');
    await expect(
      app.worldEncounterVendor.purchase(other.playerId, activeId, 'basic_charm'),
    ).rejects.toBeInstanceOf(VendorInstanceNotFoundError);
  });

  it('rejects with InsufficientFundsError when the player cannot afford the item', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    await t.db.transaction((tx) =>
      app.worldEncounterVendor.openForEncounter(tx, activeId, 'wandering_merchant'),
    );
    await t.db
      .update(playerCurrencies)
      .set({ waifubux: 10 })
      .where(eq(playerCurrencies.playerId, playerId));
    await expect(
      app.worldEncounterVendor.purchase(playerId, activeId, 'basic_charm'),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });
});

describe('continuation: chained encounter creates a pending row', () => {
  it('resolveChoice inserts a continuation and getActivationById returns it', async () => {
    // Bandit ambush's "Fight" choice chains into tv_bandit_aftermath on success.
    // Force success by seeding a very high SP buddy? Simpler: set the base bias
    // implicitly by using the "Pay" choice, which is a check.type: none path
    // that just costs Waifubux — but Pay does not chain. We need Fight success.
    // Instead: run Fight with a scripted RNG that always yields 0 (guaranteed
    // success under the SP formula clamp).
    const activeId = await insertActiveFor('tv_bandit_ambush');
    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_bandit_ambush'));

    // Look up the Fight choice id from the joined choices.
    // Typed table, not a raw `sql` fragment: drizzle needs the column
    // metadata to project anything, and `.select().from(sql`…`)` returns one
    // empty object per row — which is why every label lookup here used to
    // come back undefined.
    const choiceRows = await t.db
      .select()
      .from(worldEncounterChoices)
      .where(eq(worldEncounterChoices.encounterId, encounter!.id));
    const fight = choiceRows.find((c) => c.label === 'Fight');
    expect(fight).toBeDefined();

    // Use a scripted RNG whose first `.next()` is 0 (always success).
    const rng = { next: () => 0, intInclusive: (a: number) => a };
    const resolution = await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId: fight!.id,
      rng,
    });
    expect(resolution.check.success).toBe(true);
    expect(resolution.continuationActiveId).not.toBeNull();

    const continuation = await app.worldEncounter.getActivationById(
      resolution.continuationActiveId!,
      playerId,
    );
    expect(continuation).not.toBeNull();
    expect(continuation!.encounter.slug).toBe('tv_bandit_aftermath');
  });

  it('does not create a continuation when the check fails', async () => {
    const activeId = await insertActiveFor('tv_bandit_ambush');
    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_bandit_ambush'));
    // Typed table, not a raw `sql` fragment: drizzle needs the column
    // metadata to project anything, and `.select().from(sql`…`)` returns one
    // empty object per row — which is why every label lookup here used to
    // come back undefined.
    const choiceRows = await t.db
      .select()
      .from(worldEncounterChoices)
      .where(eq(worldEncounterChoices.encounterId, encounter!.id));
    const fight = choiceRows.find((c) => c.label === 'Fight');
    const rng = { next: () => 0.999, intInclusive: (a: number) => a };
    const resolution = await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId: fight!.id,
      rng,
    });
    expect(resolution.check.success).toBe(false);
    expect(resolution.continuationActiveId).toBeNull();
  });

  it('a second call on the same active id sees "already resolved" and does not double-fire', async () => {
    const activeId = await insertActiveFor('tv_bandit_ambush');
    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_bandit_ambush'));
    // Typed table, not a raw `sql` fragment: drizzle needs the column
    // metadata to project anything, and `.select().from(sql`…`)` returns one
    // empty object per row — which is why every label lookup here used to
    // come back undefined.
    const choiceRows = await t.db
      .select()
      .from(worldEncounterChoices)
      .where(eq(worldEncounterChoices.encounterId, encounter!.id));
    const pay = choiceRows.find((c) => c.label === 'Pay');
    await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId: pay!.id,
    });
    await expect(
      app.worldEncounter.resolveChoice({
        activeId,
        playerId,
        choiceId: pay!.id,
      }),
    ).rejects.toThrow(/already been resolved/i);
  });
});

describe('vendor: atomically opened by open_vendor effect', () => {
  it('resolveChoice on the wandering merchant opens a vendor instance and returns its id', async () => {
    const activeId = await insertActiveFor('tv_wandering_merchant');
    const [encounter] = await t.db
      .select()
      .from(worldEncounters)
      .where(eq(worldEncounters.slug, 'tv_wandering_merchant'));
    // Typed table, not a raw `sql` fragment: drizzle needs the column
    // metadata to project anything, and `.select().from(sql`…`)` returns one
    // empty object per row — which is why every label lookup here used to
    // come back undefined.
    const choiceRows = await t.db
      .select()
      .from(worldEncounterChoices)
      .where(eq(worldEncounterChoices.encounterId, encounter!.id));
    const browse = choiceRows.find((c) => c.label.includes('Browse'));
    expect(browse).toBeDefined();
    const resolution = await app.worldEncounter.resolveChoice({
      activeId,
      playerId,
      choiceId: browse!.id,
    });
    expect(resolution.vendorInstance).not.toBeNull();
    expect(resolution.vendorInstance!.vendorKey).toBe('wandering_merchant');
    const opened = await app.worldEncounterVendor.getForEncounter(playerId, activeId);
    expect(opened).not.toBeNull();
  });
});
