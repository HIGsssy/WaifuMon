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
 *   restore_energy_full   — Energy Drink. Sets Hunt Energy to the player's
 *                           *computed* max (base + level bonuses, capped).
 *                           Refuses at full energy so the drink isn't wasted.
 *                           Exits Care Mode first (config: `exitCareMode`),
 *                           crediting any pending care ticks before the refill.
 *   capture_bonus_charges — Microdose. Grants/refreshes the non-stacking
 *                           capture-bonus buff (see PlayerEffectsService).
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { items, players, type ItemRow } from '../../db/schema';
import {
  EnergyAlreadyFullError,
  ItemHasNoEffectError,
  ItemNotFoundError,
  PlayerNotFoundError,
} from '../../shared/errors';
import type {
  CaptureBonusEffect,
  ItemEffectType,
  RestoreEnergyEffect,
} from '../content/schemas';
import { effectConfigSchemaFor } from '../content/schemas';
import type { CareService } from '../care/careService';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import type { PlayerEffectsService } from '../effects/playerEffectsService';
import type { ProgressionService } from '../progression/progressionService';

export interface RestoreEnergyUseResult {
  kind: 'restore_energy_full';
  item: ItemRow;
  quantityRemaining: number;
  energyBefore: number;
  energyAfter: number;
  maxEnergy: number;
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

export type ItemUseResult = RestoreEnergyUseResult | CaptureBonusUseResult;

export interface ItemUseService {
  /**
   * Use one copy of `itemSlug`. Throws `ItemNotFoundError` (unknown/disabled),
   * `ItemHasNoEffectError` (not a consumable), `InsufficientItemsError` (none
   * owned) or `EnergyAlreadyFullError` — in every case nothing is consumed.
   */
  use(playerId: number, itemSlug: string, now?: Date): Promise<ItemUseResult>;
}

export interface ItemUseServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  effects: PlayerEffectsService;
  progression: ProgressionService;
  care: CareService;
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
  const { db, currency, inventory, effects, progression, care } = deps;

  return {
    async use(playerId, itemSlug, now = new Date()) {
      return db.transaction(async (tx): Promise<ItemUseResult> => {
        const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
        if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        const effectType = item.effectType as ItemEffectType | null;
        if (effectType == null) throw new ItemHasNoEffectError(itemSlug);

        if (effectType === 'restore_energy_full') {
          const config = parseEffectConfig<RestoreEnergyEffect>(item, effectType);

          // Care Mode first: it credits pending ticks (which may themselves
          // raise energy) and clears the care fields, so the refill below is
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
          // Refuse rather than burn the item — and never exceed the computed
          // max, which is the whole point of "restore to max".
          if (energyBefore >= maxEnergy) {
            throw new EnergyAlreadyFullError(energyBefore, maxEnergy);
          }

          const quantityRemaining = await inventory.consumeItem(tx, playerId, item.id, 1);
          const updated = await currency.setHuntEnergy(tx, playerId, maxEnergy);

          return {
            kind: 'restore_energy_full',
            item,
            quantityRemaining,
            energyBefore,
            energyAfter: updated.huntEnergy,
            maxEnergy,
            careModeExited,
            careEnergyGained,
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
      });
    },
  };
}
