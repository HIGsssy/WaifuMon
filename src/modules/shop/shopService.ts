import { and, arrayContains, asc, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  items,
  playerInventory,
  players,
  shopTransactions,
  SHOP_ITEM_CATEGORIES,
  type ItemRow,
  type PriceCurrency,
} from '../../db/schema';
import {
  CharmRecipeNotFoundError,
  InsufficientCharmsError,
  InventoryCapacityError,
  ItemNotFoundError,
  ItemNotPurchasableError,
  ItemNotSellableError,
  ItemNotSoldHereError,
} from '../../shared/errors';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';

/**
 * Categories the shop lists. `capture` is the launch catalog (charms);
 * `consumable` covers the utility items (Energy Drink, Microdose). Material
 * and cosmetic items stay out of the shop entirely.
 */
const SHOP_CATEGORIES = SHOP_ITEM_CATEGORIES;

/**
 * The charm-exchange ladder. This is the *only* place conversions are defined:
 * a fixed, explicit, upward-one-tier-at-a-time list. Never inferred from price,
 * rarity, or item order. Each recipe is a hard 10:1 trade with no currency or
 * essence cost, and Prismatic is the end of the ladder (never an input).
 */
export interface CharmExchangeRecipe {
  /** Stable id used in custom ids and lookups. */
  id: string;
  inputSlug: string;
  inputQuantity: number;
  outputSlug: string;
  outputQuantity: number;
  enabled: boolean;
}

export const CHARM_EXCHANGE_RECIPES: readonly CharmExchangeRecipe[] = [
  {
    id: 'basic_silk',
    inputSlug: 'basic_charm',
    inputQuantity: 10,
    outputSlug: 'silk_charm',
    outputQuantity: 1,
    enabled: true,
  },
  {
    id: 'silk_velvet',
    inputSlug: 'silk_charm',
    inputQuantity: 10,
    outputSlug: 'velvet_charm',
    outputQuantity: 1,
    enabled: true,
  },
  {
    id: 'velvet_prismatic',
    inputSlug: 'velvet_charm',
    inputQuantity: 10,
    outputSlug: 'prismatic_charm',
    outputQuantity: 1,
    enabled: true,
  },
] as const;

/** One conversion mode: a single 10:1 trade, or as many as the input allows. */
export type CharmConversionMode = 'one' | 'max';

/** A rendered exchange row: the recipe plus the player's live standing on it. */
export interface CharmExchangeRow {
  recipe: CharmExchangeRecipe;
  inputItem: ItemRow;
  outputItem: ItemRow;
  /** How many of the input charm the player currently owns. */
  ownedInput: number;
  /** floor(ownedInput / inputQuantity) — how many conversions are possible now. */
  conversionsPossible: number;
}

export interface CharmConversionResult {
  recipe: CharmExchangeRecipe;
  inputItem: ItemRow;
  outputItem: ItemRow;
  /** Number of 10:1 conversions actually applied. */
  conversions: number;
  inputConsumed: number;
  outputGranted: number;
  ownedInputAfter: number;
  ownedOutputAfter: number;
}


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

/** One inventory stack the player could sell right now. */
export interface SellableEntry {
  item: ItemRow;
  /** How many the player currently holds. Always > 0 — empty stacks are filtered out. */
  quantity: number;
  /** `item.sellValue`, narrowed to a number because the query guarantees it is non-null. */
  unitValue: number;
  /** What the whole stack is worth — rendered as the "sell all" figure. */
  stackValue: number;
}

export interface SellResult {
  item: ItemRow;
  quantity: number;
  unitValue: number;
  totalValue: number;
  /** WaifuBux balance after the credit. */
  balanceAfter: number;
  ownedAfter: number;
}

export interface ShopService {
  /**
   * The union catalog: every capture/consumable item that is `enabled`, priced,
   * and sold in at least one region (`shopRegions` non-empty). There is no
   * global shop, so this is not "the shop" — it is the region-independent list
   * of everything buyable *somewhere*, used by the read-only Platform API.
   * Items that exist only as drops or rewards (affection gifts, the Mythic
   * Contract) name no region and never appear.
   */
  getCatalog(): Promise<ShopCatalogEntry[]>;
  /**
   * The catalog for one region's shop: the enabled, priced items whose
   * `shopRegions` include `regionId`. This is the *only* notion of a shop —
   * every purchase screen is a region's shelf. Empty for a region no item
   * names, and the Locations screen hides the shop entry when it is.
   */
  getRegionalCatalog(regionId: string): Promise<ShopCatalogEntry[]>;
  /**
   * Single transaction: verify enabled + priced + sold in the player's current
   * region → lock currency row → capacity check (reject before charging) →
   * conditional deduct of the item's own currency → upsert inventory → audit
   * row. Nothing is ever partially applied.
   */
  purchase(playerId: number, itemSlug: string, quantity?: number): Promise<PurchaseResult>;
  /**
   * Every inventory stack the player could sell right now: owned, enabled, and
   * carrying a sell value. Read-only.
   *
   * Sellability is *not* the mirror of `getRegionalCatalog`. Buying is
   * region-gated stock; selling is a global property of the item row, so this
   * takes no region and a sale is refused nowhere. When regional price
   * modifiers exist they become a content-side multiplier on `unitValue`, not
   * a new gate here.
   */
  getSellableInventory(playerId: number): Promise<SellableEntry[]>;
  /**
   * Sell part or all of one stack in a single transaction: resolve the item →
   * lock the currency row → conditional inventory decrement → credit WaifuBux
   * → audit row. A failed validation mutates nothing, and a double-clicked
   * button cannot sell the same stack twice.
   */
  sellItem(playerId: number, itemSlug: string, quantity?: number): Promise<SellResult>;
  /**
   * The charm-exchange ladder for a player: each enabled recipe paired with the
   * live owned quantity of its input charm and how many conversions are
   * currently possible. Read-only — nothing is mutated.
   */
  getCharmExchange(playerId: number): Promise<CharmExchangeRow[]>;
  /**
   * Convert charms one tier up in a single transaction. `mode: 'one'` applies a
   * single 10:1 trade; `mode: 'max'` applies floor(owned / 10) trades and
   * leaves the remainder. Consume and grant are atomic — a concurrent or
   * double-clicked call can never duplicate the output or lose the input, and a
   * failed validation mutates nothing.
   */
  convertCharms(
    playerId: number,
    recipeId: string,
    mode: CharmConversionMode,
  ): Promise<CharmConversionResult>;
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
      // The union of every region's shelf: enabled, priced, and sold somewhere.
      // Sellability is filtered in the query, not the presentation layer, so
      // every consumer sees the same rule. `cardinality > 0` is the "sold
      // somewhere" test — an item that names no region is a drop/reward and
      // never appears.
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            inArray(items.category, [...SHOP_CATEGORIES]),
            eq(items.enabled, true),
            isNotNull(items.buyPrice),
            sql`cardinality(${items.shopRegions}) > 0`,
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

    async getRegionalCatalog(regionId) {
      const rows = await db
        .select()
        .from(items)
        .where(
          and(
            inArray(items.category, [...SHOP_CATEGORIES]),
            eq(items.enabled, true),
            isNotNull(items.buyPrice),
            arrayContains(items.shopRegions, [regionId]),
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
        // Never for sale: no price, or named by no region's shop at all (a
        // drop/reward). Both are "this is never buyable", distinct from the
        // region check below, which is "not buyable *here*".
        if (item.buyPrice == null || item.shopRegions.length === 0) {
          throw new ItemNotPurchasableError(itemSlug);
        }

        // Stock is sold only where the item names. Hiding a button is not a
        // rule: a `shop:buy` custom id is a string that outlives the screen
        // that painted it, and the Platform API reaches this method with no
        // screen at all — so the region gate is enforced here, where the
        // currency is spent. The regions live on the item row we already have,
        // so this costs no extra query beyond the player's current region.
        const [player] = await tx
          .select({ currentRegion: players.currentRegion })
          .from(players)
          .where(eq(players.id, playerId));
        const here = player?.currentRegion ?? null;
        if (here == null || !item.shopRegions.includes(here)) {
          throw new ItemNotSoldHereError(itemSlug, item.name, item.shopRegions);
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
          // Written explicitly rather than leaning on the column default, so
          // both directions of the ledger are greppable from their call sites.
          kind: 'purchase',
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

    async getSellableInventory(playerId) {
      // Every part of the eligibility rule lives in this WHERE clause, for the
      // same reason `getCatalog` puts the buy rule in its own: a rule split
      // between the query and the presentation layer is a rule two callers
      // will disagree about. The sell screen, the API endpoint and `sellItem`
      // all answer "is this sellable?" the same way because they all ask here.
      //
      // `sell_value IS NOT NULL` is the *whole* test — `items_sell_value_check`
      // forbids 0, so there is no second spelling of "not sellable" to catch.
      //
      // Key items need no extra clause. A key item's `sell_value` can only be
      // non-null if content set `explicitlySellable: true` alongside it, which
      // the item schema enforces at load; the seeder is the only writer of this
      // column, so by the time a row is here the author has already said yes
      // twice.
      const rows = await db
        .select({ item: items, quantity: playerInventory.quantity })
        .from(playerInventory)
        .innerJoin(items, eq(items.id, playerInventory.itemId))
        .where(
          and(
            eq(playerInventory.playerId, playerId),
            gt(playerInventory.quantity, 0),
            eq(items.enabled, true),
            isNotNull(items.sellValue),
          ),
        )
        // Most valuable stack first: the sell screen is a "convert clutter to
        // money" screen, and the thing worth the most money is the thing the
        // player opened it for.
        .orderBy(desc(items.sellValue), asc(items.slug));

      return rows.map(({ item, quantity }) => {
        const unitValue = item.sellValue ?? 0;
        return { item, quantity, unitValue, stackValue: unitValue * quantity };
      });
    },

    async sellItem(playerId, itemSlug, quantity = 1) {
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new RangeError(`Quantity must be a positive integer, got ${quantity}`);
      }
      return db.transaction(async (tx) => {
        const [item] = await tx.select().from(items).where(eq(items.slug, itemSlug));
        if (!item || !item.enabled) throw new ItemNotFoundError(itemSlug);
        // Re-checked here and not merely on the screen that painted the button:
        // a `shop|sellqty` custom id is a string that outlives its message, and
        // the Platform API will reach this method with no screen at all.
        if (item.sellValue == null) throw new ItemNotSellableError(itemSlug, item.name);

        const unitValue = item.sellValue;
        const totalValue = unitValue * quantity;

        // Lock the currency row first, exactly as `purchase` does, so two
        // concurrent sells by this player serialize rather than interleaving
        // between the decrement and the credit.
        await currency.lockCurrencies(tx, playerId);

        // Consume *before* granting. `consumeItem` is a conditional decrement
        // (WHERE quantity >= n) that throws `InsufficientItemsError` on a miss,
        // so "does the player still own these?" is a property of the statement
        // rather than a separate read that something could race between. The
        // loser of a double-click throws here, having paid out nothing.
        const ownedAfter = await inventory.consumeItem(tx, playerId, item.id, quantity);
        // Selling always pays WaifuBux. `price_currency` describes what an item
        // costs to *buy* and has no bearing on the counter — an Essence-priced
        // item is not an Essence printer.
        const balance = await currency.grantWaifubux(tx, playerId, totalValue);
        const balanceAfter = balance.waifubux;

        await tx.insert(shopTransactions).values({
          playerId,
          itemId: item.id,
          kind: 'sale',
          quantity,
          unitPrice: unitValue,
          totalPrice: totalValue,
          currency: 'waifubux',
          balanceAfter,
        });

        return { item, quantity, unitValue, totalValue, balanceAfter, ownedAfter };
      });
    },

    async getCharmExchange(playerId) {
      const recipes = CHARM_EXCHANGE_RECIPES.filter((r) => r.enabled);
      const slugs = [
        ...new Set(recipes.flatMap((r) => [r.inputSlug, r.outputSlug])),
      ];
      const rows = await db.select().from(items).where(inArray(items.slug, slugs));
      const itemBySlug = new Map(rows.map((row) => [row.slug, row]));

      const owned = new Map<number, number>();
      const itemIds = rows.map((row) => row.id);
      if (itemIds.length > 0) {
        const invRows = await db
          .select({ itemId: playerInventory.itemId, quantity: playerInventory.quantity })
          .from(playerInventory)
          .where(
            and(
              eq(playerInventory.playerId, playerId),
              inArray(playerInventory.itemId, itemIds),
            ),
          );
        for (const row of invRows) owned.set(row.itemId, row.quantity);
      }

      const result: CharmExchangeRow[] = [];
      for (const recipe of recipes) {
        const inputItem = itemBySlug.get(recipe.inputSlug);
        const outputItem = itemBySlug.get(recipe.outputSlug);
        // A recipe whose items were disabled/removed from content simply drops
        // out of the ladder rather than rendering a broken row.
        if (!inputItem || !inputItem.enabled || !outputItem || !outputItem.enabled) continue;
        const ownedInput = owned.get(inputItem.id) ?? 0;
        result.push({
          recipe,
          inputItem,
          outputItem,
          ownedInput,
          conversionsPossible: Math.floor(ownedInput / recipe.inputQuantity),
        });
      }
      return result;
    },

    async convertCharms(playerId, recipeId, mode) {
      const recipe = CHARM_EXCHANGE_RECIPES.find((r) => r.id === recipeId && r.enabled);
      if (!recipe) throw new CharmRecipeNotFoundError(recipeId);

      return db.transaction(async (tx) => {
        const [inputItem] = await tx
          .select()
          .from(items)
          .where(eq(items.slug, recipe.inputSlug));
        if (!inputItem || !inputItem.enabled) throw new ItemNotFoundError(recipe.inputSlug);
        const [outputItem] = await tx
          .select()
          .from(items)
          .where(eq(items.slug, recipe.outputSlug));
        if (!outputItem || !outputItem.enabled) throw new ItemNotFoundError(recipe.outputSlug);

        // Lock the input inventory row for the duration of the transaction so
        // concurrent conversions of the same charm serialize — the Max count is
        // computed from a value nobody else can change underneath us.
        const [invRow] = await tx
          .select({ quantity: playerInventory.quantity })
          .from(playerInventory)
          .where(
            and(
              eq(playerInventory.playerId, playerId),
              eq(playerInventory.itemId, inputItem.id),
            ),
          )
          .for('update');
        const ownedInput = invRow?.quantity ?? 0;

        const conversions =
          mode === 'max' ? Math.floor(ownedInput / recipe.inputQuantity) : 1;
        if (conversions < 1 || ownedInput < recipe.inputQuantity) {
          const needed = recipe.inputQuantity - ownedInput;
          throw new InsufficientCharmsError(inputItem.name, Math.max(needed, 1));
        }

        const inputConsumed = conversions * recipe.inputQuantity;
        const outputGranted = conversions * recipe.outputQuantity;

        // Conditional decrement (WHERE quantity >= n): even if the row lock were
        // somehow bypassed, this can never overdraw, so the input is never lost.
        const ownedInputAfter = await inventory.consumeItem(
          tx,
          playerId,
          inputItem.id,
          inputConsumed,
        );
        const ownedOutputAfter = await inventory.addItem(
          tx,
          playerId,
          outputItem.id,
          outputGranted,
        );

        return {
          recipe,
          inputItem,
          outputItem,
          conversions,
          inputConsumed,
          outputGranted,
          ownedInputAfter,
          ownedOutputAfter,
        };
      });
    },
  };
}
