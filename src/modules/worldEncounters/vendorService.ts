/**
 * World-encounter vendor — the minimal abstraction that makes the Wandering
 * Merchant work today and lets richer future vendors (randomised inventories,
 * region-scoped stock, unusual currencies) grow on top without a schema
 * change.
 *
 * A vendor has two shapes:
 *
 *   * A **definition** ({@link worldEncounterVendors}) authored by content:
 *     stable `vendorKey`, a display name, and a `stockTemplateJson`
 *     describing what a shopper *may* find in an instance.
 *   * An **instance** ({@link worldEncounterVendorInstances}) bound to one
 *     `active_world_encounters` row: the frozen stock the player actually
 *     sees, mutated as they buy.
 *
 * Every purchase runs in one transaction:
 *
 *   1. `SELECT … FOR UPDATE` on the instance row — serialises concurrent
 *      buys and a double-click on the same button.
 *   2. Validate the requested slug is in-stock and the player can afford it,
 *      re-reading both from the locked row and from the player's currency
 *      row that {@link CurrencyService} locks internally.
 *   3. Decrement stock, spend currency, add item — all under the same tx.
 *   4. Return the applied snapshot.
 *
 * The transaction is opened by the caller (Discord button handler / API
 * route), so vendor purchases can compose with encounter resolution when we
 * later fold "buy inside a choice" into the effect executor.
 */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client';
import {
  activeWorldEncounters,
  items,
  worldEncounterVendorInstances,
  worldEncounterVendors,
  type WorldEncounterVendorInstanceRow,
  type WorldEncounterVendorRow,
} from '../../db/schema';
import type { CurrencyService } from '../currency/currencyService';
import type { InventoryService } from '../inventory/inventoryService';
import { AppError } from '../../shared/errors';

/**
 * One purchasable line as it appears in the authored template and in a
 * generated instance. `remaining` starts equal to `quantity` on
 * instantiation; a template omits it.
 */
export const VendorStockEntrySchema = z.object({
  itemSlug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'itemSlug must be lowercase snake_case'),
  quantity: z.number().int().positive().max(999),
  price: z.number().int().positive().max(1_000_000),
  currency: z.enum(['waifubux', 'essence']),
});
export type VendorStockEntry = z.infer<typeof VendorStockEntrySchema>;

export const VendorStockInstanceEntrySchema = VendorStockEntrySchema.extend({
  remaining: z.number().int().nonnegative(),
});
export type VendorStockInstanceEntry = z.infer<typeof VendorStockInstanceEntrySchema>;

export const VendorStockTemplateSchema = z.array(VendorStockEntrySchema).max(20);
export type VendorStockTemplate = z.infer<typeof VendorStockTemplateSchema>;

export const VendorStockInstanceSchema = z.array(VendorStockInstanceEntrySchema).max(20);
export type VendorStockInstance = z.infer<typeof VendorStockInstanceSchema>;

/* ─────────────────────── Errors ─────────────────────── */

export class VendorNotFoundError extends AppError {
  constructor(vendorKey: string) {
    super(
      'VENDOR_NOT_FOUND',
      `Vendor "${vendorKey}" is not defined.`,
      'This merchant is not available.',
    );
  }
}

export class VendorInstanceNotFoundError extends AppError {
  constructor() {
    super(
      'VENDOR_INSTANCE_NOT_FOUND',
      'No open vendor for this encounter.',
      'This merchant has already packed up.',
    );
  }
}

export class VendorStockUnavailableError extends AppError {
  constructor(slug: string) {
    super(
      'VENDOR_STOCK_UNAVAILABLE',
      `Item "${slug}" is not available at this vendor.`,
      'That item is not stocked here.',
    );
  }
}

export class VendorOutOfStockError extends AppError {
  constructor(slug: string) {
    super(
      'VENDOR_OUT_OF_STOCK',
      `Item "${slug}" is sold out at this vendor.`,
      'Sold out — check back another time.',
    );
  }
}

/* ─────────────────────── Service ─────────────────────── */

export interface VendorInstance {
  id: number;
  activeEncounterId: number;
  vendorKey: string;
  name: string;
  description: string;
  stock: VendorStockInstance;
  closed: boolean;
}

export interface VendorPurchaseResult {
  itemSlug: string;
  quantity: number;
  price: number;
  currency: 'waifubux' | 'essence';
  remaining: number;
  balanceAfter: number;
}

export interface WorldEncounterVendorService {
  /** Look up (or 404) a vendor by its authored key. Definition only, no stock. */
  getDefinition(vendorKey: string): Promise<WorldEncounterVendorRow | null>;
  /** Create or fetch the vendor instance for one active encounter. Idempotent. */
  openForEncounter(
    tx: DbOrTx,
    activeEncounterId: number,
    vendorKey: string,
  ): Promise<VendorInstance>;
  /** Cached read — never mutates. Used by Discord repaint and admin preview. */
  getForEncounter(activeEncounterId: number): Promise<VendorInstance | null>;
  /**
   * Buy one line. Runs as a single transaction: the caller may leave the tx
   * off to let the service open its own, or pass one it already holds.
   */
  purchase(
    playerId: number,
    activeEncounterId: number,
    itemSlug: string,
  ): Promise<VendorPurchaseResult>;
  /** Mark the instance closed — a cosmetic flag; nothing enforces it yet. */
  close(tx: DbOrTx, activeEncounterId: number): Promise<void>;
}

export interface WorldEncounterVendorServiceDeps {
  db: Db;
  currency: CurrencyService;
  inventory: InventoryService;
}

/**
 * Template → concrete instance. Today: a copy with `remaining = quantity`.
 * Randomisation and region-scoped stock plug in here — call sites do not
 * care whether the vendor is deterministic or seeded.
 */
export function instantiateStock(template: VendorStockTemplate): VendorStockInstance {
  return template.map((entry) => ({ ...entry, remaining: entry.quantity }));
}

function parseTemplate(raw: unknown): VendorStockTemplate {
  const parsed = VendorStockTemplateSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function parseInstance(raw: unknown): VendorStockInstance {
  const parsed = VendorStockInstanceSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function createWorldEncounterVendorService(
  deps: WorldEncounterVendorServiceDeps,
): WorldEncounterVendorService {
  async function getDefinition(vendorKey: string): Promise<WorldEncounterVendorRow | null> {
    const [row] = await deps.db
      .select()
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, vendorKey));
    return row ?? null;
  }

  function toVendorInstance(
    def: WorldEncounterVendorRow,
    row: WorldEncounterVendorInstanceRow,
  ): VendorInstance {
    return {
      id: row.id,
      activeEncounterId: row.activeEncounterId,
      vendorKey: row.vendorKey,
      name: def.name,
      description: def.description,
      stock: parseInstance(row.stockJson),
      closed: row.closedAt != null,
    };
  }

  async function openForEncounter(
    tx: DbOrTx,
    activeEncounterId: number,
    vendorKey: string,
  ): Promise<VendorInstance> {
    const [def] = await tx
      .select()
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, vendorKey));
    if (!def) throw new VendorNotFoundError(vendorKey);

    // Unique index makes this idempotent — a second open picks up the same row.
    const [existing] = await tx
      .select()
      .from(worldEncounterVendorInstances)
      .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId));
    if (existing) return toVendorInstance(def, existing);

    const template = parseTemplate(def.stockTemplateJson);
    const stock = instantiateStock(template);
    const [inserted] = await tx
      .insert(worldEncounterVendorInstances)
      .values({
        activeEncounterId,
        vendorKey,
        stockJson: stock as unknown as Record<string, unknown>[],
      })
      .returning();
    if (!inserted) throw new Error('openForEncounter: no row returned');
    return toVendorInstance(def, inserted);
  }

  async function getForEncounter(activeEncounterId: number): Promise<VendorInstance | null> {
    const [row] = await deps.db
      .select()
      .from(worldEncounterVendorInstances)
      .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId));
    if (!row) return null;
    const def = await getDefinition(row.vendorKey);
    if (!def) return null;
    return toVendorInstance(def, row);
  }

  async function purchase(
    playerId: number,
    activeEncounterId: number,
    itemSlug: string,
  ): Promise<VendorPurchaseResult> {
    return deps.db.transaction(async (tx) => {
      const [instanceRow] = await tx
        .select()
        .from(worldEncounterVendorInstances)
        .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId))
        .for('update');
      if (!instanceRow) throw new VendorInstanceNotFoundError();

      const [active] = await tx
        .select({
          playerId: activeWorldEncounters.playerId,
          status: activeWorldEncounters.status,
        })
        .from(activeWorldEncounters)
        .where(eq(activeWorldEncounters.id, activeEncounterId));
      if (!active) throw new VendorInstanceNotFoundError();
      if (active.playerId !== playerId) throw new VendorInstanceNotFoundError();
      // Vendor stays open even after the parent encounter resolves — the
      // player is free to browse a Wandering Merchant after picking her.

      const stock = parseInstance(instanceRow.stockJson);
      const entry = stock.find((s) => s.itemSlug === itemSlug);
      if (!entry) throw new VendorStockUnavailableError(itemSlug);
      if (entry.remaining <= 0) throw new VendorOutOfStockError(itemSlug);

      const [item] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.slug, itemSlug), eq(items.enabled, true)));
      if (!item) throw new VendorStockUnavailableError(itemSlug);

      // Spend the currency — the currency service handles insufficient funds.
      const balanceAfter =
        entry.currency === 'waifubux'
          ? (await deps.currency.spendWaifubux(tx, playerId, entry.price)).waifubux
          : (await deps.currency.spendEssence(tx, playerId, entry.price)).essence;

      await deps.inventory.addItem(tx, playerId, item.id, 1);

      const newStock = stock.map((s) =>
        s.itemSlug === itemSlug ? { ...s, remaining: s.remaining - 1 } : s,
      );
      await tx
        .update(worldEncounterVendorInstances)
        .set({ stockJson: newStock as unknown as Record<string, unknown>[] })
        .where(eq(worldEncounterVendorInstances.id, instanceRow.id));

      return {
        itemSlug,
        quantity: 1,
        price: entry.price,
        currency: entry.currency,
        remaining: entry.remaining - 1,
        balanceAfter,
      };
    });
  }

  async function close(tx: DbOrTx, activeEncounterId: number): Promise<void> {
    await tx
      .update(worldEncounterVendorInstances)
      .set({ closedAt: sql`now()` })
      .where(eq(worldEncounterVendorInstances.activeEncounterId, activeEncounterId));
  }

  return { getDefinition, openForEncounter, getForEncounter, purchase, close };
}

/**
 * Seed the shipped vendor catalogue. Idempotent — an existing key is
 * updated in place, matching how {@link seedWorldEncounters} works.
 */
export async function seedWorldEncounterVendors(db: Db): Promise<void> {
  const catalogue: Array<
    Pick<WorldEncounterVendorRow, 'vendorKey' | 'name' | 'description'> & {
      stock: VendorStockTemplate;
    }
  > = [
    {
      vendorKey: 'wandering_merchant',
      name: 'The Wandering Merchant',
      description:
        'A hooded merchant offering rare curiosities to travellers she meets on the road.',
      stock: [
        { itemSlug: 'basic_charm', quantity: 3, price: 150, currency: 'waifubux' },
        { itemSlug: 'silk_charm', quantity: 1, price: 900, currency: 'waifubux' },
      ],
    },
  ];

  for (const entry of catalogue) {
    const [existing] = await db
      .select({ id: worldEncounterVendors.id })
      .from(worldEncounterVendors)
      .where(eq(worldEncounterVendors.vendorKey, entry.vendorKey));

    if (existing) {
      await db
        .update(worldEncounterVendors)
        .set({
          name: entry.name,
          description: entry.description,
          stockTemplateJson: entry.stock as unknown as Record<string, unknown>[],
          updatedAt: sql`now()`,
        })
        .where(eq(worldEncounterVendors.id, existing.id));
    } else {
      await db.insert(worldEncounterVendors).values({
        vendorKey: entry.vendorKey,
        name: entry.name,
        description: entry.description,
        stockTemplateJson: entry.stock as unknown as Record<string, unknown>[],
      });
    }
  }
}
