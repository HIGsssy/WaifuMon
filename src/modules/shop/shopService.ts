import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { items, shopTransactions, type ItemRow, type PriceCurrency } from '../../db/schema';
import {
  InventoryCapacityError,
  ItemNotFoundError,
  ItemNotPurchasableError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';

/**
 * Categories the shop lists. `capture` is the launch catalog (charms);
 * `consumable` covers the utility items (Energy Drink, Microdose). Material
 * and cosmetic items stay out of the shop entirely.
 */
const SHOP_CATEGORIES = ['capture', 'consumable'] as const;

export interface ShopCatalogEntry {
  item: ItemRow;
  /**
   * Always `true`. The catalog only ever contains buyable rows now, but the
   * field stays on the wire so the API schema and the portal keep working.
   */
  available: boolean;
  /** Always `null` — see {@link ShopCatalogEntry.available}. */
  availabilityNote: string | null;
  /** Currency `item.buyPrice` is denominated in. */
  currency: PriceCurrency;
}

export interface PurchaseResult {
  item: ItemRow;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  /** Currency actually spent. */
  currency: PriceCurrency;
  /** Balance of `currency` after the purchase. */
  balanceAfter: number;
  ownedAfter: number;
}

export interface ShopService {
  /**
   * The catalog: capture and consumable items that are `enabled`, flagged
   * `purchasable`, and carry a price. Everything else is invisible to the
   * shop — items that exist only as drops or rewards (the affection gifts,
   * the Mythic Contract) are still enabled so they can be granted, stored and
   * used, they are simply never for sale.
   */
  getCatalog(): Promise<ShopCatalogEntry[]>;
  /**
   * Single transaction: verify enabled+purchasable → lock currency row →
   * capacity check (reject before charging) → conditional deduct of the item's
   * own currency → upsert inventory → audit row. Nothing is ever partially
   * applied.
   */
  purchase(playerId: number, itemSlug: string, quantity?: number): Promise<PurchaseResult>;
}

/** Normalizes a possibly-legacy column value to a known currency. */
export function toPriceCurrency(value: string | null | undefined): PriceCurrency {
  return value === 'essence' ? 'essence' : 'waifubux';
}

export interface ShopServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
  /** Soft cap on total capture items (from content tables.json). */
  captureCapacity: number;
}

export function createShopService(deps: ShopServiceDeps): ShopService {
  const { db, currency, inventory, captureCapacity } = deps;

  return {
    async getCatalog() {
      // Purchasability is filtered in the query, not in the presentation
      // layer, so every consumer (Discord shop page and buttons, the
      // `/v1/shop/catalog` endpoint) sees the same buyable-only list.
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            inArray(items.category, [...SHOP_CATEGORIES]),
            eq(items.enabled, true),
            eq(items.purchasable, true),
            isNotNull(items.buyPrice),
          ),
        )
        .orderBy(asc(items.category), asc(items.buyPrice), asc(items.slug));
      return rows.map((item) => ({
        item,
        available: true,
        availabilityNote: null,
        currency: toPriceCurrency(item.priceCurrency),
      }));
    },

    async purchase(playerId, itemSlug, quantity = 1) {
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new RangeError(`Quantity must be a positive integer, got ${quantity}`);
      }
      return db.transaction(async (tx) => {
        const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
        if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        if (!item.purchasable || item.buyPrice == null) {
          throw new ItemNotPurchasableError(itemSlug);
        }

        const unitPrice = item.buyPrice;
        const totalPrice = unitPrice * quantity;
        const priceCurrency = toPriceCurrency(item.priceCurrency);

        // Lock the currency row first — it serializes concurrent purchases by
        // this player, so the capacity check below can't race either.
        await currency.lockCurrencies(tx, playerId);

        // The soft capacity cap covers capture items only; consumables are
        // limited by their price, not by charm capacity.
        if (item.category === 'capture') {
          const owned = await inventory.countCaptureItems(tx, playerId);
          if (owned + quantity > captureCapacity) {
            throw new InventoryCapacityError(captureCapacity);
          }
        }

        // Conditional deduct of the *item's own* currency. Insufficient funds
        // throw (InsufficientFundsError / InsufficientEssenceError) with the
        // transaction rolled back, so nothing is ever partially granted.
        const balance =
          priceCurrency === 'essence'
            ? await currency.spendEssence(tx, playerId, totalPrice)
            : await currency.spendWaifubux(tx, playerId, totalPrice);
        const balanceAfter =
          priceCurrency === 'essence' ? balance.essence : balance.waifubux;
        const ownedAfter = await inventory.addItem(tx, playerId, item.id, quantity);

        await tx.insert(shopTransactions).values({
          playerId,
          itemId: item.id,
          quantity,
          unitPrice,
          totalPrice,
          currency: priceCurrency,
          balanceAfter,
        });

        return {
          item,
          quantity,
          unitPrice,
          totalPrice,
          currency: priceCurrency,
          balanceAfter,
          ownedAfter,
        };
      });
    },
  };
}
