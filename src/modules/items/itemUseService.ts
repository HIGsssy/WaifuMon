/**
 * ItemUseService — "use" an inventory consumable (shop/items expansion).
 *
 * Every use is one transaction: validate the item → apply the effect →
 * decrement the inventory row → return a rendered-ready result. If any step
 * throws, nothing is consumed and nothing is applied, so a refused use (energy
 * already full, no copies owned) is always free.
 *
 * The effect vocabulary lives in `items.effect_type`, and the per-effect
 * tunables in `items.effect_config` — both seeded from content/items.json, so
 * an admin can retune (or add) a consumable without a code change.
 *
 *   restore_energy_full   — Energy Drink, Full Body Massage. Sets Hunt Energy
 *                           to the player's *computed* max (base + level
 *                           bonuses, capped). Refuses at full energy so the
 *                           item isn't wasted. Exits Care Mode first (config:
 *                           `exitCareMode`), crediting any pending care ticks
 *                           before the refill.
 *   restore_energy_amount — Quickie Coffee, Reach Around. Adds a fixed amount,
 *                           clamped to that same computed max. Refuses only at
 *                           *full* energy: unlike the refill, a partial top-up
 *                           still does something useful at 1 below the cap, so
 *                           the overflow is spilled rather than the use denied.
 *   capture_bonus_charges — Microdose. Grants/refreshes the non-stacking
 *                           capture-bonus buff (see PlayerEffectsService).
 *   buddy_affection_gain  — Affection consumables. Flat Affection to the
 *                           active Buddy, scaled by the `affection_gain` Buddy
 *                           Bonus. Refuses with `NoActiveBuddyError` when no
 *                           Buddy is equipped, consuming nothing. The award
 *                           itself — including the bonus multiply — belongs to
 *                           `CollectionService.awardBuddyAffection`; this
 *                           module only decides *whether* to spend the item.
 */
import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  items,
  players,
  species,
  type ItemRow,
  type PlayerWaifuRow,
  type SpeciesRow,
} from '../../db/schema';
import {
  EnergyAlreadyFullError,
  ItemHasNoEffectError,
  ItemNotFoundError,
  NoActiveBuddyError,
  PlayerNotFoundError,
} from '../../shared/errors';
import type {
  BuddyAffectionGainEffect,
  CaptureBonusEffect,
  ItemEffectType,
  RestoreEnergyAmountEffect,
  RestoreEnergyEffect,
} from '../content/schemas';
import { effectConfigSchemaFor } from '../content/schemas';
import type { AppliedBuddyBonus } from '../buddyBonus/buddyBonusEffects';
import type { CareService } from '../care/careService';
import type { CollectionService } from '../collection/collectionService';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { PlayerEffectsService } from '../effects/playerEffectsService';
import type { ProgressionService } from '../progression/progressionService';

export interface RestoreEnergyUseResult {
  /**
   * Both energy consumables report through this one shape — the caller renders
   * "restored to 25/25" either way, and only the arithmetic differs.
   */
  kind: 'restore_energy_full' | 'restore_energy_amount';
  item: ItemRow;
  quantityRemaining: number;
  energyBefore: number;
  energyAfter: number;
  maxEnergy: number;
  /**
   * Energy the item was configured to grant. Null for the full refill, which
   * has no fixed amount. May exceed `energyAfter - energyBefore` when the
   * clamp spilled the remainder.
   */
  restoreAmount: number | null;
  /** True when the use also ended an active Care Mode session. */
  careModeExited: boolean;
  /** Energy credited by pending Care Mode ticks applied during the exit. */
  careEnergyGained: number;
}

export interface CaptureBonusUseResult {
  kind: 'capture_bonus_charges';
  item: ItemRow;
  quantityRemaining: number;
  /** Flat capture-chance bonus, e.g. 0.03. */
  modifier: number;
  chargesRemaining: number;
  /** True when an already-active buff was refreshed rather than created. */
  refreshed: boolean;
  chargesBefore: number;
}

export interface BuddyAffectionUseResult {
  kind: 'buddy_affection_gain';
  item: ItemRow;
  quantityRemaining: number;
  /** The copy that received it, and her species, for naming her in the result. */
  waifu: PlayerWaifuRow;
  species: SpeciesRow;
  /** The item's configured award, before any Buddy Bonus. */
  baseAffection: number;
  /** What actually landed. Equals `baseAffection` when no bonus applied. */
  affectionGained: number;
  /** Her Affection after the award. */
  affectionAfter: number;
  /**
   * Set **only** when `affection_gain` actually raised the award, matching
   * `BuddyAwardResult`: a bonus is never announced next to a number it did
   * not move.
   */
  affectionBonus: AppliedBuddyBonus | null;
}

export type ItemUseResult =
  | RestoreEnergyUseResult
  | CaptureBonusUseResult
  | BuddyAffectionUseResult;

export interface ItemUseService {
  /**
   * Use one copy of `itemSlug` in its own transaction. Throws
   * `ItemNotFoundError` (unknown/disabled), `ItemHasNoEffectError` (not a
   * consumable), `InsufficientItemsError` (none owned),
   * `EnergyAlreadyFullError` or `NoActiveBuddyError` — in every case nothing
   * is consumed.
   */
  use(playerId: number, itemSlug: string, now?: Date): Promise<ItemUseResult>;

  /**
   * The same use, inside a transaction the caller already owns.
   *
   * Exists so a caller that must validate something *else* under a lock can
   * do so atomically with the item being spent — the encounter-time Microdose
   * is the case that motivated it: `CaptureService` locks the encounter row,
   * proves it is still this player's and still active, and only then spends
   * the item, all in one transaction. Extracting the entry point rather than
   * reimplementing it is the point: there is exactly one place that knows how
   * an item is used, and both callers reach it.
   */
  useInTransaction(
    tx: DbOrTx,
    playerId: number,
    itemSlug: string,
    now?: Date,
  ): Promise<ItemUseResult>;
}

export interface ItemUseServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  effects: PlayerEffectsService;
  progression: ProgressionService;
  care: CareService;
  /** Owns buddy resolution and every Affection award. */
  collection: CollectionService;
}

/**
 * Re-parse the DB-stored effect config through the content schema. The column
 * is jsonb, so a hand-edited row (or an older seed) could be malformed; the
 * schema's defaults fill the gaps and a genuinely broken config surfaces as a
 * clean error instead of a NaN capture bonus.
 */
function parseEffectConfig<T>(item: ItemRow, effectType: ItemEffectType): T {
  const parsed = effectConfigSchemaFor(effectType).safeParse(item.effectConfig ?? {});
  if (!parsed.success) {
    throw new ItemHasNoEffectError(item.slug);
  }
  return parsed.data as T;
}

export function createItemUseService(deps: ItemUseServiceDeps): ItemUseService {
  const { db, currency, inventory, effects, progression, care, collection } = deps;

  async function useInTransaction(
    tx: DbOrTx,
    playerId: number,
    itemSlug: string,
    now: Date = new Date(),
  ): Promise<ItemUseResult> {
    const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
    if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
    const effectType = item.effectType as ItemEffectType | null;
    if (effectType == null) throw new ItemHasNoEffectError(itemSlug);

    if (effectType === 'restore_energy_full' || effectType === 'restore_energy_amount') {
      // One code path for both energy consumables: they differ only in the
      // *target* energy, so the Care Mode interaction, the full-energy
      // refusal, and the clamp can never drift between them.
      const full = effectType === 'restore_energy_full';
      const config = full
        ? parseEffectConfig<RestoreEnergyEffect>(item, effectType)
        : parseEffectConfig<RestoreEnergyAmountEffect>(item, effectType);
      const restoreAmount = full ? null : (config as RestoreEnergyAmountEffect).amount;

      // Care Mode first: it credits pending ticks (which may themselves
      // raise energy) and clears the care fields, so the restore below is
      // computed against the settled state. Same transaction, so a refusal
      // below rolls the exit back too.
      let careModeExited = false;
      let careEnergyGained = 0;
      if (config.exitCareMode) {
        const summary = await care.applyAndExit(tx, playerId, now);
        careModeExited = summary.stopped;
        careEnergyGained = summary.energyGained;
      }

      const [player] = await tx
        .select()
        .from(players)
        .where(eq(players.id, playerId))
        .for('update');
      if (!player) throw new PlayerNotFoundError(playerId);

      const maxEnergy = progression.computeMaxEnergy(player.level);
      const balances = await currency.lockCurrencies(tx, playerId);
      const energyBefore = balances.huntEnergy;
      // Refuse rather than burn the item. At the cap there is nothing
      // either variant can do, so both refuse identically; *below* the cap
      // an amount-based restore is honoured and its overflow spilled,
      // which is the clamp doing its job rather than a wasted item.
      if (energyBefore >= maxEnergy) {
        throw new EnergyAlreadyFullError(energyBefore, maxEnergy);
      }

      const target = full
        ? maxEnergy
        : Math.min(maxEnergy, energyBefore + (restoreAmount ?? 0));

      const quantityRemaining = await inventory.consumeItem(tx, playerId, item.id, 1);
      const updated = await currency.setHuntEnergy(tx, playerId, target);

      return {
        kind: effectType,
        item,
        quantityRemaining,
        energyBefore,
        energyAfter: updated.huntEnergy,
        maxEnergy,
        restoreAmount,
        careModeExited,
        careEnergyGained,
      };
    }

    if (effectType === 'buddy_affection_gain') {
      const config = parseEffectConfig<BuddyAffectionGainEffect>(item, effectType);

      // Grant first, consume second — the ordering is the whole refusal
      // contract. `awardBuddyAffection` returns null for "no Buddy equipped",
      // and throwing here means `consumeItem` below is never reached, so the
      // item survives a use that could not do anything.
      //
      // Both statements are in the caller's transaction either way, so even
      // the reverse order would roll back; doing it in this order means the
      // guarantee does not depend on that, and reads as what it is.
      const award = await collection.awardBuddyAffection(tx, playerId, config.amount);
      if (!award) throw new NoActiveBuddyError(item.name);

      const [row] = await tx
        .select({ species })
        .from(species)
        .where(eq(species.id, award.waifu.speciesId));
      if (!row) throw new PlayerNotFoundError(playerId);

      const quantityRemaining = await inventory.consumeItem(tx, playerId, item.id, 1);
      return {
        kind: 'buddy_affection_gain',
        item,
        quantityRemaining,
        waifu: award.waifu,
        species: row.species,
        baseAffection: config.amount,
        affectionGained: award.affectionGranted,
        affectionAfter: award.waifu.affection,
        affectionBonus: award.affectionBonus,
      };
    }

    const config = parseEffectConfig<CaptureBonusEffect>(item, effectType);
    const quantityRemaining = await inventory.consumeItem(tx, playerId, item.id, 1);
    const granted = await effects.grantCaptureBonus(
      tx,
      playerId,
      {
        sourceItemSlug: item.slug,
        modifier: config.captureBonus,
        charges: config.charges,
        refreshBehavior: config.refreshBehavior,
      },
      now,
    );
    return {
      kind: 'capture_bonus_charges',
      item,
      quantityRemaining,
      modifier: granted.modifier,
      chargesRemaining: granted.chargesRemaining,
      refreshed: granted.refreshed,
      chargesBefore: granted.chargesBefore,
    };
  }

  return {
    useInTransaction,
    async use(playerId, itemSlug, now = new Date()) {
      return db.transaction((tx) => useInTransaction(tx, playerId, itemSlug, now));
    },
  };
}
