import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { items, shopTransactions, type ItemRow } from '../../db/schema';
import {
  InventoryCapacityError,
  ItemNotFoundError,
  ItemNotPurchasableError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';

export interface ShopCatalogEntry {
  item: ItemRow;
  /** True when the item can actually be bought right now. */
  available: boolean;
  /** Display label for unavailable rows ("Unavailable", "Not for sale"). */
  availabilityNote: string | null;
}

export interface PurchaseResult {
  item: ItemRow;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  balanceAfter: number;
  ownedAfter: number;
}

export interface ShopService {
  /**
   * The launch catalog: every enabled capture item. Prismatic is listed but
   * disabled (`purchasable=false`); Mythic Contract is listed greyed-out as
   * "Not for sale" (guaranteed capture, never sold).
   */
  getCatalog(): Promise<ShopCatalogEntry[]>;
  /**
   * Single transaction: verify enabled+purchasable → lock currency row →
   * capacity check (reject before charging) → conditional deduct → upsert
   * inventory → audit row. Nothing is ever partially applied.
   */
  purchase(playerId: number, itemSlug: string, quantity?: number): Promise<PurchaseResult>;
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
      const rows = await db
        .select()
        .from(items)
        .where(eq(items.category, 'capture'))
        .orderBy(sql`${items.buyPrice} asc nulls last`, asc(items.slug));
      return rows
        .filter((item) => item.enabled)
        .map((item) => {
          const available = item.purchasable && item.buyPrice != null;
          let availabilityNote: string | null = null;
          if (!available) {
            availabilityNote = item.isGuaranteedCapture ? 'Not for sale' : 'Unavailable';
          }
          return { item, available, availabilityNote };
        });
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

        // Lock the currency row first — it serializes concurrent purchases by
        // this player, so the capacity check below can't race either.
        await currency.lockCurrencies(tx, playerId);

        if (item.category === 'capture') {
          const owned = await inventory.countCaptureItems(tx, playerId);
          if (owned + quantity > captureCapacity) {
            throw new InventoryCapacityError(captureCapacity);
          }
        }

        const balance = await currency.spendWaifubux(tx, playerId, totalPrice);
        const ownedAfter = await inventory.addItem(tx, playerId, item.id, quantity);

        await tx.insert(shopTransactions).values({
          playerId,
          itemId: item.id,
          quantity,
          unitPrice,
          totalPrice,
          balanceAfter: balance.waifubux,
        });

        return {
          item,
          quantity,
          unitPrice,
          totalPrice,
          balanceAfter: balance.waifubux,
          ownedAfter,
        };
      });
    },
  };
}
