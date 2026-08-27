/**
 * Affection Gift System — real Postgres, real transactions.
 *
 * Covers the eligibility ladder, the per-copy pity counter (including what
 * buddy-switching must *not* do to it), the database-enforced idempotency of
 * the daily roll, and the transactional claim.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  affectionGiftRolls,
  affectionGifts,
  playerInventory,
  playerWaifus,
  players,
  species,
  type PlayerWaifuRow,
} from '../../src/db/schema';
import { createAffectionGiftService } from '../../src/modules/gifts/affectionGiftService';
import {
  GiftAlreadyClaimedError,
  GiftNotFoundError,
  InventoryCapacityError,
} from '../../src/shared/errors';
import type { Rng } from '../../src/shared/random';
import {
  bootstrapApp,
  getItemBySlug,
  insertOwnedWaifu,
  provisionPlayer,
  scriptedRng,
  type App,
} from '../helpers/fixtures';
import { createTestDb, type TestDb } from '../helpers/testDb';

let t: TestDb;
let app: App;
let playerId: number;

beforeAll(async () => {
  t = await createTestDb();
  app = await bootstrapApp(t);
  ({ playerId } = await provisionPlayer(app, 'g-gifts', 'u-1'));
});
afterAll(async () => {
  await t.cleanup();
});


/** A gift service driven by a fixed RNG, wired exactly like production. */
function giftService(rng: Rng, config = app.content.tables.affectionGifts) {
  return createAffectionGiftService({
    db: t.db,
    inventory: app.inventory,
    collection: app.collection,
    config,
    captureCapacity: app.content.tables.inventory.captureCapacity,
    timezone: 'UTC',
    logger: t.logger,
    rng,
  });
}

async function giveWaifu(affection: number): Promise<PlayerWaifuRow> {
  const [speciesRow] = await t.db.select().from(species).limit(1);
  const row = await insertOwnedWaifu(t.db, { playerId, speciesId: speciesRow!.id, affection });
  return row!;
}

async function setBuddy(waifuId: number | null): Promise<void> {
  await t.db.update(players).set({ buddyWaifuId: waifuId }).where(eq(players.id, playerId));
}

async function counterOf(waifuId: number): Promise<number> {
  const [row] = await t.db
    .select({ c: playerWaifus.giftRollCounter })
    .from(playerWaifus)
    .where(eq(playerWaifus.id, waifuId));
  return row!.c;
}

async function pendingCount(): Promise<number> {
  const [row] = await t.db
    .select({ n: sql<number>`count(*)::int` })
    .from(affectionGifts)
    .where(and(eq(affectionGifts.playerId, playerId), isNull(affectionGifts.claimedAt)));
  return row!.n;
}

/** Wipe every gift-system trace so each test starts from a known state. */
async function resetGiftState(): Promise<void> {
  await t.db.delete(affectionGifts).where(eq(affectionGifts.playerId, playerId));
  await t.db.delete(affectionGiftRolls).where(eq(affectionGiftRolls.playerId, playerId));
  await t.db.delete(playerInventory).where(eq(playerInventory.playerId, playerId));
  await setBuddy(null);
  await t.db
    .update(playerWaifus)
    .set({ giftRollCounter: 0, releasedAt: null })
    .where(eq(playerWaifus.playerId, playerId));
}

beforeEach(resetGiftState);

/** One roll at a fixed date, through the caller's transaction like daily does. */
async function roll(
  service: ReturnType<typeof giftService>,
  isoDate = '2026-08-26T12:00:00.000Z',
) {
  return t.db.transaction((tx) => service.processDailyRoll(tx, playerId, new Date(isoDate)));
}

// ─────────────────────────────── content ────────────────────────────────

describe('gift content', () => {
  it('ships the documented tiers', () => {
    expect(app.content.tables.affectionGifts.enabled).toBe(true);
    expect(app.content.tables.affectionGifts.tiers).toEqual([
      { minAffection: 500, dailyChance: 0.1, guaranteeAfter: 7, tier: 'low' },
      { minAffection: 1500, dailyChance: 0.15, guaranteeAfter: 6, tier: 'mid' },
      { minAffection: 3000, dailyChance: 0.2, guaranteeAfter: 5, tier: 'high' },
    ]);
  });

  it('every loot entry has a positive integer weight and an enabled item', async () => {
    const table = app.content.tables.affectionGifts.lootTable;
    expect(table.length).toBeGreaterThan(0);
    for (const entry of table) {
      expect(Number.isInteger(entry.weight)).toBe(true);
      expect(entry.weight).toBeGreaterThan(0);
      expect(entry.quantity).toBeGreaterThan(0);
      const item = await getItemBySlug(t.db, entry.slug);
      expect(item.enabled).toBe(true);
    }
    expect(table.reduce((sum, e) => sum + e.weight, 0)).toBe(10_000);
  });
});

// ─────────────────────────── eligibility & tiers ────────────────────────

describe('eligibility', () => {
  it('does not roll at all below 500 affection', async () => {
    const waifu = await giveWaifu(499);
    await setBuddy(waifu.id);
    // RNG deliberately empty: a roll here would throw rather than pass.
    const result = await roll(giftService(scriptedRng([])));
    expect(result).toEqual({ rolled: false, reason: 'below_threshold' });
    expect(await counterOf(waifu.id)).toBe(0);
    expect(await pendingCount()).toBe(0);
  });

  it('does not roll when the player has no active buddy', async () => {
    await giveWaifu(5000);
    await setBuddy(null);
    expect(await roll(giftService(scriptedRng([])))).toEqual({
      rolled: false,
      reason: 'no_buddy',
    });
  });

  it.each([
    [500, 'low', 0.1, 7],
    [1_499, 'low', 0.1, 7],
    [1_500, 'mid', 0.15, 6],
    [2_999, 'mid', 0.15, 6],
    [3_000, 'high', 0.2, 5],
    [99_999, 'high', 0.2, 5],
  ])('affection %i resolves to the %s tier', async (affection, tier, chance, guarantee) => {
    const waifu = await giveWaifu(affection as number);
    await setBuddy(waifu.id);
    // A roll just above the chance misses, which is what proves the boundary:
    // the service used *this* tier's number and not a neighbour's.
    const result = await roll(giftService(scriptedRng([(chance as number) + 0.001])));
    expect(result.rolled).toBe(true);
    if (!result.rolled) throw new Error('unreachable');
    expect(result.outcome.tier).toBe(tier);
    expect(result.outcome.chance).toBe(chance);
    expect(result.outcome.gift).toBeNull();

    const service = giftService(scriptedRng([]));
    expect(service.tierFor(affection as number)?.guaranteeAfter).toBe(guarantee);
  });

  it('only the active buddy is rolled, never every owned copy', async () => {
    const buddy = await giveWaifu(5000);
    const other = await giveWaifu(5000);
    await setBuddy(buddy.id);

    // Chance hits, so exactly one gift is generated — for the buddy.
    const result = await roll(giftService(scriptedRng([0, 0])));
    expect(result.rolled).toBe(true);
    if (!result.rolled) throw new Error('unreachable');
    expect(result.outcome.gift?.waifuId).toBe(buddy.id);

    const rows = await t.db
      .select()
      .from(affectionGifts)
      .where(eq(affectionGifts.playerId, playerId));
    expect(rows).toHaveLength(1);
    expect(await counterOf(other.id)).toBe(0);
  });
});

// ───────────────────────── the guarantee counter ────────────────────────

describe('guarantee counter', () => {
  it.each([
    [600, 7],
    [2_000, 6],
    [4_000, 5],
  ])(
    'affection %i guarantees a gift on eligible roll %i',
    async (affection, guaranteeAt) => {
      const waifu = await giveWaifu(affection as number);
      await setBuddy(waifu.id);
      const at = guaranteeAt as number;

      // Every chance roll misses (0.99 is above every configured chance).
      for (let day = 1; day < at; day++) {
        const result = await roll(
          giftService(scriptedRng([0.99])),
          `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`,
        );
        expect(result.rolled).toBe(true);
        if (!result.rolled) throw new Error('unreachable');
        expect(result.outcome.gift).toBeNull();
        expect(await counterOf(waifu.id)).toBe(day);
      }

      // The guaranteed day: the chance roll still misses, a gift lands anyway.
      const final = await roll(
        giftService(scriptedRng([0.99, 0])),
        `2026-08-${String(at).padStart(2, '0')}T12:00:00.000Z`,
      );
      expect(final.rolled).toBe(true);
      if (!final.rolled) throw new Error('unreachable');
      expect(final.outcome.gift).not.toBeNull();
      expect(final.outcome.source).toBe('guaranteed');
      // Reset on generation.
      expect(await counterOf(waifu.id)).toBe(0);
    },
  );

  it('resets the counter when a random roll produces a gift', async () => {
    const waifu = await giveWaifu(600);
    await setBuddy(waifu.id);
    await roll(giftService(scriptedRng([0.99])), '2026-08-01T12:00:00.000Z');
    await roll(giftService(scriptedRng([0.99])), '2026-08-02T12:00:00.000Z');
    expect(await counterOf(waifu.id)).toBe(2);

    const hit = await roll(giftService(scriptedRng([0, 0])), '2026-08-03T12:00:00.000Z');
    expect(hit.rolled).toBe(true);
    if (!hit.rolled) throw new Error('unreachable');
    expect(hit.outcome.source).toBe('random');
    expect(await counterOf(waifu.id)).toBe(0);
  });

  it('pauses while a gift is pending — no roll row, no counter movement', async () => {
    const waifu = await giveWaifu(600);
    await setBuddy(waifu.id);
    await roll(giftService(scriptedRng([0.99])), '2026-08-01T12:00:00.000Z');
    await roll(giftService(scriptedRng([0, 0])), '2026-08-02T12:00:00.000Z');
    expect(await pendingCount()).toBe(1);
    expect(await counterOf(waifu.id)).toBe(0);

    // Empty RNG: reaching the chance roll at all would throw.
    const paused = await roll(giftService(scriptedRng([])), '2026-08-03T12:00:00.000Z');
    expect(paused).toEqual({ rolled: false, reason: 'gift_pending' });
    expect(await counterOf(waifu.id)).toBe(0);
    const rolls = await t.db
      .select()
      .from(affectionGiftRolls)
      .where(eq(affectionGiftRolls.playerId, playerId));
    expect(rolls.map((r) => r.rollDate)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('switching buddies transfers no progress and takes no second roll that day', async () => {
    const first = await giveWaifu(600);
    const second = await giveWaifu(600);
    await setBuddy(first.id);

    // Three missed days build progress on `first` only.
    for (let day = 1; day <= 3; day++) {
      await roll(
        giftService(scriptedRng([0.99])),
        `2026-08-0${day}T12:00:00.000Z`,
      );
    }
    expect(await counterOf(first.id)).toBe(3);
    expect(await counterOf(second.id)).toBe(0);

    // Swapping mid-day must not buy a fresh roll.
    await setBuddy(second.id);
    const sameDay = await roll(giftService(scriptedRng([])), '2026-08-03T12:00:00.000Z');
    expect(sameDay).toEqual({ rolled: false, reason: 'already_rolled' });
    expect(await counterOf(second.id)).toBe(0);
    expect(await counterOf(first.id)).toBe(3);

    // The next day the new buddy starts her own counter at 1.
    await roll(giftService(scriptedRng([0.99])), '2026-08-04T12:00:00.000Z');
    expect(await counterOf(second.id)).toBe(1);
    expect(await counterOf(first.id)).toBe(3);
  });
});

// ───────────────────────────── idempotency ──────────────────────────────

describe('daily idempotency', () => {
  it('a repeated roll for the same reset date changes nothing', async () => {
    const waifu = await giveWaifu(600);
    await setBuddy(waifu.id);
    await roll(giftService(scriptedRng([0.99])));
    expect(await counterOf(waifu.id)).toBe(1);

    const again = await roll(giftService(scriptedRng([0.99])));
    expect(again).toEqual({ rolled: false, reason: 'already_rolled' });
    expect(await counterOf(waifu.id)).toBe(1);
  });

  it('concurrent rolls for the same date produce exactly one roll row', async () => {
    const waifu = await giveWaifu(5000);
    await setBuddy(waifu.id);
    const when = new Date('2026-08-26T12:00:00.000Z');

    // Both hit the chance roll; only one can land the ledger insert.
    const outcomes = await Promise.allSettled([
      t.db.transaction((tx) =>
        giftService(scriptedRng([0, 0])).processDailyRoll(tx, playerId, when),
      ),
      t.db.transaction((tx) =>
        giftService(scriptedRng([0, 0])).processDailyRoll(tx, playerId, when),
      ),
    ]);
    // A loser may either be told "already_rolled" or have its transaction
    // aborted by the unique violation; both are correct, and neither may
    // leave a second row behind.
    const rolls = await t.db
      .select()
      .from(affectionGiftRolls)
      .where(eq(affectionGiftRolls.playerId, playerId));
    expect(rolls).toHaveLength(1);
    expect(await pendingCount()).toBe(1);
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
  });

  it('the daily claim drives the roll, and re-claiming the same day does not', async () => {
    const waifu = await giveWaifu(5000);
    await setBuddy(waifu.id);
    const claim = await app.daily.claim(playerId, new Date('2026-08-26T12:00:00.000Z'));
    expect(claim.giftRoll).not.toBeNull();
    expect(claim.giftRoll?.rolled).toBe(true);

    // The unique index on daily_claims blocks the second claim outright, so
    // the roll cannot run twice either.
    await expect(
      app.daily.claim(playerId, new Date('2026-08-26T13:00:00.000Z')),
    ).rejects.toThrow();
    const rolls = await t.db
      .select()
      .from(affectionGiftRolls)
      .where(eq(affectionGiftRolls.playerId, playerId));
    expect(rolls).toHaveLength(1);
  });
});

// ────────────────────────────── generation ──────────────────────────────

describe('gift generation', () => {
  it('freezes the exact item on the row at generation time', async () => {
    const waifu = await giveWaifu(3200);
    await setBuddy(waifu.id);
    // Loot pick of 0 lands on the first (heaviest) entry.
    const result = await roll(giftService(scriptedRng([0, 0])));
    expect(result.rolled).toBe(true);
    if (!result.rolled || !result.outcome.gift) throw new Error('expected a gift');

    const gift = result.outcome.gift;
    expect(gift).toMatchObject({
      playerId,
      waifuId: waifu.id,
      itemSlug: 'quickie_coffee',
      quantity: 1,
      affectionAtGeneration: 3200,
      tierAtGeneration: 'high',
      source: 'random',
      resetDate: '2026-08-26',
      claimedAt: null,
    });
    // Nothing is granted at generation — the item only moves on claim.
    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(0);
  });

  it('weighted selection reaches the tail of the table', async () => {
    const waifu = await giveWaifu(5000);
    await setBuddy(waifu.id);
    // 0.9999 × 10000 = 9999 — inside the final (Mythic Contract) bucket.
    const result = await roll(giftService(scriptedRng([0, 0.9999])));
    if (!result.rolled || !result.outcome.gift) throw new Error('expected a gift');
    expect(result.outcome.gift.itemSlug).toBe('mythic_contract');
  });

  it('the database refuses a second unclaimed gift for the same copy', async () => {
    const waifu = await giveWaifu(5000);
    await setBuddy(waifu.id);
    await roll(giftService(scriptedRng([0, 0])));
    await expect(
      t.db.insert(affectionGifts).values({
        playerId,
        waifuId: waifu.id,
        itemSlug: 'quickie_coffee',
        quantity: 1,
        affectionAtGeneration: 5000,
        tierAtGeneration: 'high',
        source: 'random',
        resetDate: '2026-08-27',
      }),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────── claiming ──────────────────────────────

describe('claiming', () => {
  async function generateGift(affection = 5000): Promise<PlayerWaifuRow> {
    const waifu = await giveWaifu(affection);
    await setBuddy(waifu.id);
    await roll(giftService(scriptedRng([0, 0])));
    return waifu;
  }

  it('surfaces as a pending gift and adds exactly the stored item on claim', async () => {
    const waifu = await generateGift();
    const pending = await app.gifts.getPendingGift(playerId, waifu.id);
    expect(pending?.gift.itemSlug).toBe('quickie_coffee');

    const claim = await app.gifts.claimGift(playerId, waifu.id);
    expect(claim.item.slug).toBe('quickie_coffee');
    expect(claim.quantity).toBe(1);
    expect(claim.gift.claimedAt).not.toBeNull();

    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(1);
    expect(await app.gifts.getPendingGift(playerId, waifu.id)).toBeNull();
  });

  it('a repeated claim does not duplicate the reward', async () => {
    const waifu = await generateGift();
    await app.gifts.claimGift(playerId, waifu.id);
    await expect(app.gifts.claimGift(playerId, waifu.id)).rejects.toBeInstanceOf(
      GiftAlreadyClaimedError,
    );
    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(1);
  });

  it('concurrent claims grant exactly once', async () => {
    const waifu = await generateGift();
    const results = await Promise.allSettled([
      app.gifts.claimGift(playerId, waifu.id),
      app.gifts.claimGift(playerId, waifu.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const item = await getItemBySlug(t.db, 'quickie_coffee');
    expect(await app.inventory.getQuantity(playerId, item.id)).toBe(1);
  });

  it('refuses with no gift waiting', async () => {
    const waifu = await giveWaifu(100);
    await expect(app.gifts.claimGift(playerId, waifu.id)).rejects.toBeInstanceOf(
      GiftNotFoundError,
    );
  });

  it('a full capture inventory leaves the gift pending, and never discards it', async () => {
    const waifu = await giveWaifu(5000);
    await setBuddy(waifu.id);
    // Force a capture-category gift (Fluffy Cuffs sits in the 4th bucket:
    // 4200+2700+1200 = 8100 through 9100 of 10000).
    await roll(giftService(scriptedRng([0, 0.85])));
    const pending = await app.gifts.getPendingGift(playerId, waifu.id);
    expect(pending?.gift.itemSlug).toBe('fluffy_cuffs');

    // Fill the capture-item cap exactly.
    const capacity = app.content.tables.inventory.captureCapacity;
    const charm = await getItemBySlug(t.db, 'basic_charm');
    await app.inventory.addItem(t.db, playerId, charm.id, capacity);

    await expect(app.gifts.claimGift(playerId, waifu.id)).rejects.toBeInstanceOf(
      InventoryCapacityError,
    );
    // Still there, still unclaimed, still the same item.
    const after = await app.gifts.getPendingGift(playerId, waifu.id);
    expect(after?.gift.itemSlug).toBe('fluffy_cuffs');
    expect(after?.gift.claimedAt).toBeNull();

    // Make room and it claims normally — nothing was lost.
    await app.inventory.consumeItem(t.db, playerId, charm.id, 5);
    const claim = await app.gifts.claimGift(playerId, waifu.id);
    expect(claim.item.slug).toBe('fluffy_cuffs');
  });

  it('gifts do not expire — a stale one still claims', async () => {
    const waifu = await generateGift();
    // Backdate generation by a year; nothing in the system reads a TTL.
    await t.db
      .update(affectionGifts)
      .set({
        generatedAt: new Date('2025-01-01T00:00:00.000Z'),
        resetDate: '2025-01-01',
      })
      .where(eq(affectionGifts.waifuId, waifu.id));

    expect(await app.gifts.getPendingGift(playerId, waifu.id)).not.toBeNull();
    const claim = await app.gifts.claimGift(playerId, waifu.id);
    expect(claim.gift.claimedAt).not.toBeNull();
  });

  it('lists pending gifts and their owning copies for the indicators', async () => {
    const waifu = await generateGift();
    const list = await app.gifts.listPendingGifts(playerId);
    expect(list).toHaveLength(1);
    expect(list[0]!.waifu.id).toBe(waifu.id);
    expect(list[0]!.species.name).toBeTruthy();
    expect(await app.gifts.pendingWaifuIds(playerId)).toEqual(new Set([waifu.id]));
  });
});
