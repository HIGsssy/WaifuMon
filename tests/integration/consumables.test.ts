/**
 * Energy Drink + Microdose (shop/items expansion) — real Postgres.
 *
 * Covers purchase, use, the transactional guarantees on both, the
 * non-stacking capture buff, and exactly when a charge is (and is not) spent.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_BONUS_EFFECT,
  captureAttempts,
  encounters,
  items,
  playerActiveEffects,
  playerCurrencies,
  playerInventory,
  playerProgressionEvents,
  playerWaifus,
  players,
  species,
  type EncounterRow,
  type SpeciesRow,
} from '../../src/db/schema';
import { createCaptureService } from '../../src/modules/capture/captureService';
import { computeCaptureChance } from '../../src/modules/capture/captureMath';
import { createHuntService } from '../../src/modules/hunt/huntService';
import {
  EnergyAlreadyFullError,
  InsufficientItemsError,
  ItemHasNoEffectError,
  ItemNotFoundError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
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

function scriptedRng(nexts: number[]): Rng {
  let i = 0;
  return {
    next: () => {
      if (i >= nexts.length) throw new Error(`scriptedRng exhausted at ${i}`);
      return nexts[i++]!;
    },
    intInclusive(min, max) {
      const v = nexts[i++]!;
      return Math.floor(v * (max - min + 1)) + min;
    },
  };
}

async function grantItem(playerId: number, slug: string, qty: number): Promise<void> {
  const item = await getItemBySlug(t.db, slug);
  await app.inventory.addItem(t.db, playerId, item.id, qty);
}

async function itemQuantity(playerId: number, slug: string): Promise<number> {
  const item = await getItemBySlug(t.db, slug);
  return app.inventory.getQuantity(playerId, item.id);
}

async function setEnergy(playerId: number, value: number): Promise<void> {
  await t.db
    .update(playerCurrencies)
    .set({ huntEnergy: value })
    .where(eq(playerCurrencies.playerId, playerId));
}

async function energyOf(playerId: number): Promise<number> {
  return (await app.currency.getBalances(playerId)).huntEnergy;
}

async function createActiveEncounter(
  playerId: number,
  speciesSlug: string,
): Promise<{ encounter: EncounterRow; speciesRow: SpeciesRow }> {
  await t.db
    .update(encounters)
    .set({ state: 'expired', resolvedAt: new Date() })
    .where(and(eq(encounters.playerId, playerId), eq(encounters.state, 'active')));
  const [speciesRow] = await t.db.select().from(species).where(eq(species.slug, speciesSlug));
  if (!speciesRow) throw new Error(`missing seeded species ${speciesSlug}`);
  const [row] = await t.db
    .insert(encounters)
    .values({
      playerId,
      speciesId: speciesRow.id,
      channelId: 'chan-consumables',
      state: 'active',
      attemptCount: 0,
      maxAttempts: 3,
      expiresAt: new Date(Date.now() + 120_000),
    })
    .returning();
  return { encounter: row!, speciesRow };
}

function captureWith(rng: Rng) {
  return createCaptureService({
    db: t.db,
    inventory: app.inventory,
    progression: app.progression,
    progressionConfig: app.content.tables.progression,
    captureConfig: app.content.tables.capture,
    buddyAffinityConfig: app.content.tables.buddyAffinity,
    collection: app.collection,
    quests: app.quests,
    effects: app.effects,
    logger: t.logger,
    rng,
  });
}

// ───────────────────────────── content wiring ─────────────────────────────

describe('content + seeding', () => {
  it('seeds both utility items with their effect config intact', async () => {
    const drink = await getItemBySlug(t.db, 'energy_drink');
    expect(drink).toMatchObject({
      category: 'consumable',
      effectType: 'restore_energy_full',
      purchasable: true,
      buyPrice: 500,
      priceCurrency: 'waifubux',
    });
    expect(drink.effectConfig).toMatchObject({ restoreToMax: true, exitCareMode: true });

    const microdose = await getItemBySlug(t.db, 'microdose');
    expect(microdose).toMatchObject({
      category: 'consumable',
      effectType: 'capture_bonus_charges',
      purchasable: true,
      buyPrice: 40,
      priceCurrency: 'essence',
    });
    expect(microdose.effectConfig).toMatchObject({ captureBonus: 0.03, charges: 5 });
  });
});

// ─────────────────────────────── Energy Drink ───────────────────────────────

describe('Energy Drink', () => {
  let playerId: number;
  let maxEnergy: number;

  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-drink', 'u-1'));
    const [player] = await t.db.select().from(players).where(eq(players.id, playerId));
    maxEnergy = app.progression.computeMaxEnergy(player!.level);
  });

  beforeEach(async () => {
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
    await t.db
      .update(players)
      .set({ careModeStartedAt: null, careModeLastTickAt: null, careModeWaifuId: null })
      .where(eq(players.id, playerId));
    await setEnergy(playerId, 0);
  });

  it('can be purchased with WaifuBux and then used from the inventory', async () => {
    await app.currency.grantWaifubux(t.db, playerId, 500);
    const purchase = await app.shop.purchase(playerId, 'energy_drink');
    expect(purchase.ownedAfter).toBe(1);

    const result = await app.itemUse.use(playerId, 'energy_drink');
    expect(result.kind).toBe('restore_energy_full');
    expect(await itemQuantity(playerId, 'energy_drink')).toBe(0);
  });

  it('restores energy to the computed max and never exceeds it', async () => {
    await grantItem(playerId, 'energy_drink', 1);
    await setEnergy(playerId, 1);

    const result = await app.itemUse.use(playerId, 'energy_drink');
    if (result.kind !== 'restore_energy_full') throw new Error('wrong effect kind');
    expect(result.energyBefore).toBe(1);
    expect(result.energyAfter).toBe(maxEnergy);
    expect(result.maxEnergy).toBe(maxEnergy);
    expect(await energyOf(playerId)).toBe(maxEnergy);
  });

  it('honours level-based max-energy bonuses', async () => {
    // Level 7 grants +5 max energy (content/tables.json).
    await t.db.update(players).set({ level: 7 }).where(eq(players.id, playerId));
    try {
      const boosted = app.progression.computeMaxEnergy(7);
      expect(boosted).toBeGreaterThan(maxEnergy);
      await grantItem(playerId, 'energy_drink', 1);
      await setEnergy(playerId, 0);

      const result = await app.itemUse.use(playerId, 'energy_drink');
      if (result.kind !== 'restore_energy_full') throw new Error('wrong effect kind');
      expect(result.energyAfter).toBe(boosted);
    } finally {
      await t.db.update(players).set({ level: 1 }).where(eq(players.id, playerId));
    }
  });

  it('refuses at full energy without consuming the item', async () => {
    await grantItem(playerId, 'energy_drink', 1);
    await setEnergy(playerId, maxEnergy);

    await expect(app.itemUse.use(playerId, 'energy_drink')).rejects.toBeInstanceOf(
      EnergyAlreadyFullError,
    );
    expect(await itemQuantity(playerId, 'energy_drink')).toBe(1);
    expect(await energyOf(playerId)).toBe(maxEnergy);
  });

  it('consumes exactly one copy per successful use', async () => {
    await grantItem(playerId, 'energy_drink', 3);
    await setEnergy(playerId, 0);
    await app.itemUse.use(playerId, 'energy_drink');
    expect(await itemQuantity(playerId, 'energy_drink')).toBe(2);
    await setEnergy(playerId, 0);
    await app.itemUse.use(playerId, 'energy_drink');
    expect(await itemQuantity(playerId, 'energy_drink')).toBe(1);
  });

  it('rejects a use with none owned — nothing changes', async () => {
    await setEnergy(playerId, 0);
    await expect(app.itemUse.use(playerId, 'energy_drink')).rejects.toBeInstanceOf(
      InsufficientItemsError,
    );
    expect(await energyOf(playerId)).toBe(0);
  });

  it('exits Care Mode, crediting pending ticks before the refill', async () => {
    // Own a waifu to care for, then start Care Mode two ticks in the past.
    const [sp] = await t.db.select().from(species).limit(1);
    const [waifu] = await t.db
      .insert(playerWaifus)
      .values({ playerId, speciesId: sp!.id })
      .returning();
    const intervalMs = app.care.config.intervalMinutes * 60 * 1000;
    const startedAt = new Date(Date.now() - 2 * intervalMs - 1000);
    await t.db
      .update(players)
      .set({
        careModeStartedAt: startedAt,
        careModeLastTickAt: startedAt,
        careModeWaifuId: waifu!.id,
      })
      .where(eq(players.id, playerId));
    await grantItem(playerId, 'energy_drink', 1);
    await setEnergy(playerId, 0);

    const result = await app.itemUse.use(playerId, 'energy_drink');
    if (result.kind !== 'restore_energy_full') throw new Error('wrong effect kind');
    expect(result.careModeExited).toBe(true);
    // The refill still wins: energy lands exactly on max, not max + tick gains.
    expect(result.energyAfter).toBe(maxEnergy);

    const state = await app.care.getState(playerId);
    expect(state.active).toBe(false);

    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  });

  it('rolls back the Care Mode exit when the use is refused', async () => {
    const [sp] = await t.db.select().from(species).limit(1);
    const [waifu] = await t.db
      .insert(playerWaifus)
      .values({ playerId, speciesId: sp!.id })
      .returning();
    const now = new Date();
    await t.db
      .update(players)
      .set({ careModeStartedAt: now, careModeLastTickAt: now, careModeWaifuId: waifu!.id })
      .where(eq(players.id, playerId));
    await grantItem(playerId, 'energy_drink', 1);
    await setEnergy(playerId, maxEnergy); // already full → refusal

    await expect(app.itemUse.use(playerId, 'energy_drink')).rejects.toBeInstanceOf(
      EnergyAlreadyFullError,
    );

    // Transaction rolled back: still in Care Mode, still holding the drink.
    expect((await app.care.getState(playerId)).active).toBe(true);
    expect(await itemQuantity(playerId, 'energy_drink')).toBe(1);

    await t.db
      .update(players)
      .set({ careModeStartedAt: null, careModeLastTickAt: null, careModeWaifuId: null })
      .where(eq(players.id, playerId));
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
  });

  it('refuses to "use" an item that has no effect, and an unknown slug', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    await expect(app.itemUse.use(playerId, 'basic_charm')).rejects.toBeInstanceOf(
      ItemHasNoEffectError,
    );
    await expect(app.itemUse.use(playerId, 'love_potion')).rejects.toBeInstanceOf(
      ItemNotFoundError,
    );
    expect(await itemQuantity(playerId, 'basic_charm')).toBe(1);
  });

  it('refuses a disabled item', async () => {
    await grantItem(playerId, 'energy_drink', 1);
    await setEnergy(playerId, 0);
    await t.db.update(items).set({ enabled: false }).where(eq(items.slug, 'energy_drink'));
    try {
      await expect(app.itemUse.use(playerId, 'energy_drink')).rejects.toBeInstanceOf(
        ItemNotFoundError,
      );
      expect(await itemQuantity(playerId, 'energy_drink')).toBe(1);
    } finally {
      await t.db.update(items).set({ enabled: true }).where(eq(items.slug, 'energy_drink'));
    }
  });
});

// ───────────────────────────────── Microdose ─────────────────────────────────

describe('Microdose — granting the buff', () => {
  let playerId: number;

  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-microdose-grant', 'u-1'));
  });

  beforeEach(async () => {
    await t.db.delete(playerActiveEffects).where(eq(playerActiveEffects.playerId, playerId));
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  });

  it('can be purchased with Essence and used to create a 5-charge buff', async () => {
    await app.currency.grantEssence(t.db, playerId, 40);
    const purchase = await app.shop.purchase(playerId, 'microdose');
    expect(purchase.currency).toBe('essence');

    const result = await app.itemUse.use(playerId, 'microdose');
    if (result.kind !== 'capture_bonus_charges') throw new Error('wrong effect kind');
    expect(result.modifier).toBeCloseTo(0.03, 10);
    expect(result.chargesRemaining).toBe(5);
    expect(result.refreshed).toBe(false);
    expect(await itemQuantity(playerId, 'microdose')).toBe(0);

    const state = await app.effects.getCaptureBonus(playerId);
    expect(state).toMatchObject({
      modifier: 0.03,
      chargesRemaining: 5,
      sourceItemSlug: 'microdose',
    });
  });

  it('refreshes back to 5 without stacking above 5 or creating a second row', async () => {
    await grantItem(playerId, 'microdose', 2);
    await app.itemUse.use(playerId, 'microdose');

    // Burn a charge so the refresh is observable.
    await t.db
      .update(playerActiveEffects)
      .set({ chargesRemaining: 2 })
      .where(eq(playerActiveEffects.playerId, playerId));

    const again = await app.itemUse.use(playerId, 'microdose');
    if (again.kind !== 'capture_bonus_charges') throw new Error('wrong effect kind');
    expect(again.refreshed).toBe(true);
    expect(again.chargesBefore).toBe(2);
    expect(again.chargesRemaining).toBe(5); // reset to max, not 2 + 5

    const rows = await app.effects.listActive(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.effectType).toBe(CAPTURE_BONUS_EFFECT);
  });

  it('never grants the buff when no copy is owned', async () => {
    await expect(app.itemUse.use(playerId, 'microdose')).rejects.toBeInstanceOf(
      InsufficientItemsError,
    );
    expect(await app.effects.getCaptureBonus(playerId)).toBeNull();
  });
});

describe('Microdose — capture-chance effect and charge consumption', () => {
  let playerId: number;

  beforeAll(async () => {
    ({ playerId } = await provisionPlayer(app, 'g-microdose-capture', 'u-1'));
  });

  beforeEach(async () => {
    await t.db.delete(captureAttempts).where(eq(captureAttempts.playerId, playerId));
    await t.db.delete(playerWaifus).where(eq(playerWaifus.playerId, playerId));
    await t.db.delete(encounters).where(eq(encounters.playerId, playerId));
    await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
    await t.db.delete(playerActiveEffects).where(eq(playerActiveEffects.playerId, playerId));
    await t.db
      .delete(playerProgressionEvents)
      .where(eq(playerProgressionEvents.playerId, playerId));
  });

  it('applies +3% after the charm multiplier and before the clamp', () => {
    // Pure-math assertion of the documented ordering:
    //   base × charm + buddy + microdose, then clamp.
    const config = app.content.tables.capture;
    const withoutBuff = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: 0.2,
      rarity: 'SR',
      captureModifier: 1.5,
      config,
    });
    const withBuff = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: 0.2,
      rarity: 'SR',
      captureModifier: 1.5,
      config,
      captureBonusModifier: 0.03,
    });
    expect(withoutBuff).toBeCloseTo(0.3, 10); // 0.2 × 1.5
    expect(withBuff).toBeCloseTo(0.33, 10); // + 0.03, not (0.2 + 0.03) × 1.5

    // The clamp still wins at the ceiling.
    const clamped = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: 0.95,
      rarity: 'N',
      captureModifier: 1,
      config,
      captureBonusModifier: 0.03,
    });
    expect(clamped).toBe(config.maxChance);
  });

  it('raises the recorded chance on a real attempt and consumes one charge', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter, speciesRow } = await createActiveEncounter(playerId, 'alley_catgirl');

    const baseline = computeCaptureChance({
      guaranteed: false,
      baseCaptureRate: speciesRow.baseCaptureRate,
      rarity: speciesRow.rarity as 'N',
      captureModifier: 1,
      config: app.content.tables.capture,
    });

    const capture = captureWith(scriptedRng([0.99])); // high roll → fail
    const result = await capture.attemptCapture(playerId, encounter.id, 'basic_charm');

    expect(result.attempt.computedChance).toBeCloseTo(baseline + 0.03, 5);
    expect(result.effect).toMatchObject({
      sourceItemSlug: 'microdose',
      captureBonusModifier: 0.03,
      chargesBefore: 5,
      chargesRemaining: 4,
      cleared: false,
    });
    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(4);
  });

  it('writes the microdose modifier into the capture progression metadata', async () => {
    await grantItem(playerId, 'basic_charm', 1);
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');

    await captureWith(scriptedRng([0.99])).attemptCapture(playerId, encounter.id, 'basic_charm');

    const [event] = await t.db
      .select()
      .from(playerProgressionEvents)
      .where(
        and(
          eq(playerProgressionEvents.playerId, playerId),
          eq(playerProgressionEvents.eventType, 'capture_failed'),
        ),
      );
    expect(event?.metadata).toMatchObject({
      captureBonusModifier: 0.03,
      captureBonusSource: 'microdose',
      captureBonusChargesRemaining: 4,
    });
  });

  it('clears the buff after the 5th consumed charge', async () => {
    await grantItem(playerId, 'basic_charm', 5);
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');

    for (let i = 0; i < 5; i++) {
      const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');
      const result = await captureWith(scriptedRng([0.99])).attemptCapture(
        playerId,
        encounter.id,
        'basic_charm',
      );
      expect(result.effect?.chargesRemaining).toBe(4 - i);
      expect(result.effect?.cleared).toBe(i === 4);
    }

    expect(await app.effects.getCaptureBonus(playerId)).toBeNull();
    expect(await app.effects.listActive(playerId)).toHaveLength(0);

    // A 6th attempt runs with no buff at all.
    await grantItem(playerId, 'basic_charm', 1);
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');
    const sixth = await captureWith(scriptedRng([0.99])).attemptCapture(
      playerId,
      encounter.id,
      'basic_charm',
    );
    expect(sixth.effect).toBeNull();
  });

  it('does not consume a charge on Let Her Go', async () => {
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');

    await app.hunt.letHerGo(playerId, encounter.id);

    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(5);
  });

  it('does not consume a charge on a non-encounter hunt', async () => {
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    await setEnergy(playerId, 10);
    await t.db.update(players).set({ lastHuntAt: null }).where(eq(players.id, playerId));

    // 0.99 lands in the last bucket of the result table (flavor); the second
    // draw picks the flavor line. No encounter, so no capture attempt.
    const scriptedHunt = createHuntService({
      db: t.db,
      currency: app.currency,
      inventory: app.inventory,
      progression: app.progression,
      collection: app.collection,
      care: app.care,
      quests: app.quests,
      tables: app.content.tables,
      logger: t.logger,
      rng: scriptedRng([0.99, 0.0]),
    });
    const hunt = await scriptedHunt.hunt(playerId, 'chan-consumables');
    expect(hunt.kind).toBe('flavor');

    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(5);
  });

  it('does not consume a charge when the attempt is rejected for missing items', async () => {
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');

    await expect(
      captureWith(scriptedRng([0.99])).attemptCapture(playerId, encounter.id, 'basic_charm'),
    ).rejects.toBeInstanceOf(InsufficientItemsError);

    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(5);
  });

  it('leaves charges alone on a guaranteed (Mythic Contract) capture', async () => {
    await grantItem(playerId, 'mythic_contract', 1);
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');

    const result = await captureWith(scriptedRng([])).attemptCapture(
      playerId,
      encounter.id,
      'mythic_contract',
    );
    expect(result.outcome).toBe('success');
    expect(result.effect).toBeNull();
    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(5);
  });

  it('double-clicked charms spend exactly one charge for the one attempt that resolves', async () => {
    await grantItem(playerId, 'basic_charm', 2);
    await grantItem(playerId, 'microdose', 1);
    await app.itemUse.use(playerId, 'microdose');
    const { encounter } = await createActiveEncounter(playerId, 'alley_catgirl');

    // Two concurrent clicks on the same encounter: the encounter row lock lets
    // exactly one through, and the charge is spent under that same lock.
    const capture = captureWith(scriptedRng([0.0, 0.0]));
    const results = await Promise.allSettled([
      capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
      capture.attemptCapture(playerId, encounter.id, 'basic_charm'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect((await app.effects.getCaptureBonus(playerId))?.chargesRemaining).toBe(4);
  });

  it('concurrent uses of Microdose leave exactly one buff row at max charges', async () => {
    await grantItem(playerId, 'microdose', 4);
    const results = await Promise.allSettled([
      app.itemUse.use(playerId, 'microdose'),
      app.itemUse.use(playerId, 'microdose'),
      app.itemUse.use(playerId, 'microdose'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
    const rows = await app.effects.listActive(playerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chargesRemaining).toBe(5);
  });
});
