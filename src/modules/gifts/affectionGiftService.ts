/**
 * AffectionGiftService — the Affection Gift System.
 *
 * A Waifumon who is fond enough of her trainer occasionally has something for
 * them. The rules, and why each one is shaped the way it is:
 *
 *   - **Only the active buddy is rolled.** Not every owned copy: a roll is a
 *     relationship moment, and rolling a hundred copies would turn it into a
 *     loot faucet. Eligibility is read through
 *     `CollectionService.resolveActiveBuddy`, which self-heals a pointer at a
 *     soft-released copy, so a stale buddy can never be rolled.
 *
 *   - **One roll per player per reset date, enforced by the database.** The
 *     roll ledger's unique `(player_id, roll_date)` index is inserted *first*;
 *     a losing insert is read as "already processed today" and the whole call
 *     becomes a no-op. That is what makes a retried daily claim, or two
 *     workers racing, produce exactly one roll and at most one gift.
 *
 *   - **The pity counter belongs to the copy, not the player.**
 *     `player_waifus.gift_roll_counter` counts eligible rolls *since her last
 *     gift*. Swapping buddies therefore transfers nothing, and the new buddy
 *     resumes her own progress exactly where she left it.
 *
 *   - **A copy holding an unclaimed gift is not rolled at all.** No roll row,
 *     no counter movement — she is already holding something, so the day
 *     simply does not count against her guarantee. (This is why the
 *     "pending" check happens before the ledger insert rather than after.)
 *
 *   - **The item is rolled at generation time.** The slug and quantity are
 *     frozen onto the gift row, so retuning the loot table cannot change what
 *     she is already holding, and a claim is pure bookkeeping.
 *
 *   - **Gifts never expire.** `claimed_at` is the entire lifecycle. A claim
 *     that cannot be honoured (inventory capacity) leaves the row untouched
 *     and explains itself; nothing is ever discarded.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  affectionGiftRolls,
  affectionGifts,
  items,
  playerWaifus,
  species,
  type AffectionGiftRow,
  type AffectionGiftSource,
  type AffectionGiftTier,
  type ItemRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  ContentValidationError,
  GiftAlreadyClaimedError,
  GiftNotFoundError,
  InventoryCapacityError,
  isUniqueViolation,
  ItemNotFoundError,
} from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { defaultRng, rollWeighted, type Rng } from '../../shared/random';
import { claimDateInTimezone } from '../../shared/time';
import type { AffectionGiftsConfig, AffectionGiftTierConfig } from '../content/schemas';
import type { CollectionService } from '../collection/collectionService';
import type { InventoryService } from '../inventory/inventoryService';

/** A pending gift joined to everything a UI needs to render it. */
export interface PendingGift {
  gift: AffectionGiftRow;
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
}

/** The outcome of one daily roll. `null` from the service means "not rolled". */
export interface GiftRollOutcome {
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
  affection: number;
  tier: AffectionGiftTier;
  /** The tier's configured chance, for logs and tests. */
  chance: number;
  /** Eligible-roll ordinal this roll represents (counterBefore + 1). */
  rollOrdinal: number;
  counterBefore: number;
  counterAfter: number;
  /** Non-null when the roll produced a gift. */
  gift: AffectionGiftRow | null;
  source: AffectionGiftSource | null;
}

/** Why a daily roll did not happen. Purely diagnostic — never an error. */
export type GiftRollSkipReason =
  | 'disabled'
  | 'no_buddy'
  | 'below_threshold'
  | 'gift_pending'
  | 'already_rolled';

export type GiftRollResult =
  | { rolled: true; outcome: GiftRollOutcome }
  | { rolled: false; reason: GiftRollSkipReason };

export interface GiftClaimResult {
  gift: AffectionGiftRow;
  item: ItemRow;
  quantity: number;
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
  /** Inventory quantity of the granted item after the claim. */
  quantityAfter: number;
}

export interface AffectionGiftService {
  /**
   * Run today's roll for one player, inside the caller's transaction.
   *
   * Called from the daily-claim transaction, which is this project's
   * authoritative daily reset. Safe to call repeatedly: the second call for a
   * given `(player, resetDate)` returns `{ rolled: false, reason:
   * 'already_rolled' }` without writing anything.
   */
  processDailyRoll(
    tx: DbOrTx,
    playerId: number,
    now?: Date,
  ): Promise<GiftRollResult>;

  /** The unclaimed gift on one owned copy, or null. */
  getPendingGift(playerId: number, waifuId: number): Promise<PendingGift | null>;

  /** Every unclaimed gift the player is holding, oldest first. */
  listPendingGifts(playerId: number): Promise<PendingGift[]>;

  /**
   * Owned-copy ids with an unclaimed gift, for painting indicators on list
   * screens without an N+1. Empty set when there are none.
   */
  pendingWaifuIds(playerId: number): Promise<Set<number>>;

  /**
   * Accept the gift waiting on one owned copy. Atomic and idempotent: the
   * item is added and the row stamped `claimed_at` in the same transaction,
   * guarded by a conditional `claimed_at IS NULL` update, so a double-clicked
   * button claims exactly once. Throws `InventoryCapacityError` *without*
   * consuming the gift when the reward would breach the capture-item cap.
   */
  claimGift(playerId: number, waifuId: number, now?: Date): Promise<GiftClaimResult>;

  /** The tier a given affection value falls in, or null below the floor. */
  tierFor(affection: number): AffectionGiftTierConfig | null;
}

export interface AffectionGiftServiceDeps {
  db: Db;
  inventory: InventoryService;
  /** Resolves (and self-heals) the active buddy inside the caller's tx. */
  collection: CollectionService;
  config: AffectionGiftsConfig;
  /** Soft cap on total capture items — the claim honours it like the shop does. */
  captureCapacity: number;
  timezone: string;
  logger: Logger;
  rng?: Rng;
}

export function createAffectionGiftService(
  deps: AffectionGiftServiceDeps,
): AffectionGiftService {
  const { db, inventory, collection, config, captureCapacity, timezone, logger } = deps;
  const rng = deps.rng ?? defaultRng();

  /**
   * Highest tier whose floor the affection reaches. Tiers are validated
   * ascending and distinct by the content schema, so "last match wins" is
   * well-defined.
   */
  function tierFor(affection: number): AffectionGiftTierConfig | null {
    let match: AffectionGiftTierConfig | null = null;
    for (const tier of config.tiers) {
      if (affection >= tier.minAffection) match = tier;
      else break;
    }
    return match;
  }

  /**
   * Pick one loot entry. Only *enabled* item rows are eligible: content
   * validation already rejects a disabled reference at load time, so a
   * mismatch here means the DB drifted from the file (a hand-edited row, a
   * half-applied seed) — worth a warning and a narrowed roll, not a crash
   * that would fail the whole daily claim.
   */
  async function rollLoot(
    tx: DbOrTx,
  ): Promise<{ slug: string; quantity: number } | null> {
    if (config.lootTable.length === 0) return null;
    const slugs = config.lootTable.map((e) => e.slug);
    const rows = await tx.select().from(items).where(inArray(items.slug, slugs));
    const enabled = new Set(rows.filter((r) => r.enabled).map((r) => r.slug));
    const eligible = config.lootTable.filter((e) => enabled.has(e.slug));
    if (eligible.length !== config.lootTable.length) {
      logger.warn(
        {
          missing: config.lootTable.filter((e) => !enabled.has(e.slug)).map((e) => e.slug),
        },
        'affection gift loot table references items missing or disabled in the database',
      );
    }
    if (eligible.length === 0) return null;
    const picked = rollWeighted(
      eligible.map((e) => ({ weight: e.weight, value: e })),
      rng,
    );
    return { slug: picked.slug, quantity: picked.quantity };
  }

  async function processDailyRoll(
    tx: DbOrTx,
    playerId: number,
    now: Date = new Date(),
  ): Promise<GiftRollResult> {
    if (!config.enabled) return { rolled: false, reason: 'disabled' };
    const rollDate = claimDateInTimezone(now, timezone);

    // Only the active buddy — and resolved through the collection service so
    // a pointer at a released copy is cleared rather than rolled.
    const buddy = await collection.resolveActiveBuddy(tx, playerId);
    if (!buddy) return { rolled: false, reason: 'no_buddy' };

    // Lock the copy: the counter is read-modify-written below, and the same
    // lock is what keeps two concurrent claims of the same buddy honest.
    const [locked] = await tx
      .select()
      .from(playerWaifus)
      .where(eq(playerWaifus.id, buddy.waifu.id))
      .for('update');
    if (!locked || locked.releasedAt != null) return { rolled: false, reason: 'no_buddy' };

    const tier = tierFor(locked.affection);
    if (!tier) return { rolled: false, reason: 'below_threshold' };

    // Cheap early-out for the common retry. The insert below is still the
    // *authoritative* guard (it is what settles a genuine race); this read
    // just avoids burning an RNG draw and a row lock on a day already spent —
    // which also means a mid-day buddy switch cannot consume a roll.
    const [existingRoll] = await tx
      .select({ id: affectionGiftRolls.id })
      .from(affectionGiftRolls)
      .where(
        and(
          eq(affectionGiftRolls.playerId, playerId),
          eq(affectionGiftRolls.rollDate, rollDate),
        ),
      )
      .limit(1);
    if (existingRoll) return { rolled: false, reason: 'already_rolled' };

    // A copy already holding something takes no roll *and* no counter tick —
    // a paused day must not creep her toward a guarantee she isn't earning.
    const [pending] = await tx
      .select({ id: affectionGifts.id })
      .from(affectionGifts)
      .where(
        and(eq(affectionGifts.waifuId, locked.id), isNull(affectionGifts.claimedAt)),
      )
      .limit(1);
    if (pending) return { rolled: false, reason: 'gift_pending' };

    const counterBefore = locked.giftRollCounter;
    const rollOrdinal = counterBefore + 1;
    const chanceHit = rng.next() < tier.dailyChance;
    const guaranteed = !chanceHit && rollOrdinal >= tier.guaranteeAfter;
    const produceGift = chanceHit || guaranteed;

    // Roll the item *before* the ledger insert so a loot table that can
    // produce nothing degrades to a no-gift day rather than a half-written one.
    const loot = produceGift ? await rollLoot(tx) : null;
    const givesGift = produceGift && loot != null;
    const counterAfter = givesGift ? 0 : rollOrdinal;

    // The ledger insert is the idempotency guard: whoever lands it owns the
    // day. A unique violation means another transaction already rolled.
    try {
      await tx.insert(affectionGiftRolls).values({
        playerId,
        rollDate,
        waifuId: locked.id,
        affection: locked.affection,
        tier: tier.tier,
        result: givesGift ? 'gift' : 'none',
        guaranteed: givesGift && guaranteed,
        counterBefore,
        counterAfter,
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { rolled: false, reason: 'already_rolled' };
      throw err;
    }

    let gift: AffectionGiftRow | null = null;
    if (givesGift && loot) {
      const [inserted] = await tx
        .insert(affectionGifts)
        .values({
          playerId,
          waifuId: locked.id,
          itemSlug: loot.slug,
          quantity: loot.quantity,
          affectionAtGeneration: locked.affection,
          tierAtGeneration: tier.tier,
          source: guaranteed ? 'guaranteed' : 'random',
          resetDate: rollDate,
          generatedAt: now,
        })
        .returning();
      gift = inserted!;
    }

    const [updated] = await tx
      .update(playerWaifus)
      .set({ giftRollCounter: counterAfter })
      .where(eq(playerWaifus.id, locked.id))
      .returning();

    logger.info(
      {
        playerId,
        waifuId: locked.id,
        rollDate,
        affection: locked.affection,
        tier: tier.tier,
        chance: tier.dailyChance,
        rollOrdinal,
        guaranteed: givesGift && guaranteed,
        itemSlug: loot?.slug ?? null,
        counterAfter,
      },
      givesGift ? 'affection gift generated' : 'affection gift roll missed',
    );

    return {
      rolled: true,
      outcome: {
        waifu: updated ?? locked,
        species: buddy.species,
        affection: locked.affection,
        tier: tier.tier,
        chance: tier.dailyChance,
        rollOrdinal,
        counterBefore,
        counterAfter,
        gift,
        source: gift ? (guaranteed ? 'guaranteed' : 'random') : null,
      },
    };
  }

  async function getPendingGift(
    playerId: number,
    waifuId: number,
  ): Promise<PendingGift | null> {
    const [row] = await db
      .select({ gift: affectionGifts, waifu: playerWaifus, species })
      .from(affectionGifts)
      .innerJoin(playerWaifus, eq(affectionGifts.waifuId, playerWaifus.id))
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(
        and(
          eq(affectionGifts.playerId, playerId),
          eq(affectionGifts.waifuId, waifuId),
          isNull(affectionGifts.claimedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function listPendingGifts(playerId: number): Promise<PendingGift[]> {
    return db
      .select({ gift: affectionGifts, waifu: playerWaifus, species })
      .from(affectionGifts)
      .innerJoin(playerWaifus, eq(affectionGifts.waifuId, playerWaifus.id))
      .innerJoin(species, eq(playerWaifus.speciesId, species.id))
      .where(
        and(eq(affectionGifts.playerId, playerId), isNull(affectionGifts.claimedAt)),
      )
      .orderBy(asc(affectionGifts.generatedAt), asc(affectionGifts.id));
  }

  async function pendingWaifuIds(playerId: number): Promise<Set<number>> {
    const rows = await db
      .select({ waifuId: affectionGifts.waifuId })
      .from(affectionGifts)
      .where(
        and(eq(affectionGifts.playerId, playerId), isNull(affectionGifts.claimedAt)),
      );
    return new Set(rows.map((r) => r.waifuId));
  }

  async function claimGift(
    playerId: number,
    waifuId: number,
    now: Date = new Date(),
  ): Promise<GiftClaimResult> {
    return db.transaction(async (tx) => {
      // Lock the gift row. A concurrent claim blocks here and then finds
      // `claimed_at` set, which is what turns a double-click into one grant.
      const [locked] = await tx
        .select()
        .from(affectionGifts)
        .where(
          and(eq(affectionGifts.playerId, playerId), eq(affectionGifts.waifuId, waifuId)),
        )
        .orderBy(asc(affectionGifts.id))
        .for('update');
      if (!locked) throw new GiftNotFoundError();
      if (locked.claimedAt != null) throw new GiftAlreadyClaimedError();

      const [item] = await tx.select().from(items).where(eq(items.slug, locked.itemSlug));
      if (!item || !item.enabled) throw new ItemNotFoundError(locked.itemSlug);

      // Capacity is checked the same way the shop checks it, and refused the
      // same way: nothing is granted, and the gift stays exactly where it is.
      if (item.category === 'capture') {
        const owned = await inventory.countCaptureItems(tx, playerId);
        if (owned + locked.quantity > captureCapacity) {
          throw new InventoryCapacityError(captureCapacity);
        }
      }

      // Conditional stamp: even if two transactions somehow both got past the
      // lock, only one can flip `claimed_at` from null.
      const [claimed] = await tx
        .update(affectionGifts)
        .set({ claimedAt: now })
        .where(and(eq(affectionGifts.id, locked.id), isNull(affectionGifts.claimedAt)))
        .returning();
      if (!claimed) throw new GiftAlreadyClaimedError();

      const quantityAfter = await inventory.addItem(
        tx,
        playerId,
        item.id,
        locked.quantity,
      );

      const [row] = await tx
        .select({ waifu: playerWaifus, species })
        .from(playerWaifus)
        .innerJoin(species, eq(playerWaifus.speciesId, species.id))
        .where(eq(playerWaifus.id, waifuId));
      if (!row) {
        // The copy vanishing under an unclaimed gift should be impossible
        // (releases are soft), so this is a genuine invariant break.
        throw new ContentValidationError(
          `Affection gift ${locked.id} points at missing waifu ${waifuId}`,
        );
      }

      logger.info(
        {
          playerId,
          waifuId,
          giftId: claimed.id,
          itemSlug: item.slug,
          quantity: claimed.quantity,
        },
        'affection gift claimed',
      );

      return {
        gift: claimed,
        item,
        quantity: claimed.quantity,
        waifu: row.waifu,
        species: row.species,
        quantityAfter,
      };
    });
  }

  return {
    processDailyRoll,
    getPendingGift,
    listPendingGifts,
    pendingWaifuIds,
    claimGift,
    tierFor,
  };
}

/** Total configured loot weight — exposed for tests and admin diagnostics. */
export function totalLootWeight(config: AffectionGiftsConfig): number {
  return config.lootTable.reduce((sum, entry) => sum + entry.weight, 0);
}
